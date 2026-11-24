import path from "node:path";
import { excludedProjectPath, STATE_DIRECTORY } from "../project/paths.js";
import { parseYaml } from "../serialization/yaml.js";
import { contractDocument } from "./document.js";
import type { ContractDocument } from "./types.js";

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

export function validateModuleMapping(id: string, directory: unknown): asserts directory is string {
  moduleDocumentPath(id);
  if (typeof directory !== "string" || directory !== "." &&
      (!directory.split("/").every(portableName) || excludedProjectPath(directory))) {
    throw new Error("Invalid project directory for " + id + ": " + String(directory));
  }
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
      validateModuleMapping(id, directory);
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
