import { isUtf8 } from "node:buffer";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { assertStateLocation, STATE_DIRECTORY, within } from "../project/paths.js";
import { errorDetails } from "../runtime/errors.js";
import { parseYaml } from "../serialization/yaml.js";
import { contractDocument } from "./document.js";
import type { ContractDocument } from "./types.js";
import { excludedProjectPath, portable } from "./source-files.js";

export const MODULE_TREE_FILE = STATE_DIRECTORY + "/modules.tree";
export const MODULE_DIRECTORY = STATE_DIRECTORY + "/modules";
export const MAX_DOCUMENT_BYTES = 128 * 1024;
export const MAX_TREE_BYTES = 4 * 1024 * 1024;

// The same filename must identify the same module on Windows and Unix.
function portableName(value: string) {
  return value.trim().length > 0 && value !== "." && value !== ".." &&
    !/[<>:"/\\|?*\x00-\x1f]/u.test(value) && !/[. ]$/u.test(value) &&
    !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(value);
}

export function moduleDocumentPath(id: string) {
  if (!portableName(id)) throw new Error("Invalid module id for a contract filename: " + id);
  return MODULE_DIRECTORY + "/" + id + ".yaml";
}

export function isModuleContractPath(relative: string) {
  if (path.posix.dirname(relative) !== MODULE_DIRECTORY || !relative.endsWith(".yaml")) return false;
  return portableName(path.posix.basename(relative, ".yaml"));
}

/** Parse the authoritative id → source directory map and index it by source directory. */
export function parseModuleTree(text: string): Map<string, string> {
  return parseYaml(text, (value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(MODULE_TREE_FILE + " must be a YAML mapping from module ids to directories");
    }
    const directories = new Map<string, string>();
    const paths = new Set<string>();
    const ids = new Set<string>();
    for (const [id, directory] of Object.entries(value)) {
      moduleDocumentPath(id);
      if (typeof directory !== "string" || directory !== "." &&
          (!directory.split("/").every(portableName) || excludedProjectPath(directory))) {
        throw new Error("Invalid project directory for " + id + ": " + String(directory));
      }
      if (ids.has(id.toLowerCase())) throw new Error("Duplicate module id: " + id);
      if (paths.has(directory.toLowerCase())) throw new Error("Duplicate module directory: " + directory);
      ids.add(id.toLowerCase());
      paths.add(directory.toLowerCase());
      directories.set(directory, id);
    }
    return directories;
  });
}

export function mappedContractDocument(text: string, id: string) {
  const parsed = contractDocument(text);
  if (parsed.contract && parsed.contract.id !== id) {
    return { ...parsed, state: "invalid", contract: null,
      errors: ["Contract id " + parsed.contract.id + " does not match " + moduleDocumentPath(id)] };
  }
  return parsed;
}

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
export async function assertModuleDirectory(root: string, directory: string) {
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

export interface ModuleDocument extends Partial<Omit<ContractDocument, "state">> {
  directory: string;
  document: string;
  status: string;
}

export const ADD_MAPPING = "Добавьте id и каталог в .archiview/modules.tree и сохраните контракт в .archiview/modules/<id>.yaml.";

export function resolveModuleDocument(directory: string, id: string | undefined, text: string | null): ModuleDocument {
  if (!id) return { directory, document: MODULE_TREE_FILE, status: "missing", action: ADD_MAPPING };
  const document = moduleDocumentPath(id);
  if (text === null) return { directory, document, status: "missing", action: "Восстановите зарегистрированный контракт " + document };
  const { state, ...parsed } = mappedContractDocument(text, id);
  return { directory, document, status: state, ...parsed };
}
