import type { Comparison, Snapshot } from "../../framework/snapshots/types.js";
import { ArchiveCache, readArchiveFile } from "../../storage/archive-cache.js";
import { errorDetails } from "../../node-errors.js";
/**
 * Сохраняет снимки в <root>/.archiview либо явно выбранном внешнем хранилище.
 * Происхождение истории фиксируется отдельно от текущего пути проекта, поэтому
 * перенос через Git сохраняет хеши и доказательства. Старый каталог остаётся целым.
 */
import { randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, rename, rm, lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
import { parseYaml } from "../../framework/serialization/yaml.js";
import { snapshotDigest } from "../../framework/snapshots/identity.js";
import { digest } from "../../framework/serialization/digest.js";
import { comparisonId } from "./comparison.js";
import { ensureProjectIdentity, readSnapshotRoot } from "../../storage/identity.js";
import { assertStateLocation, projectStateDirectory } from "../../storage/paths.js";

/** Адресует переносимое хранилище внутри выбранного проекта. */
export function defaultSnapshotDirectory(root: string) { return projectStateDirectory(root); }

/** Проверяет схему, происхождение и неизменность сохранённого снимка. */
function validate(input: unknown, snapshotRoot: string): Snapshot {
  const snapshot = input as Snapshot;
  if (![1, 2].includes(snapshot.schema_version) || snapshot.root !== snapshotRoot ||
      !Array.isArray(snapshot.modules) || typeof snapshot.fingerprint !== "string" ||
      !snapshot.complete || !Array.isArray(snapshot.diagnostics)) throw new Error("Invalid or foreign snapshot");
  if (snapshot.schema_version === 2 && snapshot.digest !== snapshotDigest(snapshot)) throw new Error("Snapshot digest mismatch");
  for (const module of snapshot.modules) {
    if (typeof module.directory !== "string" || module.directory.startsWith("/") ||
        module.directory.includes("\\") || module.directory.split("/").includes("..") ||
        !Array.isArray(module.files) || typeof module.document?.state !== "string") throw new Error("Invalid snapshot module");
  }
  return snapshot;
}

async function archiveNames(root: string, directory: string, folder: string) {
  await assertStateLocation(root, directory, folder);
  try { return await readdir(folder); }
  catch (cause) { if (errorDetails(cause).code === "ENOENT") return []; throw cause; }
}

/** Names of raw snapshot archives in both supported storage layouts. */
export async function savedSnapshotPaths(root: string, directory: string) {
  const raw = path.join(directory, "snapshots");
  const [old, files] = await Promise.all([archiveNames(root, directory, directory), archiveNames(root, directory, raw)]);
  return [...old.filter(name => /^saved-[a-f0-9]{24}\.json$/.test(name)).map(name => path.join(directory, name)),
    ...files.filter(name => /^saved-[a-f0-9]{24}\.yaml$/.test(name)).map(name => path.join(raw, name))];
}

export async function readSavedSnapshot(file: string, snapshotRoot: string) {
  const text = (await readArchiveFile(file)).toString("utf8");
  return file.endsWith(".json") ? validate(JSON.parse(text), snapshotRoot) :
    parseYaml(text, value => validate(value, snapshotRoot));
}

/** Сохраняемый результат сравнения исключает добавленные сессией обзоры, снимки и состояние UI. */
function comparisonReport(input: Comparison): Comparison {
  const { schema_version, id, root, origin, emptyTree, before, after, counts, complete, diagnostics } = input;
  const modules = input.modules.map(({ directory, key, sourceFiles, filesChanged, descendantChanges, name,
    moduleId, title, baselinePath, currentPath, moved, status, documentState, documentChanged, files, before, after }) =>
    ({ directory, key, sourceFiles, filesChanged, descendantChanges, name, moduleId, title, baselinePath,
      currentPath, moved, status, documentState, documentChanged, files, before, after }));
  return { schema_version, id, root, origin, emptyTree, before, after, counts, complete, diagnostics, modules };
}

/** Владеет снимками одного проекта и манифестом происхождения его истории. */
export class SnapshotStore {
  readonly #savedFiles = new ArchiveCache<Snapshot>();
  /** Настоящий корень исходников: только он используется для файловых операций. */
  root;
  /** Физическое размещение данных, исключаемое из исходного дерева. */
  directory: string;
  /** Корень происхождения снимков; после переноса может отличаться от настоящего пути. */
  snapshotRoot: string;
  #ready?: Promise<void>;

  constructor(root: string, directory?: string) {
    this.root = path.resolve(root);
    this.directory = projectStateDirectory(this.root, directory);
    this.snapshotRoot = this.root;
  }

  /** Загружает происхождение сохранённых снимков. */
  async open() {
    this.#ready ??= this.#initialize();
    await this.#ready;
    return this;
  }

  async #initialize() {
    this.snapshotRoot = await readSnapshotRoot(this.root, this.directory) ?? this.root;
  }

  /** Проверяет размещение до каждого чтения или записи, включая вложенные папки отчётов. */
  async assertLocation(directory = this.directory) {
    await assertStateLocation(this.root, this.directory, directory);
  }

  /** Записывает происхождение до публикации первого снимка или отчёта. */
  async ensureIdentity() {
    await this.open();
    await ensureProjectIdentity(this.root, this.directory, this.snapshotRoot);
  }

  /** Открывает опубликованный Git-отчёт без повторного чтения рабочего дерева или выбора исходной пары. */
  async readComparison(id: string): Promise<Comparison | null> {
    if (!/^[a-f0-9]{24}$/.test(id)) throw new Error("Invalid comparison report ID");
    await this.open();
    const file = path.join(this.directory, "comparisons", id + ".json");
    await this.assertLocation(file);
    let bytes: Buffer;
    try { bytes = await readArchiveFile(file); }
    catch (cause) { if (errorDetails(cause).code === "ENOENT") return null; throw cause; }
    const archive = JSON.parse(bytes.toString("utf8"));
    const report: Comparison = archive.report;
    if (archive.schema_version !== 1 || report?.schema_version !== 2 || report.id !== id ||
        report.origin !== this.snapshotRoot || archive.digest !== digest(report) || comparisonId(report) !== id)
      throw new Error("Invalid or foreign comparison report: " + id);
    return report;
  }

  /** Публикует первый законченный результат под постоянным ID. Повторный захват сохраняет исходные метки и время. */
  async saveComparison(input: Comparison): Promise<Comparison> {
    await this.open();
    const report = comparisonReport(input);
    if (report.origin !== this.snapshotRoot || report.schema_version !== 2 || report.id !== comparisonId(report))
      throw new Error("Invalid or foreign comparison report");
    const existing = await this.readComparison(report.id);
    if (existing) return existing;
    const content = JSON.stringify({ schema_version: 1, digest: digest(report), report });
    if (Buffer.byteLength(content) > 64 * 1024 * 1024) throw new Error("Comparison report exceeds the storage size limit");
    await this.ensureIdentity();
    const directory = path.join(this.directory, "comparisons");
    await this.assertLocation(directory);
    await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, ".pending-" + randomUUID());
    const file = path.join(directory, report.id + ".json");
    try {
      await writeFile(temporary, content, { flag: "wx" });
      try { await link(temporary, file); }
      catch (cause) { if (errorDetails(cause).code !== "EEXIST") throw cause; }
    } finally { await rm(temporary, { force: true }); }
    const saved = await this.readComparison(report.id);
    if (!saved) throw new Error("Comparison report disappeared during publication");
    return saved;
  }

  /** Read only names and small labels for the timeline. Earlier archives can still be opened by ID. */
  async savedMetadata() {
    const raw = path.join(this.directory, "snapshots");
    const [old, files] = await Promise.all([archiveNames(this.root, this.directory, this.directory), archiveNames(this.root, this.directory, raw)]);
    const ids = new Set([...old.filter(name => /^saved-[a-f0-9]{24}\.json$/.test(name)),
      ...files.filter(name => /^saved-[a-f0-9]{24}\.yaml$/.test(name))].map(name => name.slice(0, -5)));
    const names = new Set(files);
    return Promise.all([...ids].map(async id => {
      const fallback = { id, kind: "saved", label: "Сохранённый снимок " + id.slice(6, 14) };
      if (!names.has(id + ".meta.json")) return fallback;
      try {
        const file = path.join(raw, id + ".meta.json");
        await this.assertLocation(file);
        const info = await lstat(file);
        if (!info.isFile() || info.size > 4096) return fallback;
        const { label, capturedAt } = JSON.parse(await readFile(file, "utf8"));
        if (typeof label === "string" && typeof capturedAt === "string") return { ...fallback, label, capturedAt };
      } catch { /* The snapshot remains selectable even if its display label cannot be read. */ }
      return fallback;
    }));
  }

  /** Возвращает сохранённые снимки от новых к старым. */
  async list() {
    await this.open();
    const snapshots: Snapshot[] = [];
    const paths = await savedSnapshotPaths(this.root, this.directory);
    this.#savedFiles.retain(new Set(paths));
    for (const file of paths) {
      await this.assertLocation(file);
      const saved = await this.#savedFiles.read(file, () => readSavedSnapshot(file, this.snapshotRoot));
      snapshots.push(structuredClone(saved));
    }
    return [...new Map(snapshots.map((snapshot) => [snapshot.id, snapshot])).values()]
      .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  }

  /** Сохраняет неизменяемое содержание снимка без переключения выбранной базы интерфейса. */
  async save(snapshot: Snapshot, label?: string) {
    await this.open();
    await this.assertLocation();
    validate(snapshot, this.snapshotRoot);
    const saved = { ...snapshot, id: "saved-" + (snapshot.digest?.slice(7) ?? snapshot.fingerprint).slice(0, 24),
      kind: "saved", label: label?.trim() || "Сохранённый снимок" };
    const content = stringify(saved, { aliasDuplicateObjects: false });
    if (Buffer.byteLength(content) > 64 * 1024 * 1024) throw new Error("Snapshot exceeds the storage size limit");
    await this.ensureIdentity();
    const raw = path.join(this.directory, "snapshots");
    await this.assertLocation(raw);
    await mkdir(raw, { recursive: true });
    const temporary = path.join(raw, ".snapshot-" + randomUUID());
    try {
      await writeFile(temporary, content, { flag: "wx" });
      await rename(temporary, path.join(raw, saved.id + ".yaml"));
      await writeFile(temporary, JSON.stringify({ label: saved.label, capturedAt: saved.capturedAt }), { flag: "wx" });
      await rename(temporary, path.join(raw, saved.id + ".meta.json"));
    } finally { await rm(temporary, { force: true }); }
    return saved;
  }
}
