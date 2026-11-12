import type { SnapshotData } from "../snapshots/types.js";
import type { Contract } from "../contracts/types.js";
import type {
  ModuleState,
  DependencySelector,
  DependencyCoverage,
  DependencyInput,
  ReviewState,
  ReviewInputs,
  ReviewOptions,
} from "./types.js";
import { canonical, digest } from "../serialization/digest.js";
import { SEMANTIC_FIELDS, sorted, normalizeText, type ModuleStateContext, fileInput, baselineIdentity } from "./module-state.js";

/**
 * Явные зависимости — селекторы реально сохранённых данных. API допускается
 * только как отдельный файл: неизменность arch.yaml не доказывает неизменность
 * API реализации. Произвольный digest без разрешимого источника не принимается.
 */
function dependencyInput(selector: DependencySelector, snapshot: SnapshotData | null, states: Map<string, ModuleState>, contractScope: string): DependencyInput {
  const kind = selector.kind;
  const module = selector.module_id ? states.get(selector.module_id!) : null;
  if (kind === "contract") {
    if (!module?.technical.contract) return { selector: structuredClone(selector), available: false };
    const fields = selector.fields ? sorted(selector.fields) : SEMANTIC_FIELDS;
    const contract = module.technical.contract;
    const content = Object.fromEntries(fields.filter((key) => Object.hasOwn(contract, key))
      .map((key) => [key, structuredClone(contract[key as keyof Contract])]));
    return { selector: structuredClone(selector), available: true, digest: digest(content), content };
  }
  if (kind === "module") {
    if (contractScope === "own") {
      const selected = module ? sorted([...states.values()].filter((item) => item.module_id === module.module_id ||
        selector.scope === "subtree" && (module.directory === "." || item.directory.startsWith(module.directory + "/"))), (item) => item.module_id) : [];
      return { selector: structuredClone(selector), available: Boolean(module) && selected.every((item) => reviewModuleComplete(item, contractScope)),
        ...(module ? { digest: digest(selector.scope === "subtree" ? selected.map((item) =>
          ({ module_id: item.module_id, state: reviewProjection(item, contractScope) })) : reviewProjection(module, contractScope)) } : {}) };
    }
    return { selector: structuredClone(selector), available: Boolean(module) && module!.complete,
      ...(module ? { digest: selector.scope === "subtree" ? module.semantic_subtree_digest : module.self_digest } : {}) };
  }
  if (["file", "api"].includes(kind)) {
    const owner = (snapshot?.modules ?? []).find((item) => (item.files ?? []).some((file) => file.path === selector.path));
    const file = owner?.files.find((item) => item.path === selector.path);
    const fact = snapshot?.facts?.find((item) => item.kind === "file" && item.path === selector.path && typeof item.text === "string");
    return { selector: structuredClone(selector), available: Boolean(file) && !file!.error && Boolean(fact),
      ...(file ? { digest: fileInput(snapshot, file).digest } : {}),
      ...(fact ? { content: normalizeText(fact.text) } : {}) };
  }
  throw new Error("Unsupported dependency kind: " + kind);
}

/**
 * Техническая модель сохраняет прежнее происхождение и контекст снимка.
 * Собственный чеклист не содержит пунктов предков. Их границы и контракты детей
 * сохраняются как контекст; актуальность локального анализа оценивается отдельно.
 */
function reviewProjection(state: ModuleState, contractScope: string) {
  const projection = structuredClone(state.self);
  if (contractScope === "own") delete projection.inherited;
  return projection;
}

/** Для локальной проверки нужны свой контракт, свои файлы и контракты композиции. */
function reviewModuleComplete(state: ModuleState, contractScope: string) {
  if (contractScope !== "own") return state.complete;
  return state.technical.document_state === "documented" && Boolean(state.technical.contract) &&
    state.self.own_files.every((file) => !file.error && file.normalization === "text-lf/v1") &&
    state.self.children.every((child) => child.document_state === "documented" && child.contract);
}

/** Самостоятельная self-проекция не содержит реализацию потомков или контекст предков. */
export function reviewState(snapshot: SnapshotData | null, id: string, scope: string, selectors: DependencySelector[], dependencyCoverage: DependencyCoverage, contractScope: string, context: ModuleStateContext): ReviewState {
  const states = context.states(snapshot);
  const state = states.get(id);
  const descendants = state && scope === "subtree" ? sorted([...states.values()].filter((item) =>
    item.module_id === id || state.directory === "." || item.directory.startsWith(state.directory + "/")), (item) => item.module_id) : [];
  return { exists: Boolean(state), state: state ? reviewProjection(state, contractScope) : null,
    ...(scope === "subtree" ? { subtree: descendants.map((item) => ({ module_id: item.module_id, state: reviewProjection(item, contractScope) })) } : {}),
    complete: snapshot?.complete !== false && (!state || reviewModuleComplete(state, contractScope)) &&
      (!state || state.self.own_files.every((file) => file.normalization === "text-lf/v1")) &&
      descendants.every((item) => reviewModuleComplete(item, contractScope) && item.self.own_files.every((file) => file.normalization === "text-lf/v1")),
    dependencies: sorted(selectors.map((selector) => dependencyInput(selector, snapshot, states, contractScope)), (item) => canonical(item.selector)),
    dependency_coverage: structuredClone(dependencyCoverage) };
}

/** Готовит независимые current/change входы; полнота dependencies всегда явная. */
export function createInputs(baseline: SnapshotData | null, current: SnapshotData, id: string, options: ReviewOptions, semantic: boolean, context: ModuleStateContext): ReviewInputs {
  const scope = options.scope ?? "self";
  if (!["self", "subtree"].includes(scope)) throw new Error("Unsupported review scope: " + scope);
  const contractScope = options.contractScope ?? "effective";
  if (!["own", "effective"].includes(contractScope)) throw new Error("Unsupported contract scope");
  const dependencies = options.dependencies ?? [];
  const declaredCoverage = options.dependencyCoverage ?? options.dependency_coverage ??
    { status: semantic ? "unknown" : "complete", potential_influence: semantic ? [{ scope: "project" }] : [] };
  const coverage = { ...structuredClone(declaredCoverage), potential_influence: structuredClone(declaredCoverage.potential_influence ??
    (declaredCoverage.status === "complete" ? [] : [{ scope: "project" }])) };
  if (!["complete", "unknown"].includes(coverage.status)) throw new Error("Invalid dependency coverage");
  const result: ReviewInputs = { schema_version: 1, scope, ...(contractScope === "own" ? { contract_scope: "own" } : {}),
    current: reviewState(current, id, scope, dependencies, coverage, contractScope, context),
    baseline: baseline ? reviewState(baseline, id, scope, dependencies, coverage, contractScope, context) : null,
    baseline_identity: baselineIdentity(baseline, context) };
  result.current_digest = digest(result.current);
  result.change_digest = digest({ baseline_identity: result.baseline_identity, baseline: result.baseline, current: result.current });
  return result;
}
