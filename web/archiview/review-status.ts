import type { Freshness, Coverage, Reason, ReviewBundle } from "./types.js";

/** Сравнение известных входов не обещает полного покрытия или положительного вердикта. */
export function freshnessLabel(value: Freshness | null | undefined, { compact = false } = {}) {
  if (!value) return "проверки нет";
  if (value.conflict) return "расхождение выводов";
  const label = { fresh: compact ? "входы без изменений" : "проверенные входы не изменились",
    stale: "требует перепроверки", unknown: "актуальность не установлена",
    not_reviewed: "проверки нет" }[value.status] ?? value.status;
  return label;
}

/** Подпись полноты не подменяет сравнение входов; причины показываются рядом. */
export function coverageLabel(value: Coverage | null | undefined) {
  if (!value || value.status === "unavailable") return "не оценена";
  return value.status === "complete" ? "полная в выбранной области" : "частичная";
}

/** Полнота выбранной попытки включает её ограничения и сравнимость обеих оценок. */
export function reviewCoverage(bundle: ReviewBundle) {
  const values = [bundle.report.analysis.coverage,
    ...Object.values(bundle.freshness ?? {}).map((value) => value.coverage)].filter((value): value is Coverage => value !== undefined);
  return { status: values.every((value) => value.status === "complete") ? "complete" :
    values.every((value) => value.status === "unavailable") ? "unavailable" : "partial",
    limitations: [...new Set(values.flatMap((value) => value.limitations))],
    reasons: values.flatMap((value) => value.reasons ?? []) };
}

/** Переводит причины модели без вычисления собственных правил актуальности. */
function reasonText(reason: Reason) {
  const code = typeof reason === "string" ? reason : reason.code;
  const labels: Record<string, string> = { own_code_changed: "Изменились собственные файлы", own_contract_changed: "Изменился собственный контракт",
    inherited_constraint_changed: "Изменились ограничения предка", child_contract_changed: "Изменились контракты подмодулей",
    composition_changed: "Изменился состав подмодулей", dependency_input_changed: "Изменился вход зависимости",
    descendants_require_review: "Подмодули требуют проверки", baseline_changed: "Изменилась база сравнения",
    missing_manifest: "Нет полного описания входов проверки", legacy_manifest: "Прежняя проверка не описывает всю область влияния",
    dependency_coverage_unknown: "Полнота зависимостей не подтверждена", unresolved_dependency_changed: "Изменилась область возможного влияния",
    incomplete_snapshot: "Снимок неполный", not_reviewed: "Содержательная проверка ещё не выполнялась",
    module_existence: "Изменилось наличие модуля", module_path: "Модуль перемещён", own_code: "Изменились собственные файлы",
    own_contract: "Изменился собственный контракт", inherited_constraints: "Изменились ограничения предков",
    child_composition: "Изменились состав или контракты подмодулей", subtree_inputs: "Изменились входы поддерева",
    dependency_input: "Изменился вход зависимости", dependency_unresolved: "Не удалось разрешить зависимость",
    input_coverage_incomplete: "Входные данные проверки неполны", baseline_identity: "Изменилась база сравнения",
    legacy_manifest_missing: "Прежняя проверка не описывает всю область влияния" };
  return (typeof reason === "object" && (reason.message ?? reason.description)) || labels[code] || code;
}

/**
 * Актуальность собственной проверки и оценки изменения независимы: устаревшая
 * база не отменяет совпадения проверенных current-входов, поэтому обе оценки
 * возвращаются раздельно со своими причинами и конфликтом выводов.
 */
export function reviewFreshnessStates(bundle: Pick<ReviewBundle, "freshness" | "stale">) {
  const freshness = bundle?.freshness ?? {};
  const state = (side: "current" | "change", title: string, fallback: string) => {
    const value = freshness[side];
    return { key: side, title, status: value?.status ?? fallback,
      conflict: Boolean(value?.conflict),
      reasons: [...new Set((value?.reasons ?? []).map(reasonText))] };
  };
  return [state("current", "Проверка модуля", bundle?.stale ? "stale" : "unknown"),
    state("change", "Оценка изменения", "unknown")];
}
