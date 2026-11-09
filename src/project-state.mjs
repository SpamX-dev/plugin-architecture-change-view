/**
 * Адресация данных ArchiView и происхождение снимков. Сохранённый корень служит
 * только устойчивой идентичностью истории: файловые операции всегда используют
 * фактический --root. Это сохраняет исходные хеши отчётов после переноса проекта.
 */
import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Зарезервированное хранилище данных, исключаемое из анализа исходников. */
export const STATE_DIRECTORY = ".archiview";

/** Выбирает папку данных относительно проекта; абсолютный внешний путь сохраняется. */
export function projectStateDirectory(root, directory = STATE_DIRECTORY) {
  const target = path.resolve(root, directory);
  if (within(root, target) && !within(path.join(root, STATE_DIRECTORY), target)) {
    throw new Error("State storage must be under .archiview or outside source project");
  }
  return target;
}

/** Проверяет вложенность разрешённых абсолютных путей, включая сам каталог. */
function within(root, target) {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
}

/**
 * Разрешает данные только в зарезервированной папке проекта либо во внешнем
 * хранилище. Ссылки не могут перенаправить локальные данные в исходники или наружу.
 */
export async function assertStateLocation(root, directory, target = directory) {
  const local = within(root, directory);
  if (local && !within(path.join(root, STATE_DIRECTORY), directory)) {
    throw new Error("State storage inside source project must be under .archiview");
  }
  if (!within(directory, target)) throw new Error("Path escapes state storage");
  let ancestor = target;
  while (true) {
    try {
      const resolved = await realpath(ancestor);
      const destination = path.resolve(resolved, path.relative(ancestor, target));
      if (local && path.relative(target, destination) !== "") throw new Error("Local state storage cannot use directory links");
      if (!local && within(root, destination)) throw new Error("External state storage resolves inside source project");
      return;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

/** Читает происхождение истории; отсутствующий манифест не создаётся при анализе. */
export async function readSnapshotRoot(root, directory = projectStateDirectory(root)) {
  await assertStateLocation(root, directory);
  const file = path.join(directory, "project.json");
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024) throw new Error("Invalid ArchiView project identity file");
    const value = JSON.parse(await readFile(file, "utf8"));
    if (value.schema_version !== 1 || typeof value.snapshot_root !== "string" || !value.snapshot_root ||
        value.snapshot_root.includes("\0") || Object.keys(value).some((key) => !["schema_version", "snapshot_root"].includes(key))) {
      throw new Error("Invalid ArchiView project identity");
    }
    return value.snapshot_root;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Фиксирует идентичность один раз; Git отслеживает историю, но пропускает временные записи. */
export async function ensureProjectIdentity(root, directory, snapshotRoot) {
  await assertStateLocation(root, directory);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, ".identity-" + randomUUID());
  try {
    await writeFile(temporary, JSON.stringify({ schema_version: 1, snapshot_root: snapshotRoot }, null, 2) + "\n", { flag: "wx" });
    // Hard link публикует готовый файл атомарно и не заменяет уже принятую идентичность.
    try { await link(temporary, path.join(directory, "project.json")); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (await readSnapshotRoot(root, directory) !== snapshotRoot) throw new Error("ArchiView project identity collision");
    }
  } finally { await rm(temporary, { force: true }); }
  try { await writeFile(path.join(directory, ".gitignore"), ".snapshot-*\n.pending-*\n.identity-*\n", { flag: "wx" }); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
}
