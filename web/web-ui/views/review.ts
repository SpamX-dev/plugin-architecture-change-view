import type { Check, EvidenceReference, Observation, ReviewBundle, ReviewRenderOptions, ClauseReference } from "../view-model/types.js";
import { compositionParticipants } from "../../../framework/ai-report/types.js";
import { findingDecision } from "./finding-decision.js";
import { el } from "./dom.js";
import { evidenceLinks } from "./evidence.js";
import { findingFixAction, reviewDate, reviewFindingItems } from "./findings.js";
import { savedClauseText } from "./contract.js";

type GroupedObservation = { summary: string | null; responsibilities: { text: string; evidence: EvidenceReference[] }[] };

const verdicts: Record<string, string> = { consistent: "Согласуется", violation: "Нарушение", needs_review: "Требует решения",
  inconclusive: "Недостаточно данных", not_applicable: "Неприменимо", uncertain: "Неоднозначно", not_checked: "Не проверено" };
const kinds = { boundary_violation: "Выход за границы", invariant_violation: "Нарушение инварианта",
  undeclared_responsibility: "Неописанная обязанность", responsibility_gap: "Разрыв ответственности",
  contract_conflict: "Конфликт контракта", missing_contract: "Нет контракта v1" };

/**
 * Основной список показывает собственные пункты выбранного состояния. Старые
 * проверки предков и повторная оценка базового контракта остаются в исходном
 * отчёте. Несколько выводов по одному пункту группируются без потери вердиктов.
 */
export function ownClauseGroups(bundle: ReviewBundle) {
  const side = bundle.report.module.current_path === null ? "baseline" : "current";
  const groups = new Map<string, Check[]>();
  for (const check of bundle.report.checks) {
    if (check.subject !== side || check.contract.snapshot !== side ||
      check.contract.module_id !== bundle.report.module.id) continue;
    const key = JSON.stringify([check.contract.section, check.contract.id]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(check);
  }
  return [...groups.values()];
}

/**
 * Имена относятся к неизменяемым входам выбранного отчёта, а не к файлам сейчас.
 * Отсутствующая сторона и одна версия с двух сторон не создают сравнение.
 */
export function reviewVersions(bundle: ReviewBundle) {
  const comparison = bundle.report.comparison ?? {};
  const name = (reference: { id: string } | null | undefined) => {
    if (!reference) return null;
    const id = reference.id;
    const kind = id.split("-")[0];
    const title = { git: "Коммит", launch: "При первом открытии проекта", working: "Рабочие файлы",
      change: "Рабочие файлы из хронологии", saved: "Сохранённая версия" }[kind] ?? "Версия";
    return title + " · " + id.replace(/^(git|launch|working|change|saved)-/, "").slice(0, 12);
  };
  const same = Boolean(comparison.baseline && comparison.current &&
    comparison.baseline.id === comparison.current.id && comparison.baseline.digest === comparison.current.digest);
  const change = bundle.report.assessment.change.verdict;
  return { baseline: name(comparison.baseline), current: name(comparison.current), same,
    // Не скрываем противоречивую оценку даже у исторического отчёта одной версии.
    showChange: Boolean(comparison.baseline) && (!same || !["consistent", "not_applicable"].includes(change)) };
}

/**
 * Краткий вывод и одинаковые пункты показываются один раз с объединёнными
 * доказательствами. Разные наблюдения версий остаются доступны отдельно.
 */
export function observedVersionGroups(bundle: ReviewBundle) {
  const normalize = (text: string) => text.trim().replace(/\s+/g, " ");
  const content = (observed: Observation | null): GroupedObservation | null => {
    if (!observed) return null;
    const groups = new Map<string, { text: string; evidence: EvidenceReference[] }>();
    for (const responsibility of observed.responsibilities) {
      const key = normalize(responsibility.text);
      if (!groups.has(key)) groups.set(key, { text: responsibility.text, evidence: [] });
      const evidence = groups.get(key)!.evidence;
      for (const reference of responsibility.evidence) if (!evidence.some((ref) =>
        ref.snapshot === reference.snapshot && ref.fact_id === reference.fact_id)) evidence.push(reference);
    }
    return { summary: groups.has(normalize(observed.summary)) ? null : observed.summary,
      responsibilities: [...groups.values()] };
  };
  const side = bundle.report.module.current_path === null ? "baseline" : "current";
  const primary = content(bundle.report.observed[side]);
  const previous = side === "current" ? content(bundle.report.observed.baseline) : null;
  // При совпадении текста и фактов достаточно одного представления. При смене
  // фактов одинаковый текст не скрывает различие сохранённых доказательств.
  const identity = (value: GroupedObservation | null) => value && JSON.stringify({ summary: value.summary,
    responsibilities: value.responsibilities.map((item) => ({ text: normalize(item.text),
      facts: [...new Set(item.evidence.map((ref) => ref.fact_id))].sort() })) });
  return { side, primary, previous: identity(primary) === identity(previous) ? null : previous };
}

/** Показывает собственную наблюдаемую ответственность с отдельным прошлым описанием. */
function observedResponsibilities(bundle: ReviewBundle) {
  const observed = el("details", "observed-note");
  observed.append(el("summary", "", "По коду"));
  const groups = observedVersionGroups(bundle);
  const append = (target: HTMLElement, value: GroupedObservation) => {
    if (value.summary) target.append(el("p", "", value.summary));
    for (const item of value.responsibilities) target.append(el("p", "", item.text), evidenceLinks(bundle, item.evidence));
  };
  if (groups.primary) append(observed, groups.primary);
  else observed.append(el("p", "", "Наблюдения по этой версии не записаны."));
  if (groups.previous) {
    const previous = el("details", "observed-previous");
    const versions = reviewVersions(bundle);
    previous.append(el("summary", "", versions.same ? "Другое сохранённое описание той же версии" :
      "Описание в версии для сравнения · " + versions.baseline));
    append(previous, groups.previous);
    observed.append(previous);
  }
  return observed;
}

/** Both the checks and findings belong to the same immutable result. */
export function renderReview(panel: HTMLElement, bundle: ReviewBundle, options: ReviewRenderOptions = {}) {
  const report = bundle.report;
  const body = el("div", "review-body");
  body.dataset.reviewId = report.id;
  panel.append(body);
  body.append(el("p", "review-state", "Анализ · " + reviewDate(bundle)), el("p", "", report.assessment.current.summary));
  if (bundle.analysisType === "composition") {
    const participants = compositionParticipants(report) ?? [];
    body.append(el("h3", "section-heading", "Композиция"));
    if (!participants.length) body.append(el("p", "", "У модуля нет непосредственных детей."));
    for (const item of participants) {
      const card = el("article", "check-card");
      card.append(el("h4", "", item.moduleId), el("p", "", (item.role === "utility" ? "Утилита" : "Исполнитель") + " · " + item.task));
      if (item.role === "utility") card.append(el("p", "", "Потребители: " + (item.consumers?.join(", ") || "не установлены")));
      card.append(el("p", "", item.assessment));
      body.append(card);
    }
  }
  const groups = ownClauseGroups(bundle);
  if (bundle.analysisType === "implementation") body.append(observedResponsibilities(bundle));
  body.append(el("h3", "section-heading", "Собственные пункты · " + groups.length));
  if (!groups.length) body.append(el("p", "empty-clauses", "Нет проверок собственного контракта."));
  for (const checks of groups) {
    const states = [...new Set(checks.map((check) => check.verdict))];
    const card = el("article", "check-card check-" + (states.length === 1 ? states[0] : "mixed"));
    card.append(clauseText(bundle, checks[0].contract));
    for (const check of checks) {
      const result = el("div", "check-result check-" + check.verdict);
      result.setAttribute("role", "group");
      result.setAttribute("aria-label", verdicts[check.verdict]);
      result.title = verdicts[check.verdict];
      const explanation = el("details", "check-explanation");
      explanation.append(el("summary", "", "Обоснование"), el("p", "", check.explanation));
      result.append(el("strong", "", verdicts[check.verdict]), evidenceLinks(bundle, check.evidence), explanation);
      card.append(result);
    }
    body.append(card);
  }

  body.append(el("h3", "section-heading", "Замечания"));
  const findings = reviewFindingItems(bundle);
  if (!findings.length) body.append(el("p", "empty-clauses", "Замечаний нет."));
  for (const finding of findings) {
    const card = el("article", "finding-card " + finding.severity);
    card.dataset.findingId = finding.id;
    if (report.id === options.reviewId && finding.id === options.findingId) {
      card.classList.add("finding-target");
      card.tabIndex = -1;
    }
    const meta = finding.assessmentOnly ? "Общий вывод · пункт не указан" :
      [finding.kind ? kinds[finding.kind as keyof typeof kinds] : "", ({ confirmed: "подтверждено", suspected: "предположение" } as Record<string, string>)[finding.certainty ?? ""],
        ({ introduced: "новое", persisting: "сохраняется", resolved: "устранено", unknown: "" } as Record<string, string>)[finding.lifecycle ?? ""]].filter(Boolean).join(" · ");
    card.append(el("div", "finding-meta", meta), el("h3", "", finding.summary));
    if (finding.details) {
      const details = el("details", "finding-details");
      details.append(el("summary", "", "Подробности"), el("p", "", finding.details)); card.append(details);
    }
    if (finding.recommendation) {
      const advice = el("details", "finding-recommendation");
      advice.append(el("summary", "", "Рекомендация"), el("p", "", finding.recommendation)); card.append(advice);
    }
    const clauses = el("div", "finding-clauses");
    for (const reference of finding.clauses) {
      const button = el("button", "finding-clause", reference.module_id + " / " + reference.id);
      button.title = clauseDescription(bundle, reference);
      // Попытка передаётся вместе со ссылкой: сохранённый пункт и сторона
      // снимка известны только её неизменяемому пакету.
      button.onclick = () => options.openClause?.(reference, bundle);
      button.disabled = !options.openClause; clauses.append(button);
    }
    card.append(clauses, evidenceLinks(bundle, finding.evidence));
    const decision = findingDecision(bundle, finding, options);
    card.append(decision);
    const fix = bundle.dispositions?.[finding.id]?.status === "resolved" ? null : findingFixAction(bundle, finding, options);
    if (fix) card.append(fix);
    body.append(card);
  }
  const raw = el("details", "raw-document");
  raw.append(el("summary", "", "Полный отчёт"), el("pre", "", JSON.stringify(report, null, 2))); body.append(raw);
  const target = body.querySelector<HTMLElement>(".finding-target");
  if (target) {
    target.scrollIntoView({ block: "center" });
    target.focus({ preventScroll: true });
  }
}

/** Пункт разрешается по сохранённому контракту с явным владельцем. */
function clauseDescription(bundle: ReviewBundle, ref: ClauseReference) {
  return savedClauseText(bundle, ref) ?? "Пункт вне сохранённого контракта";
}

/** В собственном чеклисте достаточно номера и текста. */
function clauseText(bundle: ReviewBundle, ref: ClauseReference) {
  const row = el("p", "check-clause");
  row.append(el("code", "clause-id", ref.module_id === bundle.report.module.id ? ref.id : ref.module_id + " / " + ref.id),
    el("span", "", clauseDescription(bundle, ref)));
  return row;
}
