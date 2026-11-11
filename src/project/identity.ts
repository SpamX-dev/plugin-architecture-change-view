import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { errorDetails } from "../runtime/errors.js";
import { assertStateLocation, projectStateDirectory } from "./paths.js";

/** Читает происхождение истории; отсутствующий манифест не создаётся при анализе. */
export async function readSnapshotRoot(root: string, directory = projectStateDirectory(root)) {
  await assertStateLocation(root, directory);
  const file = path.join(directory, "project.json");
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024) throw new Error("Invalid ArchiView project identity file");
    const value: {schema_version?: unknown; snapshot_root?: unknown} = JSON.parse(await readFile(file, "utf8"));
    if (value.schema_version !== 1 || typeof value.snapshot_root !== "string" || !value.snapshot_root ||
        value.snapshot_root.includes("\0") || Object.keys(value).some((key) => !["schema_version", "snapshot_root"].includes(key))) {
      throw new Error("Invalid ArchiView project identity");
    }
    return value.snapshot_root;
  } catch (errorCause) { const error = errorDetails(errorCause);
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** Фиксирует идентичность один раз; Git отслеживает историю, но пропускает временные записи. */
export async function ensureProjectIdentity(root: string, directory: string, snapshotRoot: string) {
  await assertStateLocation(root, directory);
  await mkdir(directory, { recursive: true });
  const temporary = path.join(directory, ".identity-" + randomUUID());
  try {
    await writeFile(temporary, JSON.stringify({ schema_version: 1, snapshot_root: snapshotRoot }, null, 2) + "\n", { flag: "wx" });
    // Hard link публикует готовый файл атомарно и не заменяет уже принятую идентичность.
    try { await link(temporary, path.join(directory, "project.json")); }
    catch (errorCause) { const error = errorDetails(errorCause);
      if (error.code !== "EEXIST") throw error;
      if (await readSnapshotRoot(root, directory) !== snapshotRoot) throw new Error("ArchiView project identity collision");
    }
  } finally { await rm(temporary, { force: true }); }
  try { await writeFile(path.join(directory, ".gitignore"), ".snapshot-*\n.pending-*\n.identity-*\n", { flag: "wx" }); }
  catch (errorCause) { const error = errorDetails(errorCause); if (error.code !== "EEXIST") throw error; }
}
