import type { Snapshot, SnapshotData } from "../snapshots/types.js";
import type { FreshnessReason, Coverage, ReviewBundle } from "../reviews/types.js";
import { ANALYZER } from "../reviews/bundle.js";
import { snapshotDigest } from "../snapshots/identity.js";
import type { SelfState, ReviewState, ReviewEntry, Freshness, ReviewFreshness } from "./types.js";
import { canonical, digest } from "../serialization/digest.js";
import { moduleId, type ModuleStateContext } from "./module-state.js";
import { REPORT_SCHEMA_VERSION } from "./types.js";
import { isSemanticReview } from "./review-identity.js";
import { createInputs } from "./review-state.js";

/** У прежнего пакета v1 актуальность относится к полной паре снимков. */
export function reviewIsStale(bundle: ReviewBundle, before: Snapshot | null, after: Snapshot) {
  return (bundle.report.analysis.analyzer.name === ANALYZER.name && digest(bundle.report.analysis.analyzer) !== digest(ANALYZER)) ||
    bundle.report.comparison.current?.digest !== snapshotDigest(after) ||
    (bundle.report.comparison.baseline?.digest ?? null) !== (before ? snapshotDigest(before) : null);
}

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
 * Сравнивает собственные входы и явно выбранное поддерево. Зависимости из LLM-
 * отчётов сохраняются как происхождение доказательств, но не отслеживаются.
 */
function inputFreshness(previous: ReviewState | null, current: ReviewState | null): Freshness {
  const reasons = inputDifferences(previous, current);
  const unknown = [];
  const limitations = ["Отслеживание зависимостей LLM отключено; зависимости через AST пока не определяются."];
  const coverageReasons = [{ code: "dependency_tracking_disabled" }];
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
  const options = { scope: entry.inputs.scope, dependencies: [],
    dependencyCoverage: entry.inputs.current.dependency_coverage, contractScope: entry.inputs.contract_scope ?? "effective" };
  const actual = createInputs(baseline, current, entry.module_id, options, isSemanticReview(entry), context);
  const own = inputFreshness(entry.inputs.current, actual.current);
  if (entry.inputs.scope === "self" && (current.observations || current.revision)) {
    const id = entry.module_id;
    const prior = entry.current.modules.find(m => moduleId(m) === id);
    const now = current.modules.find(m => moduleId(m) === id);
    const beforeVersion = entry.current.observations?.[id];
    const version = current.observations?.[id];
    const comparable = beforeVersion && version && beforeVersion.lineage === version.lineage;
    const inputs = (m: typeof now) => m ? [m.directory, m.files, m.document] : null;
    const children = actual.current.state?.children ?? [];
    const compositionChanged = own.reasons.some(reason => reason.code === "child_composition");
    if (compositionChanged) {
      own.status = "stale";
      own.reasons = [{code:"child_composition"}];
    } else if (canonical(inputs(prior)) !== canonical(inputs(now)) || comparable && beforeVersion.revision !== version.revision) {
      own.status = "stale"; own.reasons = [{code:"module_changed_since_analysis"}];
    } else if (children.some(child => child.document_state !== "documented" || !child.contract)) {
      own.status = "unknown"; own.reasons = [{code:"input_coverage_incomplete"}];
    } else if ((!comparable && (!current.revision || entry.current.revision !== current.revision)) || !current.complete || !entry.current.complete) {
      own.status = "unknown"; own.reasons = [{code:"module_order_unknown"}];
    } else {
      own.status = "fresh"; own.reasons = [];
    }
  }
  const change = structuredClone(own);
  if (canonical(entry.inputs.baseline_identity) !== canonical(actual.baseline_identity)) {
    change.status = "stale"; change.reasons.push({ code: "baseline_identity" });
  }
  // An identical immutable Git object already fixes every baseline input.
  const sameCommit = baseline?.complete && entry.baseline?.complete && baseline.revision && baseline.revision === entry.baseline.revision;
  if (!sameCommit && (entry.inputs.baseline || actual.baseline)) {
    const baselineStatus = inputFreshness(entry.inputs.baseline, actual.baseline);
    change.reasons.push(...baselineStatus.reasons.map((reason) => ({ ...reason, side: "baseline" })));
    change.coverage = combineCoverage([change.coverage, baselineStatus.coverage]);
    if (baselineStatus.status === "stale") change.status = "stale";
    else if (baselineStatus.status === "unknown" && change.status === "fresh") change.status = "unknown";
  }
  return { current: own, change };
}
