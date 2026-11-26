import type { ModuleSummary } from "../view-model/types.js";
import { treeParents } from "../view-model/tree-paths.js";

type CountedModule = Pick<ModuleSummary, "key" | "directory" | "status" | "analyses" | "dependencyCycleCount"> & {
  review?: { activeFindings?: number; findings?: number; assessment?: { current?: { verdict: string } } } | null;
};

/** Older summaries may only carry the assessment or the total number of findings. */
export function moduleFindingCount(module: Pick<CountedModule, "review" | "analyses">) {
  if (module.analyses) return Object.values(module.analyses).reduce((sum, value) => sum + value.openFindings, 0);
  return module.review?.activeFindings ?? (module.review?.findings ||
    Number(module.review?.assessment?.current?.verdict === "violation"));
}

/** Свёрнутая строка включает замечания видимых потомков своей стороны сравнения. */
export function treeFindingCounts(modules: CountedModule[], expanded: Set<string>, parents = treeParents(modules),
  countFor: (module: CountedModule) => number = moduleFindingCount) {
  const counts = new Map(modules.map((module) => [module.key, countFor(module)]));
  for (const module of modules) {
    const count = countFor(module);
    if (!count || module.directory === ".") continue;
    let parent = parents.get(module.key);
    while (parent) {
      if (!expanded.has(parent.key)) counts.set(parent.key, (counts.get(parent.key) ?? 0) + count);
      parent = parents.get(parent.key);
    }
  }
  return counts;
}
