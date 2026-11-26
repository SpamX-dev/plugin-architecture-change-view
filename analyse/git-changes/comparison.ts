import path from "node:path";
import { readGitTreeRecords } from "./git-tree.js";
import type { Comparison, ComparisonModule, FileChange, Snapshot, SnapshotModule, SourceFile } from "../../framework/snapshots/types.js";
import { snapshotDigest, structureHash } from "../../framework/snapshots/identity.js";
import { digest } from "../../framework/serialization/digest.js";
import { MODULE_TREE_FILE } from "../../framework/project/storage-paths.js";

/** Идентичность пары и результата сохраняется при новом времени захвата или переносе каталога. */
export function comparisonId(report: Omit<Comparison, "id">) {
  return digest({ domain: "archiview/git-changes/v1", origin: report.origin, emptyTree: report.emptyTree,
    baseline: [report.before.id, report.before.digest], current: [report.after.id, report.after.digest],
    complete: report.complete, diagnostics: report.diagnostics,
    changes: report.modules.map(module => [module.key, module.baselinePath, module.currentPath, module.status, module.files]) }).slice(7, 31);
}

type ModeReader = (file: SourceFile) => string | undefined;
type ComparisonOptions = { projectRoot?: string; emptyTree?: boolean };
type FileScope = "module" | "repository";
type ModulePair = [SnapshotModule | null, SnapshotModule | null];
interface SnapshotFiles {
  modules: SnapshotModule[];
  mode: ModeReader;
  mapKnown: boolean;
}

function gitTreeRevision(snapshot: Snapshot) {
  // Saved and imported Git snapshots retain revision. A working snapshot's baseRevision names its parent.
  if (["git", "index", "saved", "change"].includes(snapshot.kind) && snapshot.revision &&
      /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(snapshot.revision)) return snapshot.revision;
}

function recordedMode(snapshot: Snapshot | null): ModeReader {
  // The earliest Git captures omitted every mode. A later writer recorded 100755 only.
  const sparseGitModes = snapshot && gitTreeRevision(snapshot) &&
    snapshot.modules.some(m => m.files.some(f => f.mode === "100755")) &&
    !snapshot.modules.some(m => m.files.some(f => f.mode === "100644"));
  return file => file.mode ?? (sparseGitModes ? "100644" : undefined);
}

function snapshotFiles(snapshot: Snapshot | null): SnapshotFiles {
  const modules = snapshot?.modules ?? [];
  const rootModule = modules.find(module => module.directory === ".");
  const mapKnown = !snapshot || rootModule?.moduleMapAbsent === true || Boolean(rootModule?.files.some(file => file.path === MODULE_TREE_FILE));
  return { modules, mode: recordedMode(snapshot), mapKnown };
}

async function repositoryFiles(root: string, snapshot: Snapshot): Promise<SnapshotFiles> {
  const recorded = snapshotFiles(snapshot);
  const revision = gitTreeRevision(snapshot);
  if (!revision || (recorded.mapKnown && !snapshot.modules.some(m => m.files.some(f => recorded.mode(f) === undefined)))) return recorded;
  try {
    const { records } = await readGitTreeRecords(root, revision);
    const mode: ModeReader = file => {
      const entry = records.get(file.path);
      return recorded.mode(file) ?? (entry && entry.hash === file.hash ? entry.mode : undefined);
    };
    const map = records.get(MODULE_TREE_FILE);
    let modules = recorded.modules;
    if (!recorded.mapKnown && map) {
      modules = modules.map(module => {
        if (module.directory !== ".") return module;
        const files = [...module.files, map].sort((a, b) => a.path.localeCompare(b.path));
        return { ...module, files, fingerprint: structureHash(JSON.stringify(files)) };
      });
    }
    return { modules, mode, mapKnown: true };
  } catch {
    // A portable archive can outlive its Git object.
    return recorded;
  }
}

async function compareRecordedSnapshots(root: string, before: Snapshot | null, after: Snapshot, options: ComparisonOptions, fileScope: FileScope) {
  const display = { projectRoot: root, ...options };
  const [oldFiles, newFiles] = await Promise.all([
    before ? repositoryFiles(root, before) : snapshotFiles(null),
    repositoryFiles(root, after),
  ]);
  return compareWithFiles(before, after, display, oldFiles, newFiles, fileScope);
}

export function compareRepositorySnapshots(root: string, before: Snapshot | null, after: Snapshot, options: ComparisonOptions = {}) {
  return compareRecordedSnapshots(root, before, after, options, "module");
}

/** A file's identity in a Git report is its repository-relative path across both snapshots. */
export function compareGitFiles(root: string, before: Snapshot | null, after: Snapshot, options: ComparisonOptions = {}) {
  return compareRecordedSnapshots(root, before, after, options, "repository");
}

function changedFiles(before: SourceFile[], after: SourceFile[],
  oldMode: ModeReader, newMode: ModeReader, unknownModes: string[], mapKnown: boolean): FileChange[] {
  const oldFiles = new Map(before.map((file) => [file.path, file]));
  const newFiles = new Map(after.map((file) => [file.path, file]));
  return [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort().flatMap((file: string) => {
    if (file === MODULE_TREE_FILE && !mapKnown) return [];
    const previous = oldFiles.get(file);
    const current = newFiles.get(file);
    if (previous && current && previous.hash === current.hash) {
      const left = oldMode(previous), right = newMode(current);
      if (left === undefined || right === undefined) {
        unknownModes.push(file);
        return [];
      }
      if (left === right) return [];
    }
    return [{ path: file, status: !previous ? "new" : !current ? "removed" : "changed" }];
  });
}

function repositoryFileChanges(before: SnapshotFiles, after: SnapshotFiles, pairs: ModulePair[], unknownModes: string[]) {
  const owners = new Map<string, SnapshotModule>();
  // For a deletion, keep the former owner's row, including when that module moved.
  for (const [previous, current] of pairs) {
    if (previous) for (const file of previous.files) owners.set(file.path, current ?? previous);
  }
  for (const module of after.modules) for (const file of module.files) owners.set(file.path, module);
  const changes = changedFiles(before.modules.flatMap(module => module.files), after.modules.flatMap(module => module.files),
    before.mode, after.mode, unknownModes, before.mapKnown && after.mapKnown);
  const byModule = new Map<SnapshotModule, FileChange[]>();
  for (const change of changes) {
    const owner = owners.get(change.path)!;
    const group = byModule.get(owner) ?? [];
    group.push(change);
    byModule.set(owner, group);
  }
  return byModule;
}

/**
 * Сравнивает объединение модулей двух снимков. Родитель сохраняет собственный
 * статус, а число изменённых потомков передаётся отдельным полем.
 */
export function compareSnapshots(before: Snapshot | null, after: Snapshot, options: ComparisonOptions = {}) {
  return compareWithFiles(before, after, options, snapshotFiles(before), snapshotFiles(after));
}

function compareWithFiles(before: Snapshot | null, after: Snapshot, { projectRoot = after.root, emptyTree = false }: ComparisonOptions,
  oldFiles: SnapshotFiles, newFiles: SnapshotFiles, fileScope: FileScope = "module") {
  if (before && before.root !== after.root) throw new Error("Snapshots belong to different projects");
  const previous = new Map(oldFiles.modules.map((module) => [module.directory, module]));
  const current = new Map(newFiles.modules.map((module) => [module.directory, module]));
  const identity = (m: SnapshotModule | null | undefined) => m?.document.state === "documented" ? m.document.contract?.id : null;
  const oldIds = new Map([...previous.values()].filter(identity).map((m) => [identity(m), m]));
  const currentIds = new Set([...current.values()].map(identity).filter(Boolean));
  const matched = new Set<string>();
  const pairs: ModulePair[] = [...current.values()].map((m) => {
    const byId = identity(m) ? oldIds.get(identity(m)) : null;
    const byPath = previous.get(m.directory);
    const prior = byId ?? (identity(m) && identity(byPath) && identity(m) !== identity(byPath) ? null :
      byPath && !matched.has(byPath.directory) && (!identity(byPath) || !currentIds.has(identity(byPath))) ? byPath : null);
    if (prior) matched.add(prior.directory);
    return [prior ?? null, m];
  });
  for (const m of previous.values()) if (!matched.has(m.directory)) pairs.push([m, null]);
  const unknownModes: string[] = [];
  const repositoryChanges = fileScope === "repository" ? repositoryFileChanges(oldFiles, newFiles, pairs, unknownModes) : undefined;
  const modules = pairs.map(([oldModule, newModule]): ComparisonModule => {
    const entry = newModule ?? oldModule;
    if (!entry) throw new Error("Missing comparison module");
    const directory = entry.directory;
    const files = repositoryChanges
      ? repositoryChanges.get(entry) ?? []
      : changedFiles(oldModule?.files ?? [], newModule?.files ?? [], oldFiles.mode, newFiles.mode, unknownModes, oldFiles.mapKnown && newFiles.mapKnown);
    return { key: "", directory, name: directory === "." ? path.basename(projectRoot) :
      path.posix.basename(directory),
      moduleId: identity(newModule ?? oldModule),
      title: entry.document.contract?.title,
      baselinePath: oldModule?.directory ?? null, currentPath: newModule?.directory ?? null,
      moved: Boolean(oldModule && newModule && oldModule.directory !== newModule.directory),
      status: !before && !emptyTree ? "initial" : !oldModule ? "new" : !newModule ? "removed" : files.length ? "changed" : "unchanged",
      documentState: entry.document.state,
      documentChanged: JSON.stringify(oldModule?.document ?? { state: "missing", text: null }) !==
        JSON.stringify(newModule?.document ?? { state: "missing", text: null }),
      sourceFiles: entry.sourceFiles,
      filesChanged: files.length, descendantChanges: 0, files,
      before: oldModule ?? null, after: newModule ?? null };
  }).sort((a, b) => a.directory.localeCompare(b.directory) || a.status.localeCompare(b.status));
  const pathCounts = new Map();
  for (const module of modules) pathCounts.set(module.directory, (pathCounts.get(module.directory) ?? 0) + 1);
  for (const module of modules) module.key = module.directory + (pathCounts.get(module.directory) > 1 ? "::" + module.status : "");
  const oldPaths = new Map(modules.map((module) => [module.baselinePath, module]));
  const newPaths = new Map(modules.map((module) => [module.currentPath, module]));
  for (const module of modules) {
    if (module.status === "initial" || module.status === "unchanged" && !module.moved) continue;
    const ancestors = new Set<ComparisonModule>();
    for (const [directory, paths] of [[module.baselinePath, oldPaths], [module.currentPath, newPaths]] as const) {
      if (directory === null) continue;
      let parent = directory;
      while (parent !== ".") {
        parent = path.posix.dirname(parent);
        const ancestor = paths.get(parent);
        if (ancestor) ancestors.add(ancestor);
      }
    }
    for (const ancestor of ancestors) ancestor.descendantChanges++;
  }
  const diagnostics = [...before?.diagnostics ?? [], ...after.diagnostics];
  const sameSnapshot = before && before.id === after.id && before.digest === after.digest;
  const beforeRevision = before && gitTreeRevision(before);
  const sameGitTree = beforeRevision && beforeRevision === gitTreeRevision(after);
  if ((!oldFiles.mapKnown || !newFiles.mapKnown) && !sameSnapshot && !sameGitTree) {
    diagnostics.push("Изменение " + MODULE_TREE_FILE + " установить не удалось. В прежнем снимке карта не учитывалась как файл.");
  }
  if (unknownModes.length && !sameSnapshot && !sameGitTree) {
    const examples = unknownModes.slice(0, 3).join(", ");
    diagnostics.push(`Смену исполняемого бита установить не удалось. Число файлов с одинаковым содержимым и неизвестным режимом — ${unknownModes.length}, включая ${examples}.`);
  }
  const report = { schema_version: 2, origin: after.root, emptyTree: !before && emptyTree,
    root: projectRoot, before: before ? { id: before.id, label: before.label, kind: before.kind,
      digest: before.digest ?? snapshotDigest(before), capturedAt: before.capturedAt } :
      { id: "initial", label: emptyTree ? "Пустое дерево" : "Первый анализ", kind: "initial" },
    after: { id: after.id, digest: after.digest ?? snapshotDigest(after), capturedAt: after.capturedAt },
    complete: (before?.complete ?? true) && after.complete,
    diagnostics,
    counts: Object.fromEntries(["initial", "new", "changed", "removed", "unchanged"].map((status) =>
      [status, modules.filter((module) => module.status === status).length])),
    modules };
  return { ...report, id: comparisonId(report) };
}
