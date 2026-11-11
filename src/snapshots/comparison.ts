import path from "node:path";
import type { Snapshot, SnapshotModule, FileChange, ComparisonModule } from "./types.js";
import { structureHash, snapshotDigest } from "./identity.js";

/** Вычисляет изменения собственных файлов модуля, включая конфигурацию и документы. */
function changedFiles(before: SnapshotModule | null | undefined, after: SnapshotModule | null | undefined): FileChange[] {
  const oldFiles = new Map((before?.files ?? []).map((file) => [file.path, file]));
  const newFiles = new Map((after?.files ?? []).map((file) => [file.path, file]));
  return [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort().flatMap((file: string) => {
    const previous = oldFiles.get(file);
    const current = newFiles.get(file);
    if (previous && current && previous.hash === current.hash) return [];
    return [{ path: file, status: !previous ? "new" : !current ? "removed" : "changed" }];
  });
}

/**
 * Сравнивает объединение модулей двух снимков. Родитель сохраняет собственный
 * статус, а число изменённых потомков передаётся отдельным полем.
 */
export function compareSnapshots(before: Snapshot | null, after: Snapshot, { projectRoot = after.root } = {}) {
  if (before && before.root !== after.root) throw new Error("Snapshots belong to different projects");
  const previous = new Map((before?.modules ?? []).map((module) => [module.directory, module]));
  const current = new Map(after.modules.map((module) => [module.directory, module]));
  const identity = (m: SnapshotModule | null | undefined) => m?.document.state === "documented" ? m.document.contract?.id : null;
  const oldIds = new Map([...previous.values()].filter(identity).map((m) => [identity(m), m]));
  const currentIds = new Set([...current.values()].map(identity).filter(Boolean));
  const matched = new Set<string>();
  const pairs = [...current.values()].map((m) => {
    const byId = identity(m) ? oldIds.get(identity(m)) : null;
    const byPath = previous.get(m.directory);
    const prior = byId ?? (identity(m) && identity(byPath) && identity(m) !== identity(byPath) ? null :
      byPath && !matched.has(byPath.directory) && (!identity(byPath) || !currentIds.has(identity(byPath))) ? byPath : null);
    if (prior) matched.add(prior.directory);
    return [prior, m] as [SnapshotModule | null | undefined, SnapshotModule | null];
  });
  for (const m of previous.values()) if (!matched.has(m.directory)) pairs.push([m, null]);
  const modules = pairs.map(([oldModule, newModule]): ComparisonModule => {
    const entry = newModule ?? oldModule;
    if (!entry) throw new Error("Missing comparison module");
    const directory = entry.directory;
    const files = changedFiles(oldModule, newModule);
    return { key: "", directory, name: directory === "." ? path.basename(projectRoot) :
      path.posix.basename(directory),
      moduleId: identity(newModule ?? oldModule),
      title: entry.document.contract?.title,
      baselinePath: oldModule?.directory ?? null, currentPath: newModule?.directory ?? null,
      moved: Boolean(oldModule && newModule && oldModule.directory !== newModule.directory),
      status: !before ? "initial" : !oldModule ? "new" : !newModule ? "removed" : files.length ? "changed" : "unchanged",
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
  return { schema_version: 2, id: structureHash((before?.id ?? "initial") + after.digest).slice(0, 24),
    root: projectRoot, before: before ? { id: before.id, label: before.label, kind: before.kind,
      digest: before.digest ?? snapshotDigest(before), capturedAt: before.capturedAt } :
      { id: "initial", label: "Первый анализ", kind: "initial" },
    after: { id: after.id, digest: after.digest, capturedAt: after.capturedAt },
    complete: (before?.complete ?? true) && after.complete,
    diagnostics: [...before?.diagnostics ?? [], ...after.diagnostics],
    counts: Object.fromEntries(["initial", "new", "changed", "removed", "unchanged"].map((status) =>
      [status, modules.filter((module) => module.status === status).length])),
    modules };
}
