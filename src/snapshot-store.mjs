/**
 * Сохраняет снимки в <root>/.archiview либо явно выбранном внешнем хранилище.
 * Происхождение истории фиксируется отдельно от текущего пути проекта, поэтому
 * перенос через Git сохраняет хеши и доказательства. Старый каталог остаётся целым.
 */
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, rm, lstat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { parseYaml } from "./formats.mjs";
import { snapshotDigest } from "./snapshots.mjs";
import { assertStateLocation, ensureProjectIdentity, projectStateDirectory, readSnapshotRoot } from "./project-state.mjs";

/** Адресует переносимое хранилище внутри выбранного проекта. */
export function defaultSnapshotDirectory(root) { return projectStateDirectory(root); }

/** Вычисляет прежнее внешнее размещение исключительно для переноса существующей истории. */
export function legacySnapshotDirectory(root) {
  const key = createHash("sha256").update(root).digest("hex").slice(0, 20);
  return path.join(os.homedir(), ".archiview", key);
}

/** Проверяет схему, происхождение и неизменность сохранённого снимка. */
function validate(snapshot, snapshotRoot) {
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

/** Читает ограниченный обычный файл; ссылки не считаются данными истории. */
async function readStoredFile(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) throw new Error("Invalid stored file");
  return readFile(file);
}

/** Владеет снимками одного проекта и манифестом происхождения его истории. */
export class SnapshotStore {
  /** Настоящий корень исходников: только он используется для файловых операций. */
  root;
  /** Физическое размещение данных, исключаемое из исходного дерева. */
  directory;
  /** Корень происхождения снимков; после переноса может отличаться от настоящего пути. */
  snapshotRoot;
  /** Сведения о выполненном переносе для сообщения локального CLI. */
  migration = null;
  #ready;
  #legacyDirectory;

  constructor(root, directory, { legacyDirectory } = {}) {
    this.root = path.resolve(root);
    this.directory = projectStateDirectory(this.root, directory);
    this.snapshotRoot = this.root;
    this.#legacyDirectory = legacyDirectory ?? legacySnapshotDirectory(this.root);
  }

  /** Загружает происхождение и один раз переносит старую историю в новое размещение. */
  async open() {
    this.#ready ??= this.#initialize();
    await this.#ready;
    return this;
  }

  async #initialize() {
    await this.assertLocation();
    const identity = await readSnapshotRoot(this.root, this.directory);
    if (identity !== null) { this.snapshotRoot = identity; return; }
    if (this.directory === defaultSnapshotDirectory(this.root)) await this.#migrateLegacy();
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

  /** Копирует только проверенные файлы, не заменяя существующий отличающийся результат. */
  async #copyLegacyFile(source, destination) {
    await this.assertLocation(path.dirname(destination));
    await mkdir(path.dirname(destination), { recursive: true });
    try { await copyFile(source, destination, constants.COPYFILE_EXCL); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!(await readStoredFile(source)).equals(await readStoredFile(destination))) throw new Error("State migration collision: " + path.basename(destination));
    }
  }

  /** Перенос сохраняет байты, id и хеши пакетов; прежнее внешнее хранилище не удаляется. */
  async #migrateLegacy() {
    const legacy = path.resolve(this.#legacyDirectory);
    if (legacy === this.directory) return;
    let entries;
    try {
      await assertStateLocation(this.root, legacy);
      const info = await lstat(legacy);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid legacy state directory");
      entries = await readdir(legacy);
    } catch (error) { if (error.code === "ENOENT") return; throw error; }
    const snapshotRoot = await readSnapshotRoot(this.root, legacy) ?? this.root;
    const files = [];
    let snapshots = 0;
    let reviews = 0;
    for (const file of entries.filter((name) => /^saved-[a-f0-9]{24}\.json$/.test(name))) {
      validate(JSON.parse((await readStoredFile(path.join(legacy, file))).toString("utf8")), snapshotRoot);
      files.push(file); snapshots += 1;
    }
    if (entries.includes("snapshots")) {
      const raw = path.join(legacy, "snapshots");
      await assertStateLocation(this.root, legacy, raw);
      for (const file of (await readdir(raw)).filter((name) => /^saved-[a-f0-9]{24}\.yaml$/.test(name))) {
        parseYaml((await readStoredFile(path.join(raw, file))).toString("utf8"), (value) => validate(value, snapshotRoot));
        files.push(path.join("snapshots", file)); snapshots += 1;
      }
    }
    if (entries.includes("reviews")) {
      const reviewDirectory = path.join(legacy, "reviews");
      const info = await lstat(reviewDirectory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid legacy review directory");
      const { readReviewBundle } = await import("./review-store.mjs");
      for (const entry of await readdir(reviewDirectory, { withFileTypes: true })) {
        if (entry.name.startsWith(".")) continue;
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Invalid legacy review entry");
        const bundle = await readReviewBundle(path.join(reviewDirectory, entry.name));
        if (bundle.current.root !== snapshotRoot) throw new Error("Foreign legacy review project");
        const names = ["review.yaml", "input.json", "current.json", ...(bundle.baseline ? ["baseline.json"] : [])];
        for (const name of names) files.push(path.join("reviews", entry.name, name));
        reviews += 1;
      }
    }
    if (!files.length) return;
    for (const file of files) await this.#copyLegacyFile(path.join(legacy, file), path.join(this.directory, file));
    await ensureProjectIdentity(this.root, this.directory, snapshotRoot);
    this.snapshotRoot = snapshotRoot;
    this.migration = { from: legacy, snapshots, reviews };
  }

  /** Возвращает сохранённые базы; повреждение схемы или хеша сообщается явно. */
  async list() {
    await this.open();
    await this.assertLocation();
    let entries;
    try { entries = await readdir(this.directory); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const snapshots = [];
    for (const file of entries.filter((name) => /^saved-[a-f0-9]{24}\.json$/.test(name))) {
      snapshots.push(validate(JSON.parse((await readStoredFile(path.join(this.directory, file))).toString("utf8")), this.snapshotRoot));
    }
    const raw = path.join(this.directory, "snapshots");
    await this.assertLocation(raw);
    let savedFiles = [];
    try { savedFiles = await readdir(raw); } catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const file of savedFiles.filter((name) => /^saved-[a-f0-9]{24}\.yaml$/.test(name))) {
      snapshots.push(parseYaml((await readStoredFile(path.join(raw, file))).toString("utf8"), (value) => validate(value, this.snapshotRoot)));
    }
    // Опубликованные фрагменты восстанавливают выбранную базу даже без локальных snapshots.
    const { readPublishedSnapshots } = await import("./report-store.mjs");
    for (const snapshot of await readPublishedSnapshots(this)) snapshots.push(validate(snapshot, this.snapshotRoot));
    return [...new Map(snapshots.map((snapshot) => [snapshot.id, snapshot])).values()]
      .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  }

  /** Сохраняет неизменяемое содержание снимка без переключения выбранной базы интерфейса. */
  async save(snapshot, label) {
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
    } finally { await rm(temporary, { force: true }); }
    return saved;
  }
}
