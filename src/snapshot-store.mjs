/**
 * Хранит пользовательские снимки ArchiView вне исходного проекта.
 * Снимок содержит контракты, отпечатки и ограниченный набор текстовых доказательств.
 * Публикация атомарна; неполный обход не может стать сохранённой базой.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, lstat, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { snapshotDigest } from "./snapshots.mjs";

/** Адресует локальное хранилище по каноническому пути конкретного проекта. */
export function defaultSnapshotDirectory(root) {
  const key = createHash("sha256").update(root).digest("hex").slice(0, 20);
  return path.join(os.homedir(), ".archiview", key);
}

/** Проверяет схему и принадлежность сохранённого документа выбранному проекту. */
function validate(snapshot, root) {
  if (![1, 2].includes(snapshot.schema_version) || snapshot.root !== root ||
      !Array.isArray(snapshot.modules) || typeof snapshot.fingerprint !== "string" ||
      !snapshot.complete || !Array.isArray(snapshot.diagnostics)) {
    throw new Error("Invalid or foreign snapshot");
  }
  if (snapshot.schema_version === 2 && snapshot.digest !== snapshotDigest(snapshot)) throw new Error("Snapshot digest mismatch");
  for (const module of snapshot.modules) {
    if (typeof module.directory !== "string" || module.directory.startsWith("/") ||
        module.directory.includes("\\") || module.directory.split("/").includes("..") ||
        !Array.isArray(module.files) || typeof module.document?.state !== "string") {
      throw new Error("Invalid snapshot module");
    }
  }
  return snapshot;
}

/** Владеет только JSON-снимками одного проекта внутри отдельного каталога. */
export class SnapshotStore {
  /** Канонический корень исходников, привязывающий снимки к проекту. */
  root;
  /** Каталог хранения; его создание происходит только при явном сохранении. */
  directory;

  constructor(root, directory = defaultSnapshotDirectory(root)) {
    this.root = root;
    this.directory = path.resolve(directory);
    const relative = path.relative(root, this.directory);
    if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." &&
        !relative.startsWith(".." + path.sep))) {
      throw new Error("Snapshot storage must be outside the source project");
    }
  }

  /** Проверяет фактическое назначение каталога, включая ссылки в существующих предках. */
  async assertExternal(directory = this.directory) {
    let ancestor = directory;
    while (true) {
      try {
        const resolved = await realpath(ancestor);
        const target = path.resolve(resolved, path.relative(ancestor, directory));
        const relative = path.relative(this.root, target);
        if (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep))) {
          throw new Error("Snapshot storage resolves inside source project");
        }
        return;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
  }

  /** Возвращает сохранённые базы; повреждённый файл вызывает явную ошибку. */
  async list() {
    await this.assertExternal();
    let entries;
    try { entries = await readdir(this.directory); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
    const snapshots = [];
    for (const file of entries.filter((name) => /^saved-[a-f0-9]{24}\.json$/.test(name))) {
      const target = path.join(this.directory, file);
      const info = await lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024 * 1024) {
        throw new Error("Stored snapshot exceeds the size limit");
      }
      snapshots.push(validate(JSON.parse(await readFile(target, "utf8")), this.root));
    }
    return snapshots.sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  }

  /** Сохраняет проверенный снимок без изменения выбранной базы интерфейса. */
  async save(snapshot, label) {
    await this.assertExternal();
    validate(snapshot, this.root);
    const saved = { ...snapshot, id: "saved-" + (snapshot.digest?.slice(7) ?? snapshot.fingerprint).slice(0, 24),
      kind: "saved", label: label?.trim() || "Сохранённый снимок" };
    const content = JSON.stringify(saved);
    if (Buffer.byteLength(content) > 64 * 1024 * 1024) {
      throw new Error("Snapshot exceeds the storage size limit");
    }
    await mkdir(this.directory, { recursive: true });
    const temporary = path.join(this.directory, ".snapshot-" + randomUUID());
    try {
      await writeFile(temporary, content, { flag: "wx" });
      await rename(temporary, path.join(this.directory, saved.id + ".json"));
    } finally { await rm(temporary, { force: true }); }
    return saved;
  }
}
