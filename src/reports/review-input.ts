import type { SnapshotData, ScopedSnapshot, Snapshot } from "../snapshots/types.js";
import type { ReviewReport } from "../reviews/types.js";
import type { ReviewOptions, ReviewEntry } from "./types.js";
import { digest } from "../serialization/digest.js";
import { createStructuralReview } from "../reviews/bundle.js";
import { randomUUID } from "node:crypto";
import { moduleId, ModuleStateContext } from "./module-state.js";
import { REPORT_SCHEMA_VERSION } from "./types.js";
import { technicalReport } from "./technical-report.js";
import { createInputs } from "./review-state.js";

/**
 * Native экспорт содержит только область проверки. Прежние snapshot id/digest
 * остаются происхождением, а scope_digest удостоверяет именно сохранённую часть.
 */
function scopedSnapshot(snapshot: SnapshotData | null, id: string, options: ReviewOptions, report: ReviewReport | null, context: ModuleStateContext): ScopedSnapshot | null {
  if (!snapshot) return null;
  const states = context.states(snapshot);
  const own = states.get(id);
  const ids = new Set([id]);
  if (own) {
    let parent = own.parent_id;
    while (parent !== null) { ids.add(parent); parent = states.get(parent)?.parent_id ?? null; }
    own.children.forEach((child) => ids.add(child));
    if (options.scope === "subtree") for (const state of states.values()) {
      if (own.directory === "." || state.directory.startsWith(own.directory + "/")) ids.add(state.module_id);
    }
  }
  const filePaths = new Set<string>();
  for (const selector of options.dependencies ?? []) {
    if (selector.module_id) ids.add(selector.module_id);
    if (selector.path) filePaths.add(selector.path);
    if (selector.kind === "module" && selector.scope === "subtree") {
      const dependency = states.get(selector.module_id!);
      if (dependency) for (const state of states.values()) if (dependency.directory === "." || state.directory.startsWith(dependency.directory + "/")) ids.add(state.module_id);
    }
  }
  const references = new Set((report ? [...report.checks.flatMap((check) => check.evidence),
    ...report.findings.flatMap((finding) => finding.evidence),
    ...Object.values(report.observed).flatMap((observation) => observation?.responsibilities.flatMap((item) => item.evidence) ?? [])] : [])
    .map((reference) => reference.fact_id));
  const fullIds = new Set([id]);
  if (options.scope === "subtree" && own) for (const state of states.values()) {
    if (own.directory === "." || state.directory.startsWith(own.directory + "/")) fullIds.add(state.module_id);
  }
  for (const selector of options.dependencies ?? []) if (selector.kind === "module") {
    fullIds.add(selector.module_id!);
    if (selector.scope === "subtree") {
      const dependency = states.get(selector.module_id!);
      if (dependency) for (const state of states.values()) if (dependency.directory === "." || state.directory.startsWith(dependency.directory + "/")) fullIds.add(state.module_id);
    }
  }
  // Контекст использованной реализации нужен для воспроизводимости её self
  // проекции. Контрактная зависимость, напротив, не затягивает реализацию.
  for (const fullId of fullIds) {
    const state = states.get(fullId);
    if (!state) continue;
    state.children.forEach((child) => ids.add(child));
    let parent = state.parent_id;
    while (parent !== null) { ids.add(parent); parent = states.get(parent)?.parent_id ?? null; }
  }
  const facts = (snapshot.facts ?? []).filter((fact) => references.has(fact.id) || filePaths.has(fact.path) ||
    (snapshot.modules ?? []).some((module) => ids.has(moduleId(module)) && fact.path === module.documentPath) ||
    (snapshot.modules ?? []).some((module) => fullIds.has(moduleId(module)) && (module.files ?? []).some((file) => file.path === fact.path)));
  const modules = snapshot.modules.filter((module) => ids.has(moduleId(module)) || (module.files ?? []).some((file) => filePaths.has(file.path)))
    .map((module) => ({ ...structuredClone(module), files: structuredClone((module.files ?? []).filter((file) => fullIds.has(moduleId(module)) || file.path === module.documentPath || filePaths.has(file.path))) }));
  const result: ScopedSnapshot = { schema_version: 2, id: snapshot.id, digest: snapshot.digest,
    kind: snapshot.kind, revision: snapshot.revision, complete: snapshot.complete,
    modules, facts: structuredClone(facts), diagnostics: structuredClone(snapshot.diagnostics ?? []),
    evidenceLimitations: structuredClone(snapshot.evidenceLimitations ?? []), scoped: true };
  if (snapshot.observations) result.observations = Object.fromEntries([...ids].filter(key => Object.hasOwn(snapshot.observations!, key))
    .map(key => [key, snapshot.observations![key]]));
  result.scope_digest = digest(result);
  return result;
}

/**
 * Экспорт для агента. Пустая модель/неполные зависимости — незавершённый шаблон,
 * который нельзя импортировать как подтверждённую LLM-попытку без заполнения.
 * report сохраняет известную схему checks/findings v1 для существующего UI.
 */
export function createReviewInput(projectId: string, baseline: Snapshot | null, current: Snapshot, id: string, options: ReviewOptions = {}): ReviewEntry {
  const context = new ModuleStateContext();
  options = { ...options, contractScope: options.contractScope ?? "own" };
  const states = context.states(current);
  const beforeStates = context.states(baseline);
  const state = states.get(id) ?? beforeStates.get(id);
  if (!state) throw new Error("Unknown review module: " + id);
  const beforeModule = baseline?.modules.find((module) => moduleId(module) === id) ?? null;
  const afterModule = current.modules.find((module) => moduleId(module) === id) ?? null;
  const comparison = { moduleId: id, directory: state.directory, baselinePath: beforeModule?.directory ?? null,
    currentPath: afterModule?.directory ?? null, before: beforeModule, after: afterModule };
  const bundle = createStructuralReview(baseline, current, comparison, options);
  bundle.report.id = options.reviewId ?? "review-" + randomUUID();
  bundle.report.analysis.analyzer = { name: "agent-review", version: "1", config_digest: digest({ method: "agent" }) };
  bundle.manifest.analyzer = structuredClone(bundle.report.analysis.analyzer);
  bundle.manifest.instructions = "Проверить собственную ответственность, границы и инварианты модуля, включая соответствие его реализации и контракта границам предков. Пункты предков не добавлять в собственный чеклист; противоречия отразить в замечаниях со ссылками на сохранённые ограничения и доказательства. Композицию проверяй по объявленным контрактам непосредственных детей. Их код, замечания, оценки изменений и контракты более глубоких потомков не входят в собственную проверку родителя. Определение зависимостей через LLM отключено: не добавлять dependencies и не заявлять полноту их перечня. Если сохранённых данных недостаточно, указать ограничение покрытия и not_checked. Заполнить модель, prompt и результаты.";
  bundle.manifest.review_scope = options.scope ?? "self";
  bundle.report.analysis.input_digest = digest(bundle.manifest);
  const inputs = createInputs(baseline, current, id, options, true, context);
  const technical = technicalReport(projectId, baseline, current, comparison, context);
  const entry: ReviewEntry = { schema_version: REPORT_SCHEMA_VERSION, kind: "review-input", module_id: id,
    project_id: projectId, review_id: bundle.report.id,
    check_hash: technical.check_hash, check_manifest: technical.input_manifest,
    analysis_kind: "semantic", format: "native-v2", inputs,
    report: structuredClone(bundle.report), manifest: structuredClone(bundle.manifest),
    baseline: scopedSnapshot(baseline, id, options, bundle.report, context), current: scopedSnapshot(current, id, options, bundle.report, context)! };
  return entry;
}
