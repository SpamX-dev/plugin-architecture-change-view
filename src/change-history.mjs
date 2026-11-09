/**
 * Локальная хронология реально наблюдённых состояний между коммитами.
 * Каждый change содержит точный самостоятельный снимок; возврат к прежнему коду
 * создаёт новую точку. Cursor служит только дедупликации наблюдений, а не истории.
 */
import { link, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { stringify } from "yaml";
import { digest } from "./formats.mjs";
import { parseReportYaml } from "./report-store.mjs";
import { captureGitHead, snapshotDigest } from "./snapshots.mjs";

const REVISION = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const ID = /^change-[a-f0-9]{64}$/;
const clone = (value) => JSON.parse(JSON.stringify(value));
const chronological = (a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.sequence - b.sequence;

/** Хранилище событий одного проекта; сырые записи не нужны переносимому work. */
export class ChangeHistory {
  constructor(snapshotStore) {
    this.snapshotStore = snapshotStore;
    this.directory = path.join(snapshotStore.directory, "snapshots", "changes");
  }

  /** Возвращает точные снимки, сохраняя старую привязку к коммиту после смены HEAD. */
  async list(headRevision = undefined, { beforeSequence = null, limit = null } = {}) {
    this.#revision(headRevision, true);
    if (beforeSequence !== null && (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1)) throw new Error("Invalid change history cursor");
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) throw new Error("Invalid change history page limit");
    await this.snapshotStore.open();
    await this.snapshotStore.assertLocation(this.directory);
    const state = await this.#read();
    return this.#history(state, headRevision, { beforeSequence, limit });
  }

  /** Формирует страницу из уже проверенного состояния, не перечитывая снимки истории. */
  #history(state, headRevision, { beforeSequence = null, limit = null } = {}) {
    const records = state.changes.filter((record) => (headRevision === undefined || record.baseRevision === headRevision) &&
      (beforeSequence === null || record.sequence < beforeSequence));
    const newest = records.sort((a, b) => b.sequence - a.sequence);
    const selected = limit === null ? newest : newest.slice(0, limit);
    const hasMore = selected.length < newest.length;
    return { changes: selected.sort(chronological), hasMore,
      nextBeforeSequence: hasMore ? Math.min(...selected.map((record) => record.sequence)) : null,
      diagnostics: state.diagnostics };
  }

  /** Селектор допускает только созданный приложением id, а не файловый путь. */
  async get(id) {
    if (!ID.test(id)) throw new Error("Invalid change history id");
    await this.snapshotStore.open();
    const file = path.join(this.directory, id + ".yaml");
    await this.snapshotStore.assertLocation(file);
    try { return this.#validateRecord(await this.#yaml(file)); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }

  /**
   * Наблюдает рабочие исходники независимо от выбранной исторической точки UI.
   * Чистый первый/new HEAD не создаёт change; dirty→clean при прежнем HEAD создаёт.
   * includeHistory возвращает историю выбранного HEAD из того же чтения под lock:
   * вызывающему не требуется сразу после наблюдения заново читать все снимки.
   */
  async observe(current, head = null, { includeHistory = false } = {}) {
    return this.#locked(async () => {
      this.#snapshot(current);
      let headSnapshot = head;
      if (typeof head === "string") {
        this.#revision(head);
        headSnapshot = await captureGitHead(this.snapshotStore.root, { revision: head, snapshotRoot: this.snapshotStore.snapshotRoot });
      }
      if (headSnapshot) this.#snapshot(headSnapshot);
      const baseRevision = headSnapshot?.revision ?? null;
      this.#revision(baseRevision);
      const state = await this.#read();
      this.#writable(state);
      const observed = (record, created) => ({ record, created,
        ...(includeHistory ? { history: this.#history(state, baseRevision) } : {}) });
      let cursor = await this.#cursor(state);
      const same = cursor?.digest === current.digest && cursor?.headRevision === baseRevision;
      if (same) return observed(state.changes.find((record) => record.id === cursor.recordId) ?? null, false);
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
  async importSnapshots(snapshots, { baseRevision = null, source = "imported-snapshots" } = {}) {
    this.#revision(baseRevision);
    if (!Array.isArray(snapshots) || typeof source !== "string" || !source) throw new Error("Invalid change history import");
    return this.#locked(async () => {
      const state = await this.#read();
      this.#writable(state);
      const cursor = await this.#cursor(state);
      for (const snapshot of snapshots) this.#snapshot(snapshot);
      let sequence = Math.max(0, ...state.changes.map((record) => record.sequence));
      const changes = [];
      let imported = 0;
      for (const snapshot of [...snapshots].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt))) {
        this.#snapshot(snapshot);
        const id = "change-" + digest({ source, baseRevision, id: snapshot.id, digest: snapshot.digest, capturedAt: snapshot.capturedAt }).slice(7);
        const existing = state.changes.find((record) => record.id === id);
        if (existing) { changes.push(existing); continue; }
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

  #revision(value, allowUndefined = false) {
    if (value === null || (allowUndefined && value === undefined)) return;
    if (typeof value !== "string" || !REVISION.test(value)) throw new Error("Invalid change base revision");
  }

  #snapshot(snapshot) {
    if (!snapshot || snapshot.schema_version !== 2 || snapshot.root !== this.snapshotStore.snapshotRoot ||
        snapshot.complete !== true || !Array.isArray(snapshot.modules) || !Array.isArray(snapshot.facts) || snapshotDigest(snapshot) !== snapshot.digest ||
        typeof snapshot.id !== "string" || !snapshot.id || typeof snapshot.capturedAt !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(snapshot.capturedAt) || !Number.isFinite(Date.parse(snapshot.capturedAt))) throw new Error("Invalid or incomplete change snapshot");
    return snapshot;
  }

  #record(snapshot, baseRevision, sequence, id, provenance = { imported: false }) {
    const record = { ...clone(snapshot), id, kind: "change", label: "Изменение · " + snapshot.capturedAt,
      originalId: snapshot.id, originalKind: snapshot.kind, baseRevision, sequence, provenance };
    record.history_digest = digest(record);
    return record;
  }

  #validateRecord(record) {
    this.#snapshot(record);
    this.#revision(record.baseRevision);
    if (record.kind !== "change" || !ID.test(record.id) || !Number.isSafeInteger(record.sequence) || record.sequence < 1 ||
        typeof record.originalId !== "string" || !record.originalId || typeof record.provenance?.imported !== "boolean") throw new Error("Invalid change history record");
    const { history_digest, ...content } = record;
    if (history_digest !== digest(content)) throw new Error("Change history record digest mismatch");
    return record;
  }

  #recordCursor(record) {
    return { schema_version: 1, headRevision: record.baseRevision, digest: record.digest,
      recordId: record.id, sequence: record.sequence, capturedAt: record.capturedAt };
  }

  /** Проверяет сохранённую историю до записи; повреждение не превращается в пустую историю. */
  async #read() {
    const state = { changes: [], diagnostics: [] };
    let names;
    try {
      const info = await lstat(this.directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid change history directory");
      names = await readdir(this.directory);
    } catch (error) { if (error.code === "ENOENT") return state; throw error; }
    for (const name of names.sort()) {
      if (!name.startsWith("change-") || !name.endsWith(".yaml")) continue;
      try {
        const record = this.#validateRecord(await this.#yaml(path.join(this.directory, name)));
        if (name !== record.id + ".yaml") throw new Error("Change history filename mismatch");
        if (state.changes.some((entry) => entry.sequence === record.sequence)) throw new Error("Duplicate change sequence");
        state.changes.push(record);
      } catch (error) { state.diagnostics.push(name + ": " + error.message); }
    }
    return state;
  }

  #writable(state) {
    if (state.diagnostics.length) throw new Error("Change history is damaged; refusing to append: " + state.diagnostics.join("; "));
  }

  /** Восстанавливает cursor после сбоя между готовой записью события и его cursor. */
  async #cursor(state) {
    let cursor = null;
    try {
      cursor = await this.#yaml(path.join(this.directory, ".cursor.yaml"));
      this.#revision(cursor.headRevision);
      if (cursor.schema_version !== 1 || !/^sha256:[a-f0-9]{64}$/.test(cursor.digest) || !Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0 ||
          (cursor.recordId !== null && !ID.test(cursor.recordId)) || typeof cursor.capturedAt !== "string" || !Number.isFinite(Date.parse(cursor.capturedAt))) throw new Error("Invalid change history cursor");
      if (cursor.recordId && !state.changes.some((record) => record.id === cursor.recordId)) throw new Error("Change cursor refers to a missing record");
      if (cursor.sequence > Math.max(0, ...state.changes.map((record) => record.sequence))) throw new Error("Change cursor refers to missing history");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    const interrupted = state.changes.filter((record) => !record.provenance.imported && record.sequence > (cursor?.sequence ?? 0))
      .sort((a, b) => a.sequence - b.sequence).at(-1);
    if (interrupted) return this.#recordCursor(interrupted);
    if (!cursor && state.changes.length) return this.#recordCursor([...state.changes].sort(chronological).at(-1));
    return cursor;
  }

  async #yaml(file) {
    await this.snapshotStore.assertLocation(file);
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Change history file must be an ordinary file");
    return parseReportYaml(await readFile(file, "utf8"));
  }

  async #save(record) {
    await this.#atomic(path.join(this.directory, record.id + ".yaml"), stringify(record, { aliasDuplicateObjects: false }), true);
  }

  async #writeCursor(cursor) {
    await this.#atomic(path.join(this.directory, ".cursor.yaml"), stringify(cursor), false);
  }

  /** Immutable событие публикуется hard link; cursor заменяется готовым файлом. */
  async #atomic(file, text, immutable) {
    await this.snapshotStore.assertLocation(file);
    const temporary = path.join(this.directory, ".pending-" + randomUUID());
    await writeFile(temporary, text, { flag: "wx" });
    try { if (immutable) await link(temporary, file); else await rename(temporary, file); }
    finally { await rm(temporary, { force: true }); }
  }

  /** Отдельный lock не блокирует публикацию work; атомарные файлы безопасны для readers. */
  async #locked(action) {
    await this.snapshotStore.open();
    await this.snapshotStore.assertLocation(this.directory);
    await mkdir(this.directory, { recursive: true });
    const directoryInfo = await lstat(this.directory);
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error("Invalid change history directory");
    const lock = path.join(this.directory, ".lock"), owner = path.join(this.directory, ".owner-" + randomUUID());
    const token = randomUUID();
    await writeFile(owner, JSON.stringify({ pid: process.pid, token }), { flag: "wx" });
    try {
      for (let attempt = 0; ; attempt++) {
        try { await link(owner, lock); break; } catch (error) {
          if (error.code !== "EEXIST") throw error;
          let holder;
          try { holder = await this.#yamlLock(lock); } catch (readError) { if (readError.code === "ENOENT") continue; throw readError; }
          try { process.kill(holder.pid, 0); } catch (error) { if (error.code === "ESRCH") { await rm(lock, { force: true }); continue; } }
          if (attempt > 1200) throw new Error("Change history is locked by another writer");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    } finally { await rm(owner, { force: true }); }
    try { await this.snapshotStore.ensureIdentity(); return await action(); }
    finally { if ((await this.#yamlLock(lock)).token === token) await rm(lock, { force: true }); }
  }

  async #yamlLock(file) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid change history lock");
    const owner = JSON.parse(await readFile(file, "utf8"));
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== "string") throw new Error("Invalid change history lock owner");
    return owner;
  }
}
