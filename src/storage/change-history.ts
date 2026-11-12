import { withFileLock } from "./file-lock.js";
import { ArchiveCache } from "./archive-cache.js";
import type { Snapshot } from "../snapshots/types.js";
import { errorDetails } from "../runtime/errors.js";
/**
 * Локальная хронология реально наблюдённых состояний между коммитами.
 * Каждый change содержит точный самостоятельный снимок; возврат к прежнему коду
 * создаёт новую точку. Cursor служит только дедупликации наблюдений, а не истории.
 */
import { link, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { stringify } from "yaml";
import { digest } from "../serialization/digest.js";
import { parseReportYaml } from "../serialization/yaml.js";
import { captureGitHead } from "../snapshots/capture.js";
import { snapshotDigest } from "../snapshots/identity.js";

const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ID = /^change-[a-f0-9]{64}$/;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const chronological = (a: Pick<ChangeRecord, "capturedAt" | "sequence">, b: Pick<ChangeRecord, "capturedAt" | "sequence">) => a.capturedAt.localeCompare(b.capturedAt) || a.sequence - b.sequence;

/** Хранилище событий одного проекта; сырые записи не нужны переносимому work. */
type PageOptions = { beforeSequence?: number | null; limit?: number | null };
export class ChangeHistory {
  readonly #records = new ArchiveCache<ChangeRecord>();
  readonly #cursors = new ArchiveCache<unknown>();
  readonly snapshotStore: import("./snapshot-store.js").SnapshotStore;
  readonly directory: string;
  constructor(snapshotStore: import("./snapshot-store.js").SnapshotStore) {
    this.snapshotStore = snapshotStore;
    this.directory = path.join(snapshotStore.directory, "snapshots", "changes");
  }

  /** Возвращает точные снимки, сохраняя старую привязку к коммиту после смены HEAD. */
  async list(headRevision?: string | null, { beforeSequence = null, limit = null }: PageOptions = {}) {
    this.#revision(headRevision, true);
    if (beforeSequence !== null && (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1)) throw new Error("Invalid change history cursor");
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error("Invalid change history page limit");
    await this.snapshotStore.open();
    await this.snapshotStore.assertLocation(this.directory);
    const state = await this.#read();
    return this.#history(state, headRevision, { beforeSequence, limit });
  }

  /** Формирует страницу из уже проверенного состояния, не перечитывая снимки истории. */
  #history(state: ChangeState, headRevision?: string | null, { beforeSequence = null, limit = null }: PageOptions = {}) {
    const records = state.changes.filter((record) => (headRevision === undefined || record.baseRevision === headRevision) &&
      (beforeSequence === null || record.sequence < beforeSequence));
    const newest = records.sort((a, b) => b.sequence - a.sequence);
    const selected = limit === null ? newest : newest.slice(0, limit);
    const hasMore = selected.length < newest.length;
    return { changes: structuredClone(selected.sort(chronological)), hasMore,
      nextBeforeSequence: hasMore ? Math.min(...selected.map((record) => record.sequence)) : null,
      diagnostics: state.diagnostics };
  }

  /** Селектор допускает только созданный приложением id, а не файловый путь. */
  async get(id: string) {
    if (!ID.test(id)) throw new Error("Invalid change history id");
    await this.snapshotStore.open();
    const file = path.join(this.directory, id + ".yaml");
    await this.snapshotStore.assertLocation(file);
    try { return structuredClone(await this.#readRecord(file)); }
    catch (errorCause) { const error = errorDetails(errorCause); if (error.code === "ENOENT") return null; throw error; }
  }

  /**
   * Наблюдает рабочие исходники независимо от выбранной исторической точки UI.
   * Чистый первый/new HEAD не создаёт change; dirty→clean при прежнем HEAD создаёт.
   * includeHistory возвращает историю выбранного HEAD из того же чтения под lock:
   * вызывающему не требуется сразу после наблюдения заново читать все снимки.
   */
  async observe(current: Snapshot, head: Snapshot | string | null = null, { includeHistory = false } = {}) {
    return this.#locked(async () => {
      this.#snapshot(current);
      let headSnapshot: Snapshot | null = typeof head === "string" ? null : head;
      if (typeof head === "string") {
        this.#revision(head);
        headSnapshot = await captureGitHead(this.snapshotStore.root, { revision: head, snapshotRoot: this.snapshotStore.snapshotRoot });
      }
      if (headSnapshot) this.#snapshot(headSnapshot);
      const baseRevision = headSnapshot?.revision ?? null;
      this.#revision(baseRevision);
      const state = await this.#read();
      this.#writable(state);
      const observed = (record: ChangeRecord | null, created: boolean) => ({ record: structuredClone(record), created,
        ...(includeHistory ? { history: this.#history(state, baseRevision) } : {}) });
      let cursor = await this.#cursor(state);
      const same = cursor?.digest === current.digest && cursor?.headRevision === baseRevision;
      if (same) return observed(state.changes.find((record) => record.id === cursor!.recordId) ?? null, false);
      const clean = Boolean(headSnapshot && current.digest === headSnapshot.digest);
      if (clean && (!cursor || cursor.headRevision !== baseRevision)) {
        await this.#writeCursor({ schema_version: 1, headRevision: baseRevision, digest: current.digest,
          recordId: null, sequence: Math.max(0, ...state.changes.map((record) => record.sequence)), capturedAt: current.capturedAt });
        return observed(null, false);
      }
      const record = this.#record(current, baseRevision, Math.max(0, ...state.changes.map((entry) => entry.sequence)) + 1,
        "change-" + digest({ nonce: randomUUID() }).slice(7));
      await this.#save(record);
      await this.#writeCursor(this.#recordCursor(record));
      state.changes.push(record);
      return observed(record, true);
    });
  }

  /** Импорт использует подлинные время/содержимое и явно известный commit anchor. */
  async importSnapshots(snapshots: Snapshot[], { baseRevision = null, source = "imported-snapshots" }: { baseRevision?: string | null; source?: string } = {}) {
    this.#revision(baseRevision);
    if (!Array.isArray(snapshots) || typeof source !== "string" || !source) throw new Error("Invalid change history import");
    return this.#locked(async () => {
      const state = await this.#read();
      this.#writable(state);
      const cursor = await this.#cursor(state);
      for (const snapshot of snapshots) this.#snapshot(snapshot);
      let sequence = Math.max(0, ...state.changes.map((record) => record.sequence));
      const changes: ChangeRecord[] = [];
      let imported = 0;
      for (const snapshot of [...snapshots].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))) {
        this.#snapshot(snapshot);
        const id = "change-" + digest({ source, baseRevision, id: snapshot.id, digest: snapshot.digest, capturedAt: snapshot.capturedAt }).slice(7);
        const existing = state.changes.find((record) => record.id === id);
        if (existing) { changes.push(structuredClone(existing)); continue; }
        const record = this.#record(snapshot, baseRevision, ++sequence, id, { imported: true, source });
        await this.#save(record);
        state.changes.push(record);
        changes.push(record);
        imported++;
      }
      // Поздний импорт W1/W2 не превращает уже наблюдённое W3 обратно в W2.
      const latest = [...changes].sort(chronological).at(-1);
      if (latest && (!cursor || chronological(latest, cursor) > 0)) await this.#writeCursor(this.#recordCursor(latest));
      return { changes, imported, diagnostics: state.diagnostics };
    });
  }

  #revision(value: unknown, allowUndefined = false) {
    if (value === null || (allowUndefined && value === undefined)) return;
    if (typeof value !== "string" || !REVISION.test(value)) throw new Error("Invalid change base revision");
  }

  #snapshot(value: unknown): Snapshot {
    const snapshot = value as Snapshot;
    if (!snapshot || snapshot.schema_version !== 2 || snapshot.root !== this.snapshotStore.snapshotRoot ||
        snapshot.complete !== true || !Array.isArray(snapshot.modules) || !Array.isArray(snapshot.facts) || snapshotDigest(snapshot) !== snapshot.digest ||
        typeof snapshot.id !== "string" || !snapshot.id || typeof snapshot.capturedAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(snapshot.capturedAt) || !Number.isFinite(Date.parse(snapshot.capturedAt))) throw new Error("Invalid or incomplete change snapshot");
    return snapshot;
  }

  #record(snapshot: Snapshot, baseRevision: string | null, sequence: number, id: string, provenance: ChangeRecord["provenance"] = { imported: false }): ChangeRecord {
    const record = { ...clone(snapshot), id, kind: "change", label: "Изменение · " + snapshot.capturedAt,
      originalId: snapshot.id, originalKind: snapshot.kind, baseRevision, sequence, provenance };
    return { ...record, history_digest: digest(record) };
  }

  #validateRecord(value: unknown): ChangeRecord {
    const record = value as ChangeRecord;
    this.#snapshot(record);
    this.#revision(record.baseRevision);
    if (record.kind !== "change" || !ID.test(record.id) || !Number.isSafeInteger(record.sequence) || record.sequence < 1 ||
        typeof record.originalId !== "string" || !record.originalId || typeof record.provenance?.imported !== "boolean") throw new Error("Invalid change history record");
    const { history_digest, ...content } = record;
    if (history_digest !== digest(content)) throw new Error("Change history record digest mismatch");
    return record;
  }

  #recordCursor(record: ChangeRecord) {
    return { schema_version: 1, headRevision: record.baseRevision, digest: record.digest,
      recordId: record.id, sequence: record.sequence, capturedAt: record.capturedAt };
  }

  async #readRecord(file: string) {
    await this.snapshotStore.assertLocation(file);
    return this.#records.read(file, async () => {
      const record = this.#validateRecord(await this.#yaml(file));
      if (path.basename(file) !== record.id + ".yaml") throw new Error("Change history filename mismatch");
      return record;
    });
  }

  /** Проверяет сохранённую историю до записи; повреждение не превращается в пустую историю. */
  async #read() {
    const state: ChangeState = { changes: [], diagnostics: [] };
    let names;
    try {
      const info = await lstat(this.directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid change history directory");
      names = await readdir(this.directory);
    } catch (errorCause) { const error = errorDetails(errorCause); if (error.code === "ENOENT") return state; throw error; }
    const files = names.sort().filter(name => name.startsWith("change-") && name.endsWith(".yaml"));
    this.#records.retain(new Set(files.map(name => path.join(this.directory, name))));
    for (const name of files) {
      try {
        const record = await this.#readRecord(path.join(this.directory, name));
        if (state.changes.some((entry) => entry.sequence === record.sequence)) throw new Error("Duplicate change sequence");
        state.changes.push(record);
      } catch (errorCause) { const error = errorDetails(errorCause); state.diagnostics.push(name + ": " + error.message); }
    }
    return state;
  }

  #writable(state: ChangeState) {
    if (state.diagnostics.length) throw new Error("Change history is damaged; refusing to append: " + state.diagnostics.join("; "));
  }

  /** Восстанавливает cursor после сбоя между готовой записью события и его cursor. */
  async #cursor(state: ChangeState) {
    let cursor: ChangeCursor | null = null;
    try {
      cursor = await this.#readCursor() as ChangeCursor;
      this.#revision(cursor.headRevision);
      if (cursor.schema_version !== 1 || !/^sha256:[a-f0-9]{64}$/.test(cursor.digest) || !Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0 ||
          (cursor.recordId !== null && !ID.test(cursor.recordId)) || typeof cursor.capturedAt !== "string" || !Number.isFinite(Date.parse(cursor.capturedAt))) throw new Error("Invalid change history cursor");
      if (cursor.recordId && !state.changes.some((record) => record.id === cursor!.recordId)) throw new Error("Change cursor refers to a missing record");
      if (cursor.sequence > Math.max(0, ...state.changes.map((record) => record.sequence))) throw new Error("Change cursor refers to missing history");
    } catch (errorCause) { const error = errorDetails(errorCause); if (error.code !== "ENOENT") throw error; }
    const interrupted = state.changes.filter((record) => !record.provenance.imported && record.sequence > (cursor?.sequence ?? 0))
      .sort((a, b) => a.sequence - b.sequence).at(-1);
    if (interrupted) return this.#recordCursor(interrupted);
    if (!cursor && state.changes.length) return this.#recordCursor([...state.changes].sort(chronological).at(-1)!);
    return cursor;
  }

  async #yaml(file: string): Promise<unknown> {
    await this.snapshotStore.assertLocation(file);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Change history file must be an ordinary file");
    return parseReportYaml(await readFile(file, "utf8"));
  }

  async #save(record: ChangeRecord) {
    const file = path.join(this.directory, record.id + ".yaml");
    await this.#atomic(file, stringify(record, { aliasDuplicateObjects: false }), true);
    await this.#readRecord(file);
  }

  async #readCursor() {
    const file = path.join(this.directory, ".cursor.yaml");
    await this.snapshotStore.assertLocation(file);
    return this.#cursors.read(file, () => this.#yaml(file));
  }

  async #writeCursor(cursor: ChangeCursor) {
    await this.#atomic(path.join(this.directory, ".cursor.yaml"), stringify(cursor), false);
    await this.#readCursor();
  }

  /** Immutable событие публикуется hard link; cursor заменяется готовым файлом. */
  async #atomic(file: string, text: string, immutable: boolean) {
    await this.snapshotStore.assertLocation(file);
    const temporary = path.join(this.directory, ".pending-" + randomUUID());
    await writeFile(temporary, text, { flag: "wx" });
    try { if (immutable) await link(temporary, file); else await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
  }

  /** Отдельный lock не блокирует публикацию work; атомарные файлы безопасны для readers. */
  async #locked<T>(action: () => Promise<T>): Promise<T> {
    await this.snapshotStore.open();
    await this.snapshotStore.assertLocation(this.directory);
    await mkdir(this.directory, { recursive: true });
    const directoryInfo = await lstat(this.directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error("Invalid change history directory");
    return withFileLock(this.directory, ".lock", async () => {
      await this.snapshotStore.ensureIdentity();
      return action();
    });
  }
}

export interface ChangeRecord extends Snapshot {
  sequence: number;
  baseRevision: string | null;
  originalId: string;
  originalKind: string;
  provenance: { imported: boolean; source?: string };
  history_digest: string;
}

export interface ChangeCursor {
  schema_version: number;
  headRevision: string | null;
  digest: string;
  recordId: string | null;
  sequence: number;
  capturedAt: string;
}

export interface ChangeState {
  changes: ChangeRecord[];
  diagnostics: string[];
  errors?: string[];
}
