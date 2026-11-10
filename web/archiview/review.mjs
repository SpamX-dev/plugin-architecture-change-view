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

/** Сравнение известных входов не обещает полного покрытия или положительного вердикта. */
export function freshnessLabel(value, { compact = false } = {}) {
  if (!value) return "проверки нет";
  if (value.conflict) return "расхождение выводов";
  const label = { fresh: compact ? "входы без изменений" : "проверенные входы не изменились",
    stale: "требует перепроверки", unknown: "актуальность не установлена",
    not_reviewed: "проверки нет" }[value.status] ?? value.status;
  return label;
}

/** Подпись полноты не подменяет сравнение входов; причины показываются рядом. */
export function coverageLabel(value) {
  if (!value || value.status === "unavailable") return "не оценена";
  return value.status === "complete" ? "полная в выбранной области" : "частичная";
}

/** Полнота выбранной попытки включает её ограничения и сравнимость обеих оценок. */
function reviewCoverage(bundle) {
  const values = [bundle.report.analysis.coverage,
    ...Object.values(bundle.freshness ?? {}).map((value) => value.coverage)].filter(Boolean);
  return { status: values.every((value) => value.status === "complete") ? "complete" :
    values.every((value) => value.status === "unavailable") ? "unavailable" : "partial",
    limitations: [...new Set(values.flatMap((value) => value.limitations))],
    reasons: values.flatMap((value) => value.reasons ?? []) };
}

/**
 * Основной список показывает собственные пункты выбранного состояния. Старые
 * проверки предков и повторная оценка базового контракта остаются в исходном
 * отчёте. Несколько выводов по одному пункту группируются без потери вердиктов.
 */
export function ownClauseGroups(bundle) {
  const side = bundle.report.module.current_path === null ? "baseline" : "current";
  const groups = new Map();
  for (const check of bundle.report.checks) {
    if (check.subject !== side || check.contract.snapshot !== side ||
      check.contract.module_id !== bundle.report.module.id) continue;
    const key = JSON.stringify([check.contract.section, check.contract.id]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(check);
  }
  return [...groups.values()];
}

/**
 * Имена относятся к неизменяемым входам выбранного отчёта, а не к файлам сейчас.
 * Отсутствующая сторона и одна версия с двух сторон не создают сравнение.
 */
export function reviewVersions(bundle) {
  const comparison = bundle.report.comparison ?? {};
  const name = (reference) => {
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
export function observedVersionGroups(bundle) {
  const normalize = (text) => text.trim().replace(/\s+/g, " ");
  const content = (observed) => {
    if (!observed) return null;
    const groups = new Map();
    for (const responsibility of observed.responsibilities) {
      const key = normalize(responsibility.text);
      if (!groups.has(key)) groups.set(key, { text: responsibility.text, evidence: [] });
      const evidence = groups.get(key).evidence;
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
  const identity = (value) => value && JSON.stringify({ summary: value.summary,
    responsibilities: value.responsibilities.map((item) => ({ text: normalize(item.text),
      facts: [...new Set(item.evidence.map((ref) => ref.fact_id))].sort() })) });
  return { side, primary, previous: identity(primary) === identity(previous) ? null : previous };
}

/** Дата обозначает выполнение анализа; время сохранения исходников не выдумывается. */
function reviewDate(bundle) {
  return new Date(bundle.report.analysis.created_at).toLocaleString("ru-RU");
}

/** Переводит причины модели без вычисления собственных правил актуальности. */
function reasonText(reason) {
  const code = typeof reason === "string" ? reason : reason.code;
  const labels = { own_code_changed: "Изменились собственные файлы", own_contract_changed: "Изменился собственный контракт",
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
  heading.append(el("strong", "", "Доказательство · " + (reference.snapshot === "baseline" ? "версия для сравнения" : "проверенная версия")), close);
  dialog.append(heading, el("p", "evidence-origin", fact ? fact.path + (fact.start_line ? " · строки " + fact.start_line + "–" + fact.end_line : " · структура модуля") : "Факт недоступен"));
  const code = el("pre", "evidence-code", fact?.text ?? reference.fact_id);
  dialog.append(code);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

/** Короткая ссылка сохраняет полное происхождение в доступном имени и подсказке. */
export function evidenceLabel(reference, fact) {
  const path = fact?.path ?? "Факт недоступен";
  return { name: path.split(/[\\/]/).at(-1),
    title: (reference.snapshot === "baseline" ? "Для сравнения" : "Проверенная версия") + " · " + path };
}

/** Нейтральные значки различают доказательства двух версий, не обещая успешной проверки. */
function evidenceIcon(side) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("evidence-icon");
  const shape = document.createElementNS(svg.namespaceURI, "path");
  shape.setAttribute("d", side === "baseline" ? "M3 5a5 5 0 1 1-1 4M1 2v4h4M8 4v4l2 1" :
    "M4 1h5l3 3v11H4zM9 1v4h3M6 8h4M6 11h4");
  svg.append(shape);
  return svg;
}

/** Кнопки открывают только известные факты выбранного неизменяемого отчёта. */
function evidenceLinks(bundle, references) {
  const links = el("div", "evidence-links");
  for (const ref of references) {
    const fact = bundle.facts[ref.snapshot].find((f) => f.id === ref.fact_id);
    const label = evidenceLabel(ref, fact);
    const button = el("button", "evidence-link");
    button.append(evidenceIcon(ref.snapshot), el("span", "", label.name));
    button.title = label.title;
    button.setAttribute("aria-label", label.title);
    button.type = "button";
    button.onclick = () => showEvidence(bundle, ref);
    links.append(button);
  }
  return links;
}

/** Сравнивает значения полей двух показанных контрактов, не вычисляя архитектурный вердикт. */
export function contractChanges(before, after, compare = true) {
  const stable = (value) => JSON.stringify(value, (_, item) => item && typeof item === "object" && !Array.isArray(item) ?
    Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
  const fields = [];
  const add = (key, oldValue, newValue) => fields.push({ key, before: oldValue, after: newValue,
    status: !compare || stable(oldValue) === stable(newValue) ? "unchanged" :
      oldValue === undefined ? "added" : newValue === undefined ? "removed" : "modified" });
  for (const key of ["id", "title", "kind", "purpose", "rationale", "owners", "tags", "references", "extensions"])
    if (before?.[key] !== undefined || after?.[key] !== undefined) add(key, before?.[key], after?.[key]);
  for (const section of Object.keys(sections)) for (const id of new Set([
    ...Object.keys(after?.[section] ?? {}), ...Object.keys(before?.[section] ?? {}),
  ])) add(section + "." + id, before?.[section]?.[id], after?.[section]?.[id]);
  return fields;
}

/**
 * Шапка — один блок из названия, типа, id и назначения. Удаление строже изменения,
 * изменение строже добавления; диф сохраняет все четыре поля обеих версий.
 * Пункты контракта и прочие метаданные не меняют статус этой группы.
 */
export function contractHeadingChange(before, after, compare = true) {
  const keys = ["title", "kind", "id", "purpose"];
  const rank = { unchanged: 0, added: 1, modified: 2, removed: 3 };
  const fields = contractChanges(before, after, compare).filter((change) => keys.includes(change.key));
  const pick = (contract) => contract == null ? undefined :
    Object.fromEntries(keys.filter((key) => contract[key] !== undefined).map((key) => [key, contract[key]]));
  return { key: "heading", before: pick(before), after: pick(after),
    status: fields.reduce((status, change) => rank[change.status] > rank[status] ? change.status : status, "unchanged") };
}

/**
 * Замечания связаны с устойчивым пунктом отдельно от изменения его текста.
 * Каждый результат ведёт в конкретную попытку анализа и конкретное замечание;
 * исходные статусы, текст и доказательства отчёта остаются неизменными.
 */
export function clauseFindingTargets(bundle, contract, section, id) {
  if (!bundle || bundle.report.module.id !== contract.id) return [];
  const side = bundle.report.module.current_path === null ? "baseline" : "current";
  const matches = (ref) => ref.snapshot === side && ref.module_id === contract.id && ref.section === section && ref.id === id;
  const saved = bundle.contracts[side].find((item) => matches(item.reference));
  if (!saved) return [];
  const findings = reviewFindingItems(bundle).filter((finding) => finding.lifecycle !== "resolved" &&
    (finding.assessmentOnly ? bundle.report.checks.some((check) => check.subject === side &&
      check.verdict === "violation" && matches(check.contract)) : finding.clauses.some(matches)));
  return findings.map((finding) => ({ reviewId: bundle.report.id, findingId: finding.id,
    severity: finding.severity, summary: finding.summary,
    label: finding.summary + " · анализ от " + reviewDate(bundle) +
      (saved.text !== contract[section]?.[id] ? " · текст пункта изменён после анализа" : "") +
      (bundle.freshness?.current.status !== "fresh" ? " · нужна перепроверка" : "") }));
}

/** Число открытых замечаний выбранной проверки; старые ответы API сохраняют общий вывод об ошибке. */
export function moduleFindingCount(module) {
  return module.review?.activeFindings ?? (module.review?.findings ||
    Number(module.review?.assessment?.current?.verdict === "violation"));
}

/**
 * Счётчики жуков для строк дерева: свои замечания видны всегда, вложенные —
 * только на свёрнутом родителе. Удалённая версия в занятом каталоге не владеет
 * его детьми; поиск передаёт фактически раскрытые каталоги и видимые модули.
 */
export function treeFindingCounts(modules, expanded) {
  const counts = new Map(modules.map((module) => [module.key, moduleFindingCount(module)]));
  const parents = new Map();
  for (const module of modules) {
    if (!parents.has(module.directory) || module.status !== "removed") parents.set(module.directory, module);
  }
  for (const module of modules) {
    const count = moduleFindingCount(module);
    if (!count || module.directory === ".") continue;
    let directory = module.directory;
    while (directory !== ".") {
      const index = directory.lastIndexOf("/");
      directory = index < 0 ? "." : directory.slice(0, index);
      const parent = parents.get(directory);
      if (parent && !expanded.has(directory)) counts.set(parent.key, counts.get(parent.key) + count);
    }
  }
  return counts;
}

/** Общий жук для пункта, вкладки и дерева, независимый от цвета изменения контракта. */
export function findingBug() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("finding-bug");
  const shape = document.createElementNS(svg.namespaceURI, "path");
  shape.setAttribute("d", "M7 7h6v6a3 3 0 0 1-6 0V7ZM8 7V5a2 2 0 0 1 4 0v2M10 8v8M7 9H4M7 12H3M7 15l-3 2M13 9h3M13 12h4M13 15l3 2M8 4 6 2M12 4l2-2");
  svg.append(shape);
  return svg;
}

/** Диф выбранного поля показывает обе сохранённые версии без чтения рабочих файлов. */
function showContractChange(change, label) {
  const dialog = el("dialog", "contract-diff-dialog");
  const heading = el("div", "evidence-heading");
  const close = el("button", "button button-quiet", "Закрыть");
  close.onclick = () => dialog.close();
  heading.append(el("strong", "", label + " · диф"), close);
  const columns = el("div", "contract-diff-columns");
  for (const [key, title, kind] of [["before", "Было", "removed"], ["after", "Стало", "added"]]) {
    const column = el("section", "contract-diff-side " + kind);
    const value = change[key];
    column.append(el("h3", "", title), el("pre", "", value === undefined ? "Отсутствует" :
      typeof value === "string" ? value : JSON.stringify(value, null, 2)));
    columns.append(column);
  }
  dialog.append(heading, columns);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

/** Выделенное поле открывает диф одинаково в заголовке и в пунктах контракта. */
function decorateContractChange(node, change, label) {
    node.classList.remove("contract-change", "change-added", "change-removed", "change-modified");
    node.querySelector(":scope > .contract-change-action")?.remove();
    node.removeAttribute("title");
    node.onclick = null;
    if (!change || change.status === "unchanged") return node;
    node.classList.add("contract-change", "change-" + change.status);
    const button = el("button", "contract-change-action",
      { added: "+", removed: "−", modified: "~" }[change.status]);
    button.type = "button";
    button.title = label + " · " + { added: "добавлено", removed: "удалено", modified: "изменено" }[change.status] + " · показать диф";
    button.setAttribute("aria-label", button.title);
    button.onclick = () => showContractChange(change, label);
    node.append(button);
    node.title = button.title;
    node.onclick = (event) => { if (!event.target.closest("button, a")) showContractChange(change, label); };
    return node;
}

/** Единый заголовок модуля содержит метаданные контракта без повторного названия. */
export function renderContractHeading(panel, document, options = {}) {
  const before = options.before === undefined ? document.contract : options.before;
  const after = options.after === undefined ? document.contract : options.after;
  const contract = after ?? before;
  const header = el("div", "contract-header");
  const title = options.titleElement ?? el("h2", "", contract.title);
  title.textContent = contract.title;
  title.className = "";
  title.removeAttribute("title");
  title.onclick = null;
  header.append(el("span", "contract-kind", contract.kind === "group" ? "ГРУППА МОДУЛЕЙ" : "КОНТРАКТ МОДУЛЯ"),
    el("code", "contract-id", contract.id));
  if (!options.titleElement) header.append(title);
  header.append(el("p", "contract-purpose", contract.purpose));
  panel.append(header);
  decorateContractChange(options.groupElement ?? header,
    contractHeadingChange(before, after, options.compare ?? true), "Описание модуля");
}

/** Контракт выделяет изменённые поля; удалённые пункты остаются в своих разделах. */
export function renderContract(panel, document, options = {}) {
  const before = options.before === undefined ? document.contract : options.before;
  const after = options.after === undefined ? document.contract : options.after;
  const contract = after ?? before;
  const changes = contractChanges(before, after, options.compare ?? true);
  const byKey = new Map(changes.map((item) => [item.key, item]));
  const decorate = (node, key, label) => decorateContractChange(node, byKey.get(key), label);
  const paper = el("article", "contract-paper");
  if (!options.hideHeading) renderContractHeading(paper, document, options);
  for (const [section, title] of Object.entries(sections)) {
    const block = el("section", "clause-section");
    block.append(el("h3", "", title));
    const entries = changes.filter((item) => item.key.startsWith(section + "."));
    if (!entries.length) block.append(el("p", "empty-clauses", "Пункты не заданы"));
    for (const change of entries) {
      const id = change.key.slice(section.length + 1);
      const row = el("div", "clause-row");
      row.dataset.contractClause = "";
      row.dataset.clauseSection = section;
      row.dataset.clauseId = id;
      row.dataset.changeStatus = change.status;
      row.append(el("code", "clause-id", id), el("p", "", change.after ?? change.before));
      decorate(row, change.key, id);
      if (change.status === "unchanged") row.title = "Пункт не изменялся";
      const findings = clauseFindingTargets(options.review, contract, section, id);
      if (findings.length) {
        const issues = el("div", "clause-issues");
        for (const finding of findings) {
          const button = el("button", "clause-issue " + finding.severity);
          button.type = "button";
          button.title = finding.label;
          button.setAttribute("aria-label", "Открыть замечание: " + finding.summary);
          button.dataset.findingId = finding.findingId;
          button.append(findingBug());
          button.onclick = () => options.openFinding?.(finding);
          button.disabled = !options.openFinding;
          issues.append(button);
        }
        row.append(issues);
      }
      block.append(row);
    }
    paper.append(block);
  }
  for (const [key, label] of [["rationale", "Обоснование"], ["owners", "Владельцы"], ["tags", "Метки"], ["extensions", "Дополнения"]]) {
    const change = byKey.get(key);
    if (!change) continue;
    const value = change.after ?? change.before;
    const text = Array.isArray(value) ? value.join(" · ") : typeof value === "string" ? value : JSON.stringify(value);
    paper.append(decorate(el("p", "contract-extra", label + ": " + text), key, label));
  }
  const references = el("div", "");
  for (const reference of contract.references ?? before?.references ?? []) {
    const row = el("p", "contract-extra");
    if (/^https?:\/\//i.test(reference.uri)) {
      const link = el("a", "", reference.title);
      link.href = reference.uri; link.target = "_blank"; link.rel = "noopener noreferrer";
      row.append(link);
    } else row.textContent = reference.title + " · " + reference.uri;
    references.append(row);
  }
  if (byKey.has("references")) {
    if (!references.childNodes.length) references.append(el("p", "contract-extra", "Ссылки: не заданы"));
    paper.append(decorate(references, "references", "Ссылки"));
  }
  const raw = el("details", "raw-document");
  raw.append(el("summary", "", "arch.yaml"));
  if (options.rawChanged && options.showRawDiff) {
    const diff = el("button", "button button-quiet", "Диф arch.yaml");
    diff.onclick = options.showRawDiff;
    raw.append(diff);
  }
  raw.append(el("pre", "", document.text));
  paper.append(raw);
  panel.append(paper);
}



/** Происхождение доступно по раскрытию; дата указана в общей строке. */
function reviewOrigin(bundle) {
  const versions = reviewVersions(bundle);
  const origin = el("details", "review-origin");
  origin.append(el("summary", "", "Версии анализа"), el("p", "", "Проверено: " + versions.current));
  if (versions.showChange) origin.append(el("p", "", "Сравнение: " + versions.baseline));
  return origin;
}

/** Показывает собственную наблюдаемую ответственность с отдельным прошлым описанием. */
function observedResponsibilities(bundle) {
  const observed = el("details", "observed-note");
  observed.append(el("summary", "", "По коду"));
  const groups = observedVersionGroups(bundle);
  const append = (target, value) => {
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

/** Действие анализа уже есть в заголовке модуля. */
function analysisNotice(title) { return el("p", "review-empty", title); }

/** Ошибка показывается один раз в замечаниях; неполный старый отчёт не скрывает общий вывод. */
export function reviewFindingItems(bundle) {
  if (bundle.report.findings.length) return bundle.report.findings;
  const current = bundle.report.assessment.current;
  return current.verdict === "violation" ? [{ id: "assessment-summary", summary: current.summary,
    assessmentOnly: true, severity: "error", clauses: [], evidence: [] }] : [];
}

/** Компактный просмотр: статус и ограничения, затем собственные проверки либо замечания. */
export function renderReview(panel, detail, mode, options = {}) {
  if (!detail.reviews.length) { panel.append(analysisNotice("Анализ не проводился")); return; }
  const overview = el("div", "review-overview"), body = el("div", "review-body");
  panel.append(overview);
  let selected = detail.reviews.findIndex((bundle) => bundle.report.id === (options.reviewId ?? detail.review?.id));
  if (selected < 0) selected = 0;
  if (detail.reviews.length > 1) {
    const picker = el("select", "review-picker");
    picker.setAttribute("aria-label", "История проверок");
    detail.reviews.forEach((bundle, index) => {
      const option = el("option", "", reviewDate(bundle));
      option.value = index; option.selected = index === selected; picker.append(option);
    });
    picker.onchange = () => draw(detail.reviews[Number(picker.value)]);
    panel.append(picker);
  }
  panel.append(body);
  draw(detail.reviews[selected]);

  /** Выбор попытки сохраняет её исходные доказательства и вычисленный статус. */
  function draw(bundle) {
    overview.replaceChildren(); body.replaceChildren();
    const report = bundle.report, freshness = bundle.freshness?.current;
    const status = freshness?.status ?? (bundle.stale ? "stale" : "unknown");
    const strip = el("div", "review-state " + status);
    strip.append(el("span", "", "Анализ · " + reviewDate(bundle)),
      el("strong", "", { fresh: "Входы без изменений", stale: "Нужна перепроверка",
        unknown: "Входы не сопоставлены", not_reviewed: "Нет проверки" }[status]));
    const reasons = [...new Set((freshness?.reasons ?? []).map(reasonText))];
    if (reasons.length) {
      const why = el("details", "review-reasons"), list = el("ul");
      why.append(el("summary", "", "Причины · " + reasons.length));
      for (const reason of reasons) list.append(el("li", "", reason));
      why.append(list); strip.append(why);
    }
    overview.append(strip);
    const checkedCoverage = reviewCoverage(bundle), coverage = el("details", "coverage-note compact-note"), list = el("ul");
    coverage.append(el("summary", "", "Проверка: " + coverageLabel(checkedCoverage)));
    for (const limitation of checkedCoverage.limitations) list.append(el("li", "",
      limitation === "Полнота зависимостей не подтверждена." ? "Не установлено, учтены ли все зависимости." : limitation));
    coverage.append(list); overview.append(coverage);
    body.append(reviewOrigin(bundle));
    if (bundle.dependencies?.length) {
      const dependencies = el("details", "coverage-note compact-note"), items = el("ul");
      dependencies.append(el("summary", "", "Зависимости · " + bundle.dependencies.length));
      for (const dependency of bundle.dependencies) items.append(el("li", "",
        (dependency.selector.module_id ?? dependency.selector.path) + " · " +
        (dependency.contractOnly ? "контракт/API · проверка поставщика: " + freshnessLabel(dependency.providerStatus) : "реализация") +
        (!dependency.available ? " · недоступна" : "")));
      dependencies.append(items); body.append(dependencies);
    }
    if (mode === "findings") {
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
          [kinds[finding.kind], { confirmed: "подтверждено", suspected: "предположение" }[finding.certainty],
            { introduced: "новое", persisting: "сохраняется", resolved: "устранено", unknown: "" }[finding.lifecycle]].filter(Boolean).join(" · ");
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
          button.onclick = () => options.openClause?.(reference);
          button.disabled = !options.openClause; clauses.append(button);
        }
        card.append(clauses, evidenceLinks(bundle, finding.evidence)); body.append(card);
      }
    } else {
      const groups = ownClauseGroups(bundle);
      body.append(observedResponsibilities(bundle), el("h3", "section-heading", "Собственные пункты · " + groups.length));
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
          result.append(evidenceLinks(bundle, check.evidence), explanation);
          card.append(result);
        }
        body.append(card);
      }
    }
    const raw = el("details", "raw-document");
    raw.append(el("summary", "", "Полный отчёт"), el("pre", "", JSON.stringify(report, null, 2))); body.append(raw);
    const target = body.querySelector(".finding-target");
    if (target) {
      target.scrollIntoView({ block: "center" });
      target.focus({ preventScroll: true });
    }
  }
}

/** Пункт разрешается по сохранённому контракту с явным владельцем. */
function clauseDescription(bundle, ref) {
  return bundle.contracts[ref.snapshot].find((item) => item.reference.module_id === ref.module_id &&
    item.reference.section === ref.section && item.reference.id === ref.id)?.text ?? "Пункт вне сохранённого контракта";
}

/** В собственном чеклисте достаточно номера и текста. */
function clauseText(bundle, ref) {
  const row = el("p", "check-clause");
  row.append(el("code", "clause-id", ref.module_id === bundle.report.module.id ? ref.id : ref.module_id + " / " + ref.id),
    el("span", "", clauseDescription(bundle, ref)));
  return row;
}
