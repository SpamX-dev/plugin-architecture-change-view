import type { SnapshotData } from "../snapshots/types.js";
import type { FreshnessReason, Coverage } from "../reviews/types.js";
import type { SelfState, ReviewState, ReviewEntry, Freshness, ReviewFreshness } from "./types.js";
import { canonical } from "../serialization/digest.js";
import type { ModuleStateContext } from "./module-state.js";
import { REPORT_SCHEMA_VERSION } from "./types.js";
import { isSemanticReview } from "./review-identity.js";
import { createInputs } from "./review-state.js";

/** Известные причины инвалидации не смешиваются с неизвестной полнотой анализа. */
function inputDifferences(previous: ReviewState | null, current: ReviewState | null) {
  const reasons: FreshnessReason[] = [];
  const changed = (key: keyof SelfState, code: string) => { if (canonical(previous?.state?.[key] ?? null) !== canonical(current?.state?.[key] ?? null)) reasons.push({ code }); };
  if (previous?.exists !== current?.exists) reasons.push({ code: "module_existence" });
  changed("directory", "module_path");
  changed("own_files", "own_code");
  changed("contract", "own_contract");
  changed("inherited", "inherited_constraints");
  changed("children", "child_composition");
  if (canonical(previous?.subtree ?? null) !== canonical(current?.subtree ?? null)) reasons.push({ code: "subtree_inputs" });
  if (canonical(previous?.dependencies ?? []) !== canonical(current?.dependencies ?? [])) reasons.push({ code: "dependency_input" });
  return reasons;
}

/**
 * Объединяет ограничения проверки, не меняя актуальность или вердикт.
 * Неполный перечень зависимостей не отменяет сравнение сохранённых входов,
 * но остаётся явным ограничением полноты даже у свежей содержательной оценки.
 */
export function combineCoverage(values: Coverage[]): Coverage {
  return {
    status: values.every((value) => value.status === "complete") ? "complete" :
      values.every((value) => value.status === "unavailable") ? "unavailable" : "partial",
    limitations: [...new Set(values.flatMap((value) => value.limitations))],
    reasons: [...new Map(values.flatMap((value) => value.reasons ?? [])
      .map((reason) => [canonical(reason), reason])).values()],
  };
}

/**
 * Сравнивает только проверяемые сохранённые входы. Неизвестная полнота списка
 * зависимостей относится к coverage; unknown остаётся для входов, которые
 * действительно невозможно сопоставить. Известное изменение сохраняет stale.
 */
function inputFreshness(previous: ReviewState | null, current: ReviewState | null): Freshness {
  const reasons = inputDifferences(previous, current);
  const unknown = [];
  const limitations = [];
  const coverageReasons = [];
  if (previous?.dependency_coverage?.status !== "complete") {
    coverageReasons.push({ code: "dependency_coverage_unknown",
      potential_influence: structuredClone(previous?.dependency_coverage?.potential_influence ?? [{ scope: "project" }]) });
    limitations.push("Полнота зависимостей не подтверждена.");
  }
  if (previous?.dependencies.some((input) => !input.available) || current?.dependencies.some((input) => !input.available)) {
    unknown.push({ code: "dependency_unresolved" });
    limitations.push("Часть объявленных зависимостей недоступна для сравнения.");
  }
  if (!previous?.complete || !current?.complete) unknown.push({ code: "input_coverage_incomplete" });
  if (!previous?.complete || !current?.complete) limitations.push("Сохранённые или текущие входные данные неполны.");
  return { status: reasons.length ? "stale" : unknown.length ? "unknown" : "fresh", reasons: [...reasons, ...unknown],
    coverage: { status: limitations.length ? "partial" : "complete", limitations, reasons: [...coverageReasons, ...unknown] } };
}

/** Все проекции одной оценки используют те же состояния зафиксированных снимков. */
export function freshness(entry: ReviewEntry, baseline: SnapshotData | null, current: SnapshotData, context: ModuleStateContext): ReviewFreshness {
  if (!entry?.inputs || entry.schema_version !== REPORT_SCHEMA_VERSION || entry.inputs.schema_version !== 1) {
    const unavailable = { status: "unknown", reasons: [{ code: "legacy_manifest_missing" }],
      coverage: { status: "unavailable", limitations: ["Нет проверяемого описания входов прежнего анализа."] } };
    return { current: structuredClone(unavailable), change: structuredClone(unavailable) };
  }
  const selectors = (entry.inputs.current.dependencies ?? []).map((dependency) => dependency.selector);
  const options = { scope: entry.inputs.scope, dependencies: selectors,
    dependencyCoverage: entry.inputs.current.dependency_coverage, contractScope: entry.inputs.contract_scope ?? "effective" };
  const actual = createInputs(baseline, current, entry.module_id, options, isSemanticReview(entry), context);
  const own = inputFreshness(entry.inputs.current, actual.current);
  const change = inputFreshness(entry.inputs.current, actual.current);
  if (canonical(entry.inputs.baseline_identity) !== canonical(actual.baseline_identity)) {
    change.status = "stale"; change.reasons.push({ code: "baseline_identity" });
  }
  if (entry.inputs.baseline || actual.baseline) {
    const baselineStatus = inputFreshness(entry.inputs.baseline, actual.baseline);
    change.reasons.push(...baselineStatus.reasons.map((reason) => ({ ...reason, side: "baseline" })));
    change.coverage = combineCoverage([change.coverage, baselineStatus.coverage]);
    if (baselineStatus.status === "stale") change.status = "stale";
    else if (baselineStatus.status === "unknown" && change.status === "fresh") change.status = "unknown";
  }
  return { current: own, change };
}
