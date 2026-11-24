import { isUtf8 } from "node:buffer";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { assertStateLocation, STATE_DIRECTORY, within } from "./paths.js";
import { errorDetails } from "../../node-errors.js";
import {
  isModuleContractPath, MAX_DOCUMENT_BYTES, MAX_TREE_BYTES, MODULE_DIRECTORY, MODULE_TREE_FILE, parseModuleTree,
} from "../../framework/contracts/module-tree.js";
import { excludedProjectPath, portable } from "./source-files.js";

export * from "../../framework/contracts/module-tree.js";

async function existingEntry(file: string) {
  try { return await lstat(file); }
  catch (cause) { if (errorDetails(cause).code !== "ENOENT") throw cause; }
}

/** Resolves the caller's source path, retaining the filesystem's spelling. */
export async function resolveSourceDirectory(root: string, directory: string) {
  const requested = path.resolve(root, directory);
  if (!within(root, requested)) throw new Error("directory is outside project");
  const target = await realpath(requested);
  if (!within(root, target)) throw new Error("directory resolves outside project");
  if (excludedProjectPath(path.relative(root, target))) throw new Error("directory is excluded from project sources");
  if (path.relative(requested, target) !== "") throw new Error("source directory uses a directory link: " + directory);
  if (!(await lstat(target)).isDirectory()) throw new Error("directory is not a directory: " + directory);
  return portable(path.relative(root, target));
}

/** Git tree paths are case-sensitive even when the local filesystem accepts aliases. */
export async function assertModuleDirectory(root: string, directory: string, planned = false): Promise<void> {
  if (planned && directory !== "." && !await existingEntry(path.join(root, directory))) {
    return assertModuleDirectory(root, path.posix.dirname(directory), true);
  }
  const actual = await resolveSourceDirectory(root, directory);
  if (actual !== directory) throw new Error("Mapped directory " + directory + " does not match " + actual);
}

export function decodeContractText(bytes: Buffer, document: string) {
  if (!isUtf8(bytes)) throw new Error(document + " contains invalid UTF-8");
  return bytes.toString("utf8");
}

export async function readContractStorageFile(root: string, relative: string): Promise<string | null> {
  if (relative !== MODULE_TREE_FILE && !isModuleContractPath(relative)) {
    throw new Error("Invalid contract storage path: " + relative);
  }
  const file = path.join(root, relative);
  await assertStateLocation(root, path.join(root, STATE_DIRECTORY), file);
  const info = await existingEntry(file);
  if (!info) return null;
  if (portable(path.relative(root, await realpath(file))) !== relative) return null;
  if (!info.isFile()) throw new Error("Contract storage entry must be a regular file: " + relative);
  const limit = relative === MODULE_TREE_FILE ? MAX_TREE_BYTES : MAX_DOCUMENT_BYTES;
  if (info.size > limit) throw new Error(relative + " exceeds " + limit / 1024 + " KiB");
  return decodeContractText(await readFile(file), relative);
}

export async function readModuleTree(root: string) {
  const text = await readContractStorageFile(root, MODULE_TREE_FILE);
  return text === null ? new Map<string, string>() : parseModuleTree(text);
}

/** Lists only direct YAML entries, including unregistered contracts that need repair. */
export async function listModuleContractPaths(root: string) {
  const directory = path.join(root, MODULE_DIRECTORY);
  await assertStateLocation(root, path.join(root, STATE_DIRECTORY), directory);
  if (!await existingEntry(directory)) return [];
  if (portable(path.relative(root, await realpath(directory))) !== MODULE_DIRECTORY) return [];
  const names = await readdir(directory);
  return names.filter((name) => name.endsWith(".yaml")).sort().map((name) => MODULE_DIRECTORY + "/" + name);
}
