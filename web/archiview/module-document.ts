import type { ModuleDetail, ComparisonView, ClauseReference, ReviewBundle, FindingTarget } from "./types.js";
import { byId, el, icon, notice } from "./dom.js";
import { badge } from "./change-status.js";
import { renderContract, savedClauseText, clauseSectionLabel } from "./contract.js";
import { moduleTrail } from "./module-path.js";
import { timelineDate, timelineLabel } from "./timeline.js";

/** Показывает структурированный контракт либо исторический документ удалённого модуля. */
export function renderDocument(panel: HTMLElement, detail: ModuleDetail, view: ComparisonView,
  selectModule: (key: string) => Promise<void>, openFinding: (target: FindingTarget) => void) {
  const selected = detail.after ?? detail.before;
  if (!selected) return;
  if (detail.status === "removed") panel.append(notice("Модуль удалён",
    "Показано описание из выбранной базы сравнения.", "removed-notice"));
  if (selected.document.state === "documented" && selected.document.contract) {
    if (detail.moved) panel.append(notice("Модуль перемещён", detail.baselinePath + " → " + detail.currentPath));
    renderContract(panel, selected.document, { contractDiff: detail.contractDiff, previousReferences: detail.before?.document.contract?.references,
      rawChanged: detail.documentChanged, showRawDiff: () => openDocumentDiff(detail, view), hideHeading: true,
      review: detail.reviews.find((bundle) => bundle.report.id === detail.review?.id) ?? detail.reviews[0],
      openFinding }); return;
  }
  if (selected.document.state !== "documented") {
    const box = notice(selected.document.state === "missing" ? "arch.yaml ещё не создан" :
      selected.document.state === "empty" ? "Описание модуля пустое" : selected.document.state === "migration_required" ? "Нужно перенести module.md в arch.yaml" : "Контракт недоступен или содержит ошибки",
    selected.document.errors?.join("; ") ?? selected.document.action ?? "Нужно проанализировать исходники и родительские контракты, затем записать arch.yaml.", "missing-notice");
    const parent = moduleTrail(view.modules, detail).slice(0, -1).findLast(({ module }) => module.documentState === "documented");
    if (parent !== undefined) {
      const button = el("button", "text-button", "Открыть описание родителя →");
      button.type = "button";
      button.addEventListener("click", () => selectModule(parent.module.key));
      box.append(button);
    }
    panel.append(box);
    return;
  }
  panel.append(notice("Исторический документ", "Содержимое сохранено в прежнем снимке."),
    el("pre", "evidence-code", selected.document.text ?? ""));
}

/** Показывает построчную разницу контрактов с координатами обеих версий. */
function renderDiff(panel: HTMLElement, detail: ModuleDetail, view: ComparisonView) {
  if (!detail.documentChanged) {
    panel.append(notice("Описание ответственности не менялось",
      detail.filesChanged ? "Изменения файлов этого модуля доступны на вкладке «Файлы»." :
        "Документ и собственные файлы модуля совпадают с выбранной базой."));
    return;
  }
  if (!detail.diff.length) {
    panel.append(notice("Изменилось наличие контракта",
      detail.after?.document.state === "empty" ? "Добавлен пустой документ модуля." :
        "Документ модуля удалён. Текстовых изменений нет."));
    return;
  }
  const added = detail.diff.filter((row) => row.kind === "added").length;
  const removed = detail.diff.filter((row) => row.kind === "removed").length;
  const heading = el("div", "diff-heading");
  heading.append(icon("file"), el("strong", "", (detail.after ?? detail.before)?.documentPath),
    el("span", "diff-added-count", "+" + added), el("span", "diff-removed-count", "−" + removed));
  const labels = el("div", "diff-labels");
  labels.append(el("span", "", "Было"), el("span", "", "Стало"),
    el("span", "", view.before.label + " → " + timelineLabel(view.target)));
  const rows = el("div", "diff-lines");
  for (const row of detail.diff) {
    const line = el("div", "diff-line " + row.kind);
    line.append(el("span", "line-number", row.beforeLine ?? ""),
      el("span", "line-number", row.afterLine ?? ""),
      el("span", "line-sign", row.kind === "added" ? "+" : row.kind === "removed" ? "−" : " "),
      el("code", "line-content", row.text || " "));
    rows.append(line);
  }
  const box = el("div", "diff-box");
  box.append(heading, labels, rows);
  panel.append(box);
}

/** Открывает исходный YAML-диф из контракта без отдельного представления модуля. */
function openDocumentDiff(detail: ModuleDetail, view: ComparisonView) {
  const dialog = el("dialog", "contract-diff-dialog");
  const heading = el("div", "evidence-heading");
  const close = el("button", "button button-quiet", "Закрыть");
  close.onclick = () => dialog.close();
  heading.append(el("strong", "", "arch.yaml · изменения"), close);
  dialog.append(heading);
  renderDiff(dialog, detail, view);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

/**
 * Показывает сохранённую версию пункта, когда текущий контракт его не содержит.
 * Текст и сторона снимка берутся из неизменяемого пакета проверки, а не из
 * рабочего документа; карточка ставится перед контрактом и получает фокус.
 */
export function renderHistoricalClause(reference: ClauseReference, review: ReviewBundle, explanation: string) {
  const panel = byId("document-panel");
  const saved = savedClauseText(review, reference);
  const created = review?.report?.analysis?.created_at;
  const card = el("div", "notice missing-notice historical-clause");
  card.dataset.historicalClause = "";
  card.append(el("strong", "", "Пункт сохранённой проверки · " +
    reference.module_id + " / " + reference.id));
  const origin = [clauseSectionLabel(reference.section),
    reference.snapshot === "baseline" ? "версия для сравнения" : "проверенная версия",
    created && timelineDate(created) ? "анализ от " + timelineDate(created) : null].filter(Boolean).join(" · ");
  card.append(el("p", "historical-clause-origin", origin),
    saved ? el("p", "historical-clause-text", saved) :
      el("p", "historical-clause-missing", "Пункт не входит в сохранённый контракт этой проверки."),
    el("p", "historical-clause-note", explanation));
  panel.prepend(card);
  card.scrollIntoView({ block: "center" });
  card.tabIndex = -1;
  card.focus({ preventScroll: true });
}

/** Показывает файлы выбранного модуля и их индивидуальные статусы. */
export function renderFiles(panel: HTMLElement, detail: ModuleDetail, copyText: (text: string) => Promise<void>) {
  const changed = new Map(detail.files.map((file) => [file.path, file.status]));
  const paths = [...new Set([...(detail.before?.files ?? []).map((file) => file.path),
    ...(detail.after?.files ?? []).map((file) => file.path)])].sort((a, b) =>
    Number(changed.has(b)) - Number(changed.has(a)) || a.localeCompare(b));
  const box = el("div", "files-box");
  const header = el("div", "files-heading");
  header.append(el("strong", "", "Файлы модуля"), el("span", "", paths.length + " всего"));
  box.append(header);
  if (!paths.length) box.append(el("p", "file-empty", "Собственных файлов нет. Откройте вложенный модуль."));
  for (const file of paths) {
    const row = el("div", "file-row");
    row.title = file;
    row.append(icon("file"), el("code", "file-path", file.split("/").at(-1)), badge(changed.get(file) ?? "unchanged", true));
    const copy = el("button", "text-button", "Путь");
    copy.type = "button";
    copy.setAttribute("aria-label", "Копировать путь " + file);
    copy.addEventListener("click", () => copyText(file));
    row.append(copy);
    box.append(row);
  }
  panel.append(box);
}
