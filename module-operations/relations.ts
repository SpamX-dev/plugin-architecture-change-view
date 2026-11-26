import { moduleRelations, supportsFile } from "../analyse/module-relations/graph.js";
import { dependencyCycles } from "../analyse/implementation/dependency-cycles.js";
import { readRelationGraph, rebuildRelationGraph, RelationBuildError } from "../analyse/module-relations/store.js";
import type { Snapshot, SnapshotModule } from "../framework/snapshots/types.js";
import type { DependencyCycleCheck } from "../framework/module-relations/types.js";
import { ApplicationError } from "./errors.js";

export async function getRelations(root: string, state: string | undefined, snapshot: Snapshot, directory: string | null) {
  return moduleRelations(await readRelationGraph(root, state, snapshot), snapshot, directory);
}

export async function getDependencyCycles(root: string, state: string | undefined, snapshot: Snapshot, module: SnapshotModule | null): Promise<DependencyCycleCheck> {
  if (!module) throw new ApplicationError("NOT_FOUND", "Модуль отсутствует в выбранном снимке.");
  if (!module.files.some(file => supportsFile(file.path))) return { status: "unsupported" };
  const graph = await readRelationGraph(root, state, snapshot);
  return graph ? { status: "checked", cycles: dependencyCycles(graph.edges, module.directory) } : { status: "unindexed" };
}

export async function buildRelations(root: string, state: string | undefined, snapshot: Snapshot, directory: string | null) {
  try { return moduleRelations(await rebuildRelationGraph(root, state, snapshot), snapshot, directory); }
  catch (cause) {
    if (cause instanceof RelationBuildError) throw new ApplicationError(cause.code, cause.message);
    throw cause;
  }
}

export async function getRelationSource(root: string, state: string | undefined, snapshot: Snapshot, file: string) {
  const graph = await readRelationGraph(root, state, snapshot);
  if (!graph || !Object.hasOwn(graph.sources, file)) throw new ApplicationError("NOT_FOUND", "В графе этого снимка нет текста файла.");
  return { text: graph.sources[file] };
}
