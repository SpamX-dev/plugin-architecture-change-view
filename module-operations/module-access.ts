import path from "node:path";
import { captureGitIndex, readGitHeadRevision } from "../analyse/git-changes/capture.js";
import { GitTreeReader } from "../analyse/git-changes/git-tree.js";
import { compareGitFiles } from "../analyse/git-changes/comparison.js";
import type { SnapshotStore } from "../analyse/git-changes/snapshot-store.js";
import { discoverWorkspaceRepositories, hasModuleMap, resolveWorkspaceRepository } from "../analyse/project/workspace.js";
import { MODULE_TREE_FILE } from "../framework/contracts/module-tree.js";
import { isModuleDocumentFile } from "../framework/project/storage-paths.js";
import type { SnapshotModule } from "../framework/snapshots/types.js";
import { ApplicationError } from "./errors.js";
import { writeModuleContract } from "./prototypes.js";

export interface ModuleSelection { repository?: string; target?: string }

async function selectedProject(workspace: string, repository?: string) {
  if (repository === undefined) {
    const repositories = await discoverWorkspaceRepositories(workspace);
    if (!repositories.length) throw new ApplicationError("REPOSITORY_UNAVAILABLE", "В выбранной папке нет репозитория Git");
    if (repositories.length !== 1) throw new ApplicationError("INVALID_ARGUMENT", "Укажите репозиторий модуля");
    [repository] = repositories;
  }
  try {
    return { root: await resolveWorkspaceRepository(workspace, repository), repository };
  } catch (cause) {
    throw new ApplicationError("REPOSITORY_UNAVAILABLE", cause instanceof Error ? cause.message : "Репозиторий недоступен");
  }
}

async function readSnapshot(root: string, target = "current", snapshotRoot = root) {
  const reader = new GitTreeReader(root, snapshotRoot);
  if (target === "current") return reader.working(await readGitHeadRevision(root));
  if (target === "index") {
    const snapshot = await captureGitIndex(root, { snapshotRoot });
    if (!snapshot) throw new ApplicationError("NOT_FOUND", "Индекс Git недоступен");
    return { ...snapshot, kind: "index", id: "index-" + snapshot.revision, label: "Индекс Git" };
  }
  if (!/^git-(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(target))
    throw new ApplicationError("INVALID_ARGUMENT", "Укажите current, index или git-<полный хеш>");
  return reader.revision(target.slice(4));
}

/** Save the selected Git states before any later edits can change the file report. */
export async function saveGitComparison(store: SnapshotStore, baseline = "HEAD", target = "current") {
  const head = baseline === "HEAD" || target === "HEAD" ? await readGitHeadRevision(store.root) : null;
  const headId = head && "git-" + head;
  const from = baseline === "HEAD" ? headId : baseline;
  const to = target === "HEAD" ? headId : target;
  if (to === null) throw new ApplicationError("NOT_FOUND", "В репозитории ещё нет HEAD");
  const snapshot = (id: string) => readSnapshot(store.root, id, store.snapshotRoot);
  const before = from === null || from === "empty" ? null : await snapshot(from);
  const after = before && from === to ? before : await snapshot(to);
  const comparison = await compareGitFiles(store.root, before, after, { emptyTree: before === null });
  return store.saveComparison(comparison);
}

function moduleId(module: SnapshotModule) {
  return module.documentPath === MODULE_TREE_FILE ? null : path.posix.basename(module.documentPath, ".yaml");
}

/** List the selected checkout, including directories without registered contracts. */
export async function listModules(workspace: string, selection: ModuleSelection = {}) {
  const { root, repository } = await selectedProject(workspace, selection.repository);
  const snapshot = await readSnapshot(root, selection.target);
  return { projects: [{ repository, hasModuleMap: await hasModuleMap(root), complete: snapshot.complete,
    diagnostics: snapshot.diagnostics, modules: snapshot.modules.map(module => ({
      id: moduleId(module), directory: module.directory, documentState: module.document.state,
    })) }] };
}

async function selectedModule(workspace: string, selector: string, selection: ModuleSelection) {
  const { root } = await selectedProject(workspace, selection.repository);
  const snapshot = await readSnapshot(root, selection.target);
  const module = snapshot.modules.find(module => moduleId(module) === selector)
    ?? snapshot.modules.find(module => !moduleId(module) && module.directory === selector);
  if (!module) throw new ApplicationError("NOT_FOUND", "Модуль не найден: " + selector);
  return module;
}

export async function listModuleFiles(workspace: string, selector: string, selection: ModuleSelection = {}) {
  const module = await selectedModule(workspace, selector, selection);
  return { id: moduleId(module), directory: module.directory,
    files: module.files.filter(file => !isModuleDocumentFile(file.path, module.documentPath)).map(file => file.path) };
}

export async function getModuleContract(workspace: string, selector: string, selection: ModuleSelection = {}) {
  const module = await selectedModule(workspace, selector, selection);
  if (module.document.text === null) throw new ApplicationError("NOT_FOUND", "Контракт недоступен: " + selector);
  return module.document.text;
}

export async function saveModuleContract(workspace: string, id: string, text: string,
  selection: ModuleSelection & { directory?: string; expectedText?: string } = {}) {
  if ((selection.target ?? "current") !== "current")
    throw new ApplicationError("INVALID_ARGUMENT", "Контракт можно записать только в рабочем дереве");
  const { root } = await selectedProject(workspace, selection.repository);
  return writeModuleContract(root, id, text, selection.directory, selection.expectedText);
}
