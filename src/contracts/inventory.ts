import { realpath } from "node:fs/promises";
import path from "node:path";
import { discoverWorkspaceRepositories, locateSourceRepository, resolveWorkspaceRepository } from "../project/workspace.js";
import { errorDetails } from "../runtime/errors.js";
import type { ModuleDocument } from "./module-tree.js";
import {
  assertModuleDirectory, ADD_MAPPING, listModuleContractPaths,
  MODULE_TREE_FILE, moduleDocumentPath, readContractStorageFile, readModuleTree, resolveModuleDocument,
} from "./module-tree.js";
import { excludedProjectPath, portable, projectFiles, regularProjectFile, SOURCE_EXTENSIONS } from "./source-files.js";

export { excludedProjectPath, projectFiles, regularProjectFile, SOURCE_EXTENSIONS } from "./source-files.js";

interface InventoryModule extends ModuleDocument {
  repository?: string;
  sourceFiles?: number;
  required?: boolean;
  files?: string[];
  preparation?: string;
}

async function documentAt(root: string, directory: string, id?: string): Promise<InventoryModule> {
  await assertModuleDirectory(root, directory);
  const text = id ? await readContractStorageFile(root, moduleDocumentPath(id)) : null;
  return resolveModuleDocument(directory, id, text);
}

function includeDirectory(directories: Map<string, number>, directory: string, source: boolean) {
  while (true) {
    directories.set(directory, (directories.get(directory) ?? 0) + Number(source));
    if (directory === ".") return;
    directory = path.posix.dirname(directory);
  }
}

/** Inventories source paths and mapped resources, and reports broken central storage explicitly. */
interface InventoryOptions { extensions?: Set<string>; maxFiles?: number }

async function repositoryInventory(root: string, options: InventoryOptions, nested: string[]) {
  const extensions = options.extensions ?? SOURCE_EXTENSIONS;
  const owned = (relative: string) => !nested.some((child) => relative === child || relative.startsWith(child + "/"));
  const listed = await projectFiles(root, options.maxFiles ?? 50000, owned);
  const directories = new Map<string, number>();
  const sourcePaths: string[] = [];
  let tree = new Map<string, string>();
  let treeError: string | undefined;
  try {
    tree = await readModuleTree(root);
  } catch (cause) {
    treeError = MODULE_TREE_FILE + ": " + errorDetails(cause).message;
    listed.diagnostics.push(treeError);
    listed.complete = false;
  }
  for (const directory of tree.keys()) {
    if (owned(directory)) includeDirectory(directories, directory, false);
    else {
      listed.complete = false;
      listed.diagnostics.push(MODULE_TREE_FILE + ": " + directory + " belongs to a nested repository");
    }
  }
  if (!treeError) {
    try {
      const registered = new Set([...tree.values()].map(moduleDocumentPath));
      for (const file of await listModuleContractPaths(root)) {
        if (!registered.has(file)) {
          listed.diagnostics.push(file + " is not registered in " + MODULE_TREE_FILE);
          listed.complete = false;
        }
      }
    } catch (cause) {
      listed.diagnostics.push(errorDetails(cause).message);
      listed.complete = false;
    }
  }
  for (const file of listed.files) {
    if (!extensions.has(path.extname(file).toLowerCase())) continue;
    try {
      if (!await regularProjectFile(root, file)) continue;
    } catch (cause) {
      listed.complete = false;
      listed.diagnostics.push(file + ": " + errorDetails(cause).message);
      continue;
    }
    const relative = portable(file);
    sourcePaths.push(relative);
    includeDirectory(directories, path.posix.dirname(relative), true);
  }
  const modules: InventoryModule[] = [];
  for (const [directory, sourceFiles] of [...directories].sort(([a], [b]) => a.localeCompare(b))) {
    const id = tree.get(directory);
    let entry: InventoryModule;
    try {
      if (treeError) {
        entry = { directory, document: MODULE_TREE_FILE, status: "invalid", errors: [treeError] };
      } else {
        const { text, ...document } = await documentAt(root, directory, id);
        entry = document;
        if (id && entry.status === "missing") {
          listed.diagnostics.push(directory + ": missing " + entry.document);
          listed.complete = false;
        }
      }
    } catch (cause) {
      const message = directory + ": " + errorDetails(cause).message;
      listed.diagnostics.push(message);
      listed.complete = false;
      entry = { directory, document: id ? moduleDocumentPath(id) : MODULE_TREE_FILE,
        status: "unreadable", errors: [message] };
    }
    entry.sourceFiles = sourceFiles;
    entry.required = sourceFiles > 0;
    entry.files = sourcePaths.filter((file) => path.posix.dirname(file) === directory);
    entry.preparation = entry.status === "documented" ? "ready" :
      entry.status === "missing" && !id ? "analyze_and_write" : "repair";
    modules.push(entry);
  }
  const inventory = { schema_version: 1, root, complete: listed.complete, discovery: listed.discovery,
    sourceFiles: sourcePaths.length, modules, diagnostics: listed.diagnostics,
    preparation: "Исправьте ошибки карты и контрактов. Для нового модуля изучите исходники и контракты предков. " + ADD_MAPPING };
  return { inventory, scannedFiles: listed.files.length };
}

/** A workspace lists modules by repository; contract ids stay local to that repository. */
export async function moduleInventory(projectRoot: string, options: InventoryOptions = {}) {
  const root = await realpath(projectRoot);
  const repositories = await discoverWorkspaceRepositories(root);
  if (!repositories.length) throw new Error("Для ArchiView требуется рабочее дерево Git");
  if (repositories.length === 1 && repositories[0] === ".") {
    const { inventory } = await repositoryInventory(root, options, []);
    return { ...inventory, repositories };
  }
  const modules: InventoryModule[] = [];
  const diagnostics: string[] = [];
  let sourceFiles = 0;
  let complete = true;
  let remaining = options.maxFiles ?? 50000;
  for (const repository of repositories) {
    if (remaining <= 0) {
      complete = false;
      diagnostics.push("File limit reached before repository " + repository);
      break;
    }
    const nested = repositories.filter((child) => child !== repository &&
      (repository === "." || child.startsWith(repository + "/")))
      .map((child) => path.posix.relative(repository, child));
    const { inventory: result, scannedFiles } = await repositoryInventory(
      await resolveWorkspaceRepository(root, repository), { ...options, maxFiles: remaining }, nested);
    remaining -= scannedFiles;
    const prefix = (item: string) => path.posix.join(repository, item);
    modules.push(...result.modules.map((item) => ({ ...item, repository, directory: prefix(item.directory),
      document: prefix(item.document), files: item.files?.map(prefix) })));
    diagnostics.push(...result.diagnostics.map((message) => repository + ": " + message));
    complete &&= result.complete;
    sourceFiles += result.sourceFiles;
  }
  return { schema_version: 1, root, discovery: "workspace", repositories, complete, sourceFiles, modules, diagnostics,
    preparation: "Изменяйте карту и контракты в репозитории, указанном в поле repository модуля." };
}

/** Resolve either a file or a directory, then read the chain inside its owning repository. */
export async function moduleContext(projectRoot: string, sourcePath = ".") {
  const { root, directory, workspaceRoot, repository, existingDirectory } = await locateSourceRepository(projectRoot, sourcePath);
  const tree = await readModuleTree(root);
  const chain = [];
  let current = directory;
  while (true) {
    const id = tree.get(current);
    const exists = current === "." || existingDirectory === current || existingDirectory.startsWith(current + "/");
    if (exists) chain.push(await documentAt(root, current, id));
    else chain.push({ ...resolveModuleDocument(current, id, null),
      action: "Каталог ещё не создан. " + ADD_MAPPING });
    if (current === ".") break;
    current = path.posix.dirname(current);
  }
  return { schema_version: 1, root, directory, workspaceRoot, repository, contracts: chain.reverse() };
}
