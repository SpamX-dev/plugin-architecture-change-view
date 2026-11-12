import type { SnapshotData } from "../snapshots/types.js";
import type { AssessmentSide, ReviewReport } from "../reviews/types.js";
import type { ReviewEntry, ReviewFreshness, AggregateAssessment, ReviewStatus, TreeReviewStatus } from "./types.js";
import { canonical, digest } from "../serialization/digest.js";
import { ModuleStateContext } from "./module-state.js";
import { isSemanticReview, validateReviewRelations } from "./review-identity.js";
import { combineCoverage, freshness as assessFreshness } from "./freshness.js";

/** Разные формулировки и непроверенные пункты не противоречат подтверждённому выводу. */
function currentAssessmentsConflict(reports: ReviewReport[]) {
  const assertions = new Map<string, string>();
  const record = (key: string, verdict: string) => {
    const previous = assertions.get(key);
    assertions.set(key, verdict);
    return previous !== undefined && previous !== verdict;
  };
  const definite = (verdict: string) => ["consistent", "violation", "not_applicable"].includes(verdict);
  for (const report of reports) {
    const assessment = report.assessment.current.verdict;
    if (definite(assessment) && record("assessment", assessment)) return true;
    for (const check of report.checks) {
      if (check.subject !== "current" || check.contract.snapshot !== "current" || !definite(check.verdict)) continue;
      if (record("check:" + canonical(check.contract), check.verdict)) return true;
    }
    for (const finding of report.findings) {
      if (finding.kind === "contract_change" || !finding.evidence.some(ref => ref.snapshot === "current")) continue;
      if (record("finding:" + finding.id, finding.lifecycle === "resolved" ? "resolved" : "open")) return true;
    }
  }
  return false;
}

/** Статус сохраняет все применимые попытки, включая несовпадающие выводы. */
function aggregateAssessment(candidates: {entry:ReviewEntry;freshness:ReviewFreshness}[], side: AssessmentSide): AggregateAssessment {
  if (!candidates.length) return { current_violation: false, status: "not_reviewed", reasons: [], verdict: null, review_ids: [], conflict: false,
    coverage: { status: "unavailable", limitations: ["Содержательная проверка отсутствует."] } };
  const fresh = candidates.filter((candidate) => candidate.freshness[side].status === "fresh");
  const applicable = fresh.length ? fresh : candidates.filter((candidate) => candidate.freshness[side].status === "unknown");
  const selected = applicable.length ? applicable : candidates;
  const reports = applicable.map((candidate) => candidate.entry.report);
  const conflict = side === "current" ? currentAssessmentsConflict(reports) : new Set(reports.map(report =>
    digest({ assessment: report.assessment.change, observed: report.observed, checks: report.checks, findings: report.findings }))).size > 1;
  const verdicts = [...new Set(applicable.map((candidate) => candidate.entry.report.assessment[side].verdict))];
  const coverage = combineCoverage(selected.flatMap((candidate) =>
    [candidate.entry.report.analysis.coverage, candidate.freshness[side].coverage]));
  return { status: fresh.length ? "fresh" : applicable.length ? "unknown" : "stale",
    reasons: selected.flatMap((candidate) => candidate.freshness[side].reasons),
    verdict: conflict ? "inconclusive" : verdicts.length === 1 ? verdicts[0] : null,
    verdicts, review_ids: selected.map((candidate) => candidate.entry.review_id), conflict,
    coverage,
    current_violation: fresh.some((candidate) => candidate.entry.report.assessment[side].verdict === "violation") };
}

/** Учитываем разрешения один раз для всего набора попыток, в обеих областях. */
function activeReviewsByModule(entries: ReviewEntry[]) {
  validateReviewRelations(entries);
  const resolved = new Set(entries.flatMap((entry) => entry.resolution?.review_ids ?? []));
  const active = new Map<string, ReviewEntry[]>();
  for (const entry of entries) {
    if (resolved.has(entry.review_id) || !isSemanticReview(entry)) continue;
    const group = active.get(entry.module_id);
    if (group) group.push(entry);
    else active.set(entry.module_id, [entry]);
  }
  return active;
}

function assessScope(entries: ReviewEntry[], scope: "self" | "subtree", baseline: SnapshotData | null,
  current: SnapshotData, context: ModuleStateContext) {
  const candidates = entries.filter((entry) => entry.inputs?.scope === scope)
    .map((entry) => ({ entry, freshness: assessFreshness(entry, baseline, current, context) }));
  return { current: aggregateAssessment(candidates, "current"), change: aggregateAssessment(candidates, "change") };
}

function ownReviewStatus(entries: ReviewEntry[], baseline: SnapshotData | null, current: SnapshotData,
  context: ModuleStateContext): ReviewStatus {
  const own = assessScope(entries, "self", baseline, current, context);
  return { ...own, conflict: own.current.conflict || own.change.conflict,
    coverage: { current: own.current.coverage, change: own.change.coverage } };
}

/** Широкая subtree-попытка не выдаётся за self-проверки всех узлов. */
export function aggregateReviewStatus(entries: ReviewEntry[], baseline: SnapshotData | null, current: SnapshotData, id: string) {
  return ownReviewStatus(activeReviewsByModule(entries).get(id) ?? [], baseline, current, new ModuleStateContext());
}

function rollup(statuses: AggregateAssessment[]): AggregateAssessment {
  const counts: Record<string, number> = { fresh: 0, stale: 0, unknown: 0, not_reviewed: 0 };
  for (const status of statuses) {
    if (status.counts) {
      for (const [key, value] of Object.entries(status.counts)) counts[key] += value;
    } else counts[status.status] += 1;
  }
  return { status: counts.stale ? "stale" : counts.unknown ? "unknown" : counts.not_reviewed ? "not_reviewed" : "fresh",
    counts, conflict: statuses.some((status) => status.conflict), current_violation: statuses.some((status) => status.current_violation),
    coverage: combineCoverage(statuses.map((status) => status.coverage)) };
}

/**
 * Удалённые узлы добавляются лишь в рабочую карту обхода. Исходная карта current
 * остаётся неизменной для следующих отчётов и проверок актуальности этой модели.
 */
export function treeStatuses(entries: ReviewEntry[], baseline: SnapshotData | null, current: SnapshotData, context: ModuleStateContext): Map<string, TreeReviewStatus> {
  const active = activeReviewsByModule(entries);
  const states = new Map(context.states(current));
  const result = new Map<string, TreeReviewStatus>();
  for (const state of context.states(baseline).values()) {
    if (!states.has(state.module_id)) states.set(state.module_id, state);
  }
  const visit = (id: string, visiting = new Set<string>()): TreeReviewStatus => {
    const existing = result.get(id);
    if (existing) return existing;
    if (visiting.has(id)) throw new Error("Cyclic module tree");
    visiting.add(id);
    const state = states.get(id)!;
    const reviews = active.get(id) ?? [];
    const self = ownReviewStatus(reviews, baseline, current, context);
    const children = state.children.filter((child) => states.has(child)).map((child) => visit(child, visiting));
    const value = {
      self,
      subtree: {
        current: rollup([self.current, ...children.map((child) => child.subtree.current)]),
        change: rollup([self.change, ...children.map((child) => child.subtree.change)]),
      },
      explicit_subtree: assessScope(reviews, "subtree", baseline, current, context),
    };
    visiting.delete(id);
    result.set(id, value);
    return value;
  };
  for (const id of states.keys()) visit(id);
  return result;
}
