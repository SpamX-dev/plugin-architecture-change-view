import path from "node:path";
import {
  assertModuleDirectory, mappedContractDocument, MODULE_DIRECTORY, MODULE_TREE_FILE,
  moduleDocumentPath, parseModuleTree,
} from "../contracts/module-tree.js";
import { SOURCE_EXTENSIONS } from "../contracts/source-files.js";
import type { ContractDocument } from "../contracts/types.js";
import { errorDetails } from "../runtime/errors.js";
import { structureHash } from "./identity.js";
import type { FileRecord, SnapshotModule } from "./types.js";

export const isSource = (file: string) => SOURCE_EXTENSIONS.has(path.posix.extname(file).toLowerCase());

function addAncestors(directories: Set<string>, directory: string) {
  while (!directories.has(directory)) {
    directories.add(directory);
    if (directory === ".") break;
    directory = path.posix.dirname(directory);
  }
}

export interface WorkingLayout {
  root: string;
  ownsDirectory(directory: string): Promise<boolean>;
}

/** Resolve ownership using the map captured from this exact tree. Only working snapshots inspect live paths. */
export async function snapshotModules(records: FileRecord[], diagnostics: string[], working?: WorkingLayout) {
  const byPath = new Map(records.map((record) => [record.path, record]));
  const treeFile = byPath.get(MODULE_TREE_FILE);
  let tree = new Map<string, string>();
  let treeError: string | undefined;
  if (treeFile) {
    try {
      if (treeFile.error) throw new Error(treeFile.error);
      tree = parseModuleTree(treeFile.text ?? "");
    }
    catch (cause) {
      treeError = MODULE_TREE_FILE + ": " + (treeFile.error ?? errorDetails(cause).message);
      diagnostics.push(treeError);
    }
  }
  if (working) {
    for (const directory of tree.keys()) {
      if (!await working.ownsDirectory(directory)) {
        tree.delete(directory);
        diagnostics.push(MODULE_TREE_FILE + ": " + directory + " is outside the repository's source directories");
      }
    }
  }
  const mappedOwners = new Map([...tree].map(([directory, id]) => [moduleDocumentPath(id), directory]));
  const directories = new Set(["."]);
  const observedDirectories = new Set(["."]);
  for (const directory of tree.keys()) addAncestors(directories, directory);
  for (const record of records) {
    if (record.path === MODULE_TREE_FILE || record.path.startsWith(MODULE_DIRECTORY + "/")) continue;
    const directory = path.posix.dirname(record.path);
    addAncestors(observedDirectories, directory);
    if (isSource(record.path)) addAncestors(directories, directory);
  }
  const modules = new Map<string, SnapshotModule>();
  for (const directory of [...directories].sort()) {
    const id = tree.get(directory);
    const documentPath = id ? moduleDocumentPath(id) : MODULE_TREE_FILE;
    let document: ContractDocument = { state: "missing", text: null };
    if (treeError) {
      document = { state: "invalid", text: null, errors: [treeError] };
    } else if (id) {
      const record = byPath.get(documentPath);
      if (!record) diagnostics.push("Missing registered contract: " + documentPath);
      else if (record.error) document = { state: "unreadable", text: null, errors: [record.error] };
      else document = mappedContractDocument(record.text ?? "", id);
      try {
        if (working) await assertModuleDirectory(working.root, directory);
        else if (!observedDirectories.has(directory)) throw new Error("Missing mapped directory: " + directory);
      } catch (cause) {
        const message = directory + ": " + errorDetails(cause).message;
        diagnostics.push(message);
        document = { state: "unreadable", text: null, errors: [message] };
      }
    }
    modules.set(directory, { directory, document, documentPath, files: [], sourceFiles: 0, fingerprint: "" });
  }
  for (const record of records) {
    if (record.path === MODULE_TREE_FILE) continue;
    let owner = mappedOwners.get(record.path);
    if (!owner && record.path.startsWith(MODULE_DIRECTORY + "/")) {
      if (!treeError) diagnostics.push(record.path + " is not registered in " + MODULE_TREE_FILE);
      continue;
    }
    owner ??= path.posix.dirname(record.path);
    while (!modules.has(owner)) owner = path.posix.dirname(owner);
    const module = modules.get(owner)!;
    module.files.push({ path: record.path, hash: record.hash, error: record.error, ...(record.mode ? {mode: record.mode} : {}) });
    if (isSource(record.path)) module.sourceFiles++;
  }
  for (const module of modules.values()) {
    module.files.sort((a, b) => a.path.localeCompare(b.path));
    module.fingerprint = structureHash(JSON.stringify(module.files));
  }
  return [...modules.values()];
}
