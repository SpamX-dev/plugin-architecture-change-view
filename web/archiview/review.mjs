/**
 * Представление контрактов и сохранённых проверок. Все значения вставляются
 * как текст; доказательства берутся из пакета отчёта, а не из рабочего файла.
 * Устаревание и неполнота показываются рядом с выводами, включая историю.
 */
const verdicts = { consistent: "Согласуется", violation: "Нарушение", needs_review: "Требует решения",
  inconclusive: "Недостаточно данных", not_applicable: "Неприменимо", uncertain: "Неоднозначно", not_checked: "Не проверено" };
const sections = { responsibilities: "Ответственность", boundaries: "Границы", invariants: "Инварианты" };
const kinds = { boundary_violation: "Выход за границы", invariant_violation: "Нарушение инварианта",
  undeclared_responsibility: "Неописанная обязанность", responsibility_gap: "Разрыв ответственности",
  contract_conflict: "Конфликт контракта", contract_change: "Изменение контракта", missing_contract: "Нет контракта v1" };

/** Создаёт элементы без интерпретации HTML из контрактов, выводов или исходников. */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Показывает зафиксированный текст доказательства с происхождением и координатами. */
function showEvidence(bundle, reference) {
  const fact = bundle.facts[reference.snapshot].find((entry) => entry.id === reference.fact_id);
  const dialog = el("dialog", "evidence-dialog");
  const heading = el("div", "evidence-heading");
  const close = el("button", "button button-quiet", "Закрыть");
  close.type = "button";
  close.onclick = () => dialog.close();
  heading.append(el("strong", "", "Доказательство · " + (reference.snapshot === "baseline" ? "база" : "текущий снимок")), close);
  dialog.append(heading, el("p", "evidence-origin", fact ? fact.path + (fact.start_line ? " · строки " + fact.start_line + "–" + fact.end_line : " · структура модуля") : "Факт недоступен"));
  const code = el("pre", "evidence-code", fact?.text ?? reference.fact_id);
  dialog.append(code);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

/** Кнопки открывают только известные факты выбранного неизменяемого отчёта. */
function evidenceLinks(bundle, references) {
  const links = el("div", "evidence-links");
  for (const ref of references) {
    const fact = bundle.facts[ref.snapshot].find((f) => f.id === ref.fact_id);
    const button = el("button", "evidence-link", (ref.snapshot === "baseline" ? "База · " : "Сейчас · ") + (fact?.path ?? "Факт недоступен"));
    button.type = "button";
    button.onclick = () => showEvidence(bundle, ref);
    links.append(button);
  }
  return links;
}

/** Представляет все стандартные поля контракта и доступный исходный YAML. */
export function renderContract(panel, document) {
  const contract = document.contract;
  const paper = el("article", "contract-paper");
  const header = el("div", "contract-header");
  header.append(el("span", "contract-kind", contract.kind === "group" ? "ГРУППА МОДУЛЕЙ" : "КОНТРАКТ МОДУЛЯ"),
    el("code", "contract-id", contract.id), el("h2", "", contract.title), el("p", "contract-purpose", contract.purpose));
  paper.append(header);
  for (const [section, title] of Object.entries(sections)) {
    const block = el("section", "clause-section");
    block.append(el("h3", "", title));
    if (!Object.keys(contract[section]).length) block.append(el("p", "empty-clauses", "Пункты не заданы"));
    for (const [id, text] of Object.entries(contract[section])) {
      const row = el("div", "clause-row");
      row.append(el("code", "clause-id", id), el("p", "", text));
      block.append(row);
    }
    paper.append(block);
  }
  if (contract.rationale) paper.append(el("h3", "contract-extra-heading", "Обоснование"), el("p", "contract-extra", contract.rationale));
  for (const [key, label] of [["owners", "Владельцы"], ["tags", "Метки"]]) if (contract[key]?.length) {
    paper.append(el("p", "contract-extra", label + ": " + contract[key].join(" · ")));
  }
  for (const reference of contract.references ?? []) {
    const row = el("p", "contract-extra");
    if (/^https?:\/\//i.test(reference.uri)) {
      const link = el("a", "", reference.title);
      link.href = reference.uri; link.target = "_blank"; link.rel = "noopener noreferrer";
      row.append(link);
    } else row.textContent = reference.title + " · " + reference.uri;
    paper.append(row);
  }
  const raw = el("details", "raw-document");
  raw.append(el("summary", "", "Исходный arch.yaml"), el("pre", "", document.text));
  paper.append(raw);
  panel.append(paper);
}

/** Две независимые оценки сохраняют различие состояния и изменения ответственности. */
function assessments(bundle) {
  const row = el("div", "assessment-grid");
  for (const [key, title] of [["current", "Текущее состояние"], ["change", "Изменение относительно базы"]]) {
    const value = bundle.report.assessment[key];
    const card = el("div", "assessment-card " + value.verdict);
    card.append(el("span", "assessment-label", title), el("strong", "", verdicts[value.verdict]), el("p", "", value.summary));
    row.append(card);
  }
  return row;
}

/** Полный просмотр отчёта, включая ограничения, наблюдения, пункты и замечания. */
export function renderReview(panel, detail, mode, generate) {
  const toolbar = el("div", "review-toolbar");
  const action = el("button", "button button-primary", "Проверить структуру");
  action.type = "button";
  action.onclick = async () => { action.disabled = true; try { await generate(); } finally { action.disabled = false; } };
  toolbar.append(el("span", "review-toolbar-label", "Результаты анализа модуля"), action);
  panel.append(toolbar);
  if (!detail.reviews.length) {
    const empty = el("div", "notice");
    empty.append(el("strong", "", "Проверок пока нет"), el("p", "", "Создайте структурную проверку выбранной пары снимков. Она проверит наличие контрактов и зафиксирует изменения. Анализ смысла кода подключается отдельным отчётом."));
    panel.append(empty); return;
  }
  const picker = el("select", "review-picker");
  picker.setAttribute("aria-label", "История проверок");
  let selected = detail.reviews.findIndex((b) => b.report.id === detail.review?.id);
  if (selected < 0) selected = 0;
  detail.reviews.forEach((bundle, index) => {
    const option = el("option", "", new Date(bundle.report.analysis.created_at).toLocaleString("ru-RU") + " · " + bundle.report.analysis.analyzer.name + (bundle.stale ? " · устарел" : " · актуален"));
    option.value = index; option.selected = index === selected; picker.append(option);
  });
  const body = el("div", "review-body");
  panel.append(picker, body);
  picker.onchange = () => draw(detail.reviews[Number(picker.value)]);
  draw(detail.reviews[selected]);

  /** Смена истории не меняет выбранную базу и не подставляет новые факты в старый вывод. */
  function draw(bundle) {
    body.replaceChildren();
    const report = bundle.report;
    if (bundle.stale) {
      const warning = el("div", "notice missing-notice");
      warning.append(el("strong", "", "Отчёт устарел для выбранного сравнения"), el("p", "", "Ниже сохранённый результат и его исторические доказательства. Входы текущего сравнения отличаются."));
      body.append(warning);
    }
    body.append(assessments(bundle));
    const coverage = el("details", "coverage-note");
    coverage.open = report.analysis.coverage.status !== "complete";
    coverage.append(el("summary", "", "Полнота: " + ({ complete: "выбранная область проверена", partial: "частичная проверка", unavailable: "анализ недоступен" }[report.analysis.coverage.status])));
    const list = el("ul");
    for (const limitation of report.analysis.coverage.limitations) list.append(el("li", "", limitation));
    coverage.append(list); body.append(coverage);
    if (mode === "findings") {
      if (!report.findings.length) body.append(el("p", "empty-clauses", "Замечания не записаны. Это не означает, что все пункты проверены."));
      for (const finding of report.findings) {
        const card = el("article", "finding-card " + finding.severity);
        card.append(el("div", "finding-meta", [kinds[finding.kind], { confirmed: "подтверждено", suspected: "предположение" }[finding.certainty],
          { info: "информация", warning: "предупреждение", error: "ошибка" }[finding.severity],
          { introduced: "новое", persisting: "сохраняется", resolved: "устранено", unknown: "история неизвестна" }[finding.lifecycle]].join(" · ")),
          el("h3", "", finding.summary));
        if (finding.details) card.append(el("p", "", finding.details));
        if (finding.recommendation) card.append(el("p", "", "Рекомендация: " + finding.recommendation));
        for (const clause of finding.clauses) card.append(clauseText(bundle, clause));
        if (finding.related_modules?.length) card.append(el("p", "", "Связанные модули: " + finding.related_modules.join(", ")));
        card.append(evidenceLinks(bundle, finding.evidence)); body.append(card);
      }
    } else {
      const observed = el("details", "observed-note");
      observed.append(el("summary", "", "Наблюдаемая ответственность"));
      for (const side of ["baseline", "current"]) if (report.observed[side]) {
        observed.append(el("h4", "", side === "baseline" ? "В базе" : "В текущем снимке"), el("p", "", report.observed[side].summary));
        for (const responsibility of report.observed[side].responsibilities) observed.append(el("p", "", responsibility.text), evidenceLinks(bundle, responsibility.evidence));
      }
      body.append(observed, el("h3", "section-heading", "Проверки пунктов · " + report.checks.length));
      if (!report.checks.length) body.append(el("p", "empty-clauses", "Нет доступных пунктов структурированного контракта."));
      for (const check of report.checks) {
        const card = el("article", "check-card");
        const top = el("div", "check-heading");
        top.append(el("span", "verdict " + check.verdict, verdicts[check.verdict]), el("span", "", "Код: " + (check.subject === "current" ? "сейчас" : "база")));
        card.append(top, clauseText(bundle, check.contract), el("p", "", check.explanation), evidenceLinks(bundle, check.evidence));
        body.append(card);
      }
    }
    const raw = el("details", "raw-document");
    raw.append(el("summary", "", "Все поля отчёта · " + report.id), el("pre", "", JSON.stringify(report, null, 2)));
    body.append(raw);
  }
}

/** Разрешает пункт через сохранённый эффективный контракт, включая родительский. */
function clauseText(bundle, ref) {
  const entry = bundle.contracts[ref.snapshot].find((c) => c.reference.module_id === ref.module_id && c.reference.section === ref.section && c.reference.id === ref.id);
  return el("p", "check-clause", (ref.snapshot === "baseline" ? "Базовый" : "Текущий") + " контракт · " + ref.module_id + " / " + ref.id + " · " + (entry?.text ?? "Пункт вне эффективного контракта модуля"));
}
