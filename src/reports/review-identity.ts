import type { ReviewBundle, ReviewReport } from "../reviews/types.js";
import type { ReviewEntry } from "./types.js";
import { digest } from "../serialization/digest.js";
import { ANALYZER } from "../reviews/bundle.js";

/** Внешняя структура не считается LLM-попыткой даже при наличии пустых findings. */
export function isSemanticReview(entry: ReviewEntry | ReviewReport | ReviewBundle) {
  const report = "report" in entry ? entry.report : entry;
  return report.analysis?.analyzer?.name !== ANALYZER.name && (!("analysis_kind" in entry) || entry.analysis_kind !== "structure");
}

/** Результат без времени/id позволяет группировать только одинаковые реальные попытки. */
export function resultDigest(report: ReviewReport) {
  return digest({ observed: report.observed, checks: report.checks, findings: report.findings,
    assessment: report.assessment, coverage: report.analysis?.coverage });
}

/** Весь пакет, включая сохранённые доказательства, защищён отдельным отпечатком. */
export function entryContentDigest(entry: ReviewEntry) {
  const { content_digest, registration_order, ...content } = entry;
  return digest(content);
}

/**
 * Явный разбор расхождения — новая попытка со ссылками на прежние, а не их
 * удаление. Разрешать можно только ту же область и оба набора входов; смена
 * кода не разрешает спор о прежнем коде. Хранилище вызывает это перед записью.
 */
export function validateReviewRelations(entries: ReviewEntry[]) {
  const byId = new Map<string, ReviewEntry>();
  for (const entry of entries) {
    const previous = byId.get(entry.review_id);
    if (previous && entryContentDigest(previous) !== entryContentDigest(entry)) throw new Error("Review id collision: " + entry.review_id);
    byId.set(entry.review_id, entry);
  }
  for (const entry of entries) for (const id of entry.resolution?.review_ids ?? []) {
    const target = byId.get(id);
    if (!target) throw new Error("Unresolved review resolution: " + id);
    if (!isSemanticReview(entry) || !isSemanticReview(target) || entry.module_id !== target.module_id ||
      entry.inputs?.scope !== target.inputs?.scope || entry.inputs?.current_digest !== target.inputs?.current_digest ||
      entry.inputs?.change_digest !== target.inputs?.change_digest) throw new Error("Review resolution scope/input mismatch: " + id);
  }
  const visit = (id: string, ancestors = new Set<string>()): void => {
    if (ancestors.has(id)) throw new Error("Cyclic review resolution");
    const next = new Set([...ancestors, id]);
    for (const target of byId.get(id)?.resolution?.review_ids ?? []) visit(target, next);
  };
  for (const id of byId.keys()) visit(id);
  return entries;
}
