import type { ModuleDetail, ComparisonView, ClauseReference, ReviewBundle, FindingTarget } from "../types.js";
import { isModuleDocumentFile } from "../../../framework/project/storage-paths.js";
import { byId, el, icon, notice } from "./dom.js";
import { labels } from "./change-status.js";
import { renderContract, renderContractRoles, savedClauseText, clauseSectionLabel } from "./contract.js";
import { moduleTrail } from "../module-presenter/module-path.js";
import { timelineDate } from "../workspace-presenter/timeline.js";
import { diffBox, diffLine, openDiffDialog } from "./diff.js";
import type { ClauseControls } from "../module-presenter/clause-editor.js";

/** Показывает структурированный контракт либо исторический документ удалённого модуля. */
export function renderDocument(panel: HTMLElement, detail: ModuleDetail, view: ComparisonView,
  selectModule: (key: string) => Promise<void>, openFinding: (target: FindingTarget) => void, clauseControls?: ClauseControls) {
  const selected = detail.after ?? detail.before;
  if (!selected) return;
  if (detail.status === "removed") panel.append(notice("Модуль удалён",
    "Показано описание из выбранной базы сравнения.", "removed-notice"));
  if (selected.document.state === "documented" && selected.document.contract) {
    if (detail.moved) panel.append(notice("Модуль перемещён", detail.baselinePath + " → " + detail.currentPath));
    renderContract(panel, { ...selected.document, text: detail.contractYaml ?? selected.document.text },
      { contractDiff: detail.contractDiff, previousReferences: detail.before?.document.contract?.references,
      rawChanged: detail.documentChanged, showRawDiff: () => openDocumentDiff(detail, view), hideHeading: true,
      review: detail.reviews.find((bundle) => bundle.report.id === detail.review?.id) ?? detail.reviews[0],
      openFinding, clauseControls }); return;
  }
  if (selected.document.state !== "documented") {
    const box = notice(selected.document.state === "missing" ? "Контракт модуля ещё не создан" :
      selected.document.state === "empty" ? "Описание модуля пустое" : "Контракт недоступен или содержит ошибки",
    selected.document.errors?.join("; ") ?? selected.document.action ?? "Проверьте запись в .archiview/modules.tree и YAML-контракт модуля.", "missing-notice");
    const parent = moduleTrail(view.modules, detail).slice(0, -1).findLast(({ module }) => module.documentState === "documented");
    if (parent !== undefined) {
      const button = el("button", "text-button", "Открыть описание родителя →");
      button.type = "button";
      button.addEventListener("click", () => selectModule(parent.module.key));
      box.append(button);
    }
    panel.append(box);
    if (selected.document.state === "missing") renderContractRoles(panel, detail.contractDiff);
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
  const rows = diffBox(panel, (detail.after ?? detail.before)!.documentPath, view, added, removed);
  for (const row of detail.diff) rows.append(diffLine(row));
}

/** Открывает исходный YAML-диф из контракта без отдельного представления модуля. */
function openDocumentDiff(detail: ModuleDetail, view: ComparisonView) {
  renderDiff(openDiffDialog("Изменения контракта"), detail, view);
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

/** Каждая сторона сравнения задаёт свой каталог модуля, в том числе при переносе. */
export function renderFiles(panel: HTMLElement, detail: ModuleDetail, copyText: (text: string) => Promise<void>,
  collapsedDirectories: Set<string>, showDiff: (file: string) => void) {
  const changed = new Map(detail.files.map((file) => [file.path, file.status]));
  const relativePaths = new Map<string, string>();
  for (const side of [detail.before, detail.after]) {
    if (!side) continue;
    const prefix = side.directory === "." ? "" : side.directory + "/";
    for (const { path } of side.files) {
      if (!isModuleDocumentFile(path, side.documentPath) && path.startsWith(prefix)) relativePaths.set(path, path.slice(prefix.length));
    }
  }
  const paths = [...relativePaths].sort(([a, relativeA], [b, relativeB]) =>
    Number(changed.has(b)) - Number(changed.has(a)) || relativeA.localeCompare(relativeB) || a.localeCompare(b));
  const box = el("div", "files-box");
  const header = el("div", "files-heading");
  header.append(el("strong", "", "Файлы модуля"), el("span", "", paths.length + " всего"));
  box.append(header);
  if (!paths.length) box.append(el("p", "file-empty", "Собственных файлов нет. Откройте вложенный модуль."));
  const directories = new Map<string, HTMLDetailsElement>();
  function directoryGroup(path: string): HTMLElement {
    if (!path) return box;
    const existing = directories.get(path);
    if (existing) return existing;

    const slash = path.lastIndexOf("/");
    const parent = directoryGroup(path.substring(0, slash));
    const group = el("details", "file-directory");
    const summary = el("summary");
    summary.title = path + "/";
    summary.append(icon("folder"), el("code", "", path.slice(slash + 1) + "/"));
    group.append(summary);
    group.open = !collapsedDirectories.has(path);
    group.addEventListener("toggle", () => {
      if (!group.isConnected) return;
      if (group.open) collapsedDirectories.delete(path);
      else collapsedDirectories.add(path);
    });
    directories.set(path, group);
    parent.append(group);
    return group;
  }

  for (const [file, relative] of paths) {
    const slash = relative.lastIndexOf("/");
    const row = el("div", "file-row");
    row.title = file;
    const status = changed.get(file) ?? "unchanged";
    const button = el("button", "status-badge small " + status, labels[status]);
    button.type = "button";
    button.title = "Открыть просмотр файла";
    button.setAttribute("aria-label", labels[status] + " — " + file);
    button.setAttribute("aria-haspopup", "dialog");
    button.addEventListener("click", () => showDiff(file));
    row.append(icon("file"), el("code", "file-path", relative.slice(slash + 1)), button);
    const copy = el("button", "text-button", "Путь");
    copy.type = "button";
    copy.setAttribute("aria-label", "Копировать путь " + file);
    copy.addEventListener("click", () => copyText(file));
    row.append(copy);
    directoryGroup(relative.substring(0, slash)).append(row);
  }
  panel.append(box);
}
