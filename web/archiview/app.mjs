/**
 * Клиент ArchiView: навигация, фильтры и представление документов.
 * Статусы получает от сервера; Контракты и доказательства вставляет безопасным текстом.
 * Сравнение остаётся привязанным к неизменяемому view, включая удалённые модули.
 */
import { renderContract, renderContractHeading, renderReview, freshnessLabel,
  findingBug, moduleFindingCount, treeFindingCounts, savedClauseText, clauseSectionLabel } from "./review.mjs";
import { connectPanel } from "./panel-bridge.mjs";
import { createArchiViewClient } from "./client.mjs";

/** Локальное состояние интерфейса, не изменяющее исходные документы проекта. */
const state = { view: null, detail: null, selected: null, tab: "document",
  filter: "all", search: "", expanded: new Set(), selection: 0, refresh: 0,
  target: "current", historyLimit: 50, bridge: null, analyses: new Map(), findingFixes: new Map() };
/** Транспорт задаёт точка сборки; интерфейс работает с одинаковыми прикладными методами. */
const transportMode = document.querySelector('meta[name="archiview-transport"]')?.content ?? "http";
/** Префикс маршрутов плагина хоста; пустой означает корень сервера (standalone и Codex). */
const transportBase = document.querySelector('meta[name="archiview-base"]')?.content ?? "";
/** Чат, которому принадлежит страница: по нему хост разрешает корень проекта. */
const transportSession = document.querySelector('meta[name="archiview-session"]')?.content ?? "";
const connection = connectPanel();
const client = createArchiViewClient({ mode: transportMode, connection, base: transportBase,
  sessionId: transportSession });
/** Человекочитаемые подписи сравнительных статусов. */
const labels = { initial: "Первый", new: "Новый", changed: "Изменён", removed: "Удалён", unchanged: "Без изменений" };
/** Статические SVG-значки, не содержащие пользовательских строк. */
const icons = {
  folder: '<path d="M3 6.5h6l2 2h10v11H3z"/><path d="M3 9h18"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 12h6m-6 4h6"/>',
  refresh: '<path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 0-2 5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
};

/** Возвращает элемент по фиксированному идентификатору страницы. */
function byId(id) { return document.getElementById(id); }

/** Создаёт DOM-элемент и вставляет пользовательский текст безопасным textContent. */
function el(tag, className = "", text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Формирует значок исключительно из локального каталога SVG. */
function icon(name) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("fill", "none");
  node.setAttribute("aria-hidden", "true");
  node.innerHTML = icons[name] ?? icons.file;
  return node;
}

/**
 * Обновляет действие для выбранного модуля: хосту отправляет поручение, в браузере
 * предлагает копирование промпта. Ожидание импорта не мешает скопировать его повторно.
 */
function configureAnalysisButton(button) {
  const module = state.view?.modules.find((entry) => entry.key === state.selected);
  const request = state.analyses.get(module?.moduleId);
  const pending = request && request.status !== "completed" && request.status !== "error";
  const sendToHost = Boolean(state.bridge?.send);
  const busy = request?.status === "preparing";
  button.dataset.analysis = "true";
  button.disabled = (!sendToHost && transportMode === "mcp") || !state.view?.complete ||
    module?.documentState !== "documented" || !module?.moduleId || busy || (sendToHost && Boolean(pending));
  button.textContent = busy ? "Подготавливаем…" : sendToHost ?
    (pending ? "Ожидаем анализ…" : "Анализировать модуль") : "Копировать промпт";
  button.title = !sendToHost && transportMode === "mcp" ? "Хост не поддерживает отправку поручений из панели" :
    module?.documentState !== "documented" ? "Сначала подготовьте корректный arch.yaml" :
    sendToHost ? "Проверить выбранный снимок модуля агентом хоста" : "Скопировать промпт для анализа выбранного снимка модуля";
  button.onclick = runAnalysis;
}

/** Статус относится к конкретному запросу; принятие сообщения не выдаётся за запуск или завершение модели. */
function renderAnalysisControls() {
  for (const button of document.querySelectorAll("[data-analysis]")) configureAnalysisButton(button);
  const module = state.view?.modules.find((entry) => entry.key === state.selected);
  const request = state.analyses.get(module?.moduleId);
  const status = byId("analysis-status");
  status.hidden = !request;
  status.textContent = request?.message ?? "";
}

/**
 * Фиксирует входы через сервис и передаёт промпт агенту хоста либо в буфер обмена.
 * Повторное копирование использует тот же запрос только для того же view; успешное
 * копирование означает подготовку поручения, а завершение подтверждается импортом.
 */
async function runAnalysis() {
  const module = state.view?.modules.find((entry) => entry.key === state.selected);
  const sendToHost = Boolean(state.bridge?.send);
  if (!module || (!sendToHost && transportMode === "mcp")) return;
  const previous = state.analyses.get(module.moduleId);
  if (previous?.status === "preparing" || (sendToHost && previous && !["completed", "error"].includes(previous.status))) return;
  clearTimeout(previous?.timer);
  const record = !sendToHost && previous?.prompt && previous.viewId === state.view.id && previous.status !== "completed" ?
    previous : {};
  record.status = "preparing";
  record.message = "Подготавливаем входы выбранного снимка…";
  state.analyses.set(module.moduleId, record);
  renderAnalysisControls();
  try {
    if (!record.prompt) Object.assign(record,
      await client.prepareAnalysis({ view: state.view.id, path: module.key }), { status: "preparing" });
    if (sendToHost) {
      await state.bridge.send(record.prompt);
      record.message = "Поручение передано агенту хоста. Ожидаем импорт результата для выбранного снимка.";
    } else {
      await navigator.clipboard.writeText(record.prompt);
      record.message = "Промпт скопирован. Вставьте его в чат с агентом. Ожидаем импорт результата для выбранного снимка.";
      toast("Промпт для анализа модуля скопирован");
    }
    record.status = "prepared";
    pollAnalysis(record);
  } catch (error) {
    record.status = "error";
    record.message = (sendToHost ? "Не удалось передать анализ: " : "Не удалось скопировать промпт: ") + error.message;
  }
  renderAnalysisControls();
}

/** Проверяет только статус запроса; полное сравнение обновляется после реального импорта. */
function pollAnalysis(record) {
  clearTimeout(record.timer);
  record.timer = setTimeout(async () => {
    if (document.visibilityState === "hidden") return pollAnalysis(record);
    try {
      const status = await client.getAnalysis({ id: record.id });
      if (status.status === "completed") {
        record.status = "completed";
        record.message = "Анализ выбранного снимка сохранён. Актуальность показана в результатах проверки.";
        await refresh();
      } else pollAnalysis(record);
    } catch (error) {
      record.message = "Не удалось обновить статус: " + error.message;
      pollAnalysis(record);
    }
    renderAnalysisControls();
  }, 3000);
}

/** Отображает краткое подтверждение действия без модального прерывания просмотра. */
function toast(message) {
  const node = byId("toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 4000);
}

/** Хронология различает изменения, снятые в пределах одной минуты. */
function timelineDate(value) {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  return new Intl.DateTimeFormat("ru-RU", { year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

/** Подписи отражают пользовательские состояния без внутренних имён снимков. */
function timelineLabel(entry) {
  if (entry.id === "current" || entry.kind === "current") return "Текущее состояние";
  if (entry.kind === "git") return entry.isHead ? "HEAD" : "Revision " + (entry.revision ?? entry.id.replace(/^git-/, "")).slice(0, 8);
  if (entry.kind === "change") return "Изменение " + timelineDate(entry.capturedAt);
  return entry.label;
}

/**
 * Один список выбирает просматриваемое состояние. Текущее и самые свежие
 * изменения идут первыми; базу сравнения определяет сервер. Сохранённые вручную
 * снимки доступны здесь же, а подгрузка старых коммитов не меняет выбор.
 */
function renderTimeline() {
  const picker = byId("timeline");
  picker.replaceChildren();
  const entries = state.view.timeline ?? [{ id: "current", kind: "current", label: "Текущее состояние" }];
  const saved = (state.view.baselines ?? []).filter(entry => entry.kind === "saved" && !entries.some(item => item.id === entry.id))
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  const options = [...entries].reverse().concat(saved);
  // После нового коммита прежняя локальная точка исчезает из активной истории,
  // но её открытый просмотр должен сохранять видимое выбранное значение.
  if (state.view.target && !options.some(entry => entry.id === state.target)) options.push(state.view.target);
  for (const entry of options) {
    const label = timelineLabel(entry);
    const option = el("option", "", label);
    option.value = entry.id;
    option.selected = entry.id === state.target;
    option.title = [label, entry.kind === "current" ? "Сжатый результат" : entry.subject, entry.revision].filter(Boolean).join("\n");
    picker.append(option);
  }
  if (state.view.historyHasMore) {
    const more = el("option", "", "Загрузить ранние коммиты…");
    more.value = "load-earlier";
    picker.append(more);
  }
  picker.title = picker.selectedOptions[0]?.title ?? "Хронология";
}

/** Представляет статус цветом и подписью, доступной без различения цветов. */
function badge(status, small = false, descendantChanges = 0) {
  const title = descendantChanges && status === "unchanged" ? "Изменены подмодули" :
    descendantChanges && status === "changed" ? "Изменены модуль и подмодули" : labels[status];
  return el("span", "status-badge " + status + (small ? " small" : ""), title);
}

/** Возвращает цепочку каталогов выбранного модуля от корня проекта. */
function ancestors(directory) {
  if (directory === ".") return ["."];
  const parts = directory.split("/");
  return [".", ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))];
}

/**
 * Управляет только шириной навигации: pointer capture удерживает перетаскивание
 * за пределами границы, клавиатура предоставляет те же действия. Предпочтение
 * сохраняется локально; узкий экран ограничивает размер, не стирая выбранную ширину.
 */
function initializeTreeWidth() {
  const shell = byId("app-shell");
  const separator = byId("tree-resizer");
  const mobile = matchMedia("(max-width: 800px)");
  const storageKey = "archiview.tree-width";
  const defaultWidth = 420;
  const minimum = 260;
  const documentMinimum = 420;
  let preferred = defaultWidth;
  let drag = null;
  try {
    const saved = localStorage.getItem(storageKey);
    const width = saved === null ? NaN : Number(saved);
    if (Number.isFinite(width) && width >= minimum) preferred = Math.min(800, width);
  } catch { /* Запрет браузерного хранилища не мешает регулировке в текущей вкладке. */ }

  /** Сохраняет место документу и отражает фактические пределы в доступном разделителе. */
  function applyWidth(value) {
    const maximum = Math.max(minimum, Math.min(800, shell.clientWidth - separator.offsetWidth - documentMinimum));
    const width = Math.round(Math.max(minimum, Math.min(maximum, value)));
    shell.style.setProperty("--tree-width", width + "px");
    separator.setAttribute("aria-valuemax", String(maximum));
    separator.setAttribute("aria-valuenow", String(width));
    separator.setAttribute("aria-valuetext", width + " пикселей");
    return width;
  }

  /** Записывает только явное предпочтение пользователя, не временное ограничение окна. */
  function rememberWidth() {
    try { localStorage.setItem(storageKey, String(preferred)); } catch {}
  }

  /** Снимает захват и визуальное состояние; отмена возвращает размер до жеста. */
  function finishDrag(commit = true) {
    if (!drag) return;
    const previous = drag;
    drag = null;
    if (!commit) { preferred = previous.preferred; applyWidth(preferred); }
    document.body.classList.remove("resizing-tree");
    if (separator.hasPointerCapture(previous.pointerId)) separator.releasePointerCapture(previous.pointerId);
    if (commit) rememberWidth();
  }

  separator.addEventListener("pointerdown", (event) => {
    if (mobile.matches || event.button !== 0 || !event.isPrimary || drag) return;
    drag = { pointerId: event.pointerId, x: event.clientX,
      width: byId("module-sidebar").getBoundingClientRect().width, preferred };
    separator.setPointerCapture(event.pointerId);
    separator.focus({ preventScroll: true });
    document.body.classList.add("resizing-tree");
    event.preventDefault();
  });
  separator.addEventListener("pointermove", (event) => {
    if (event.pointerId === drag?.pointerId) preferred = applyWidth(drag.width + event.clientX - drag.x);
  });
  separator.addEventListener("pointerup", (event) => {
    if (event.pointerId === drag?.pointerId) finishDrag();
  });
  separator.addEventListener("pointercancel", () => finishDrag(false));
  separator.addEventListener("lostpointercapture", () => finishDrag());
  separator.addEventListener("dblclick", () => {
    if (mobile.matches) return;
    preferred = applyWidth(defaultWidth); rememberWidth();
  });
  separator.addEventListener("keydown", (event) => {
    if (mobile.matches || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Escape" && drag) { event.preventDefault(); finishDrag(false); return; }
    if (drag) return;
    const width = Number(separator.getAttribute("aria-valuenow"));
    const step = event.shiftKey ? 48 : 16;
    const targets = { ArrowLeft: width - step, ArrowRight: width + step,
      Home: minimum, End: Number(separator.getAttribute("aria-valuemax")), Enter: defaultWidth };
    if (!Object.hasOwn(targets, event.key)) return;
    event.preventDefault();
    preferred = applyWidth(targets[event.key]); rememberWidth();
  });
  window.addEventListener("blur", () => finishDrag());
  window.addEventListener("resize", () => {
    finishDrag(false);
    if (!mobile.matches) applyWidth(preferred);
  });
  if (!mobile.matches) applyWidth(preferred);
}

/** Перерисовывает счётчики и сохраняет выбранный статус фильтра. */
function renderFilters() {
  const filters = byId("filters");
  filters.replaceChildren();
  const total = state.view.modules.length;
  for (const status of ["all", "initial", "new", "changed", "removed", "unchanged"]) {
    const count = status === "all" ? total : state.view.counts[status];
    const button = el("button", "filter-chip " + status +
      (state.filter === status ? " active" : ""));
    button.type = "button";
    button.setAttribute("aria-pressed", String(state.filter === status));
    button.append(el("span", "filter-dot"), el("span", "", status === "all" ? "Все" : labels[status]),
      el("span", "filter-count", count));
    button.addEventListener("click", () => {
      state.filter = status;
      renderFilters();
      renderTree();
    });
    filters.append(button);
  }
  byId("module-total").textContent = total;
}

/** Строит отфильтрованное дерево, оставляя предков совпавших модулей видимыми. */
function renderTree() {
  const tree = byId("tree");
  tree.replaceChildren();
  if (!state.view) return;
  const visible = new Set();
  const matches = new Set();
  for (const module of state.view.modules) {
    if (state.filter !== "all" && module.status !== state.filter) continue;
    if (state.search && !module.directory.toLowerCase().includes(state.search) &&
        !module.name.toLowerCase().includes(state.search) && !module.title?.toLowerCase().includes(state.search) && !module.moduleId?.toLowerCase().includes(state.search)) continue;
    matches.add(module.directory);
    for (const parent of ancestors(module.directory)) visible.add(parent);
  }
  if (!matches.size) {
    const empty = el("div", "empty-tree");
    empty.append(el("strong", "", "Модули не найдены"),
      el("p", "", "Попробуйте другой запрос или статус."));
    tree.append(empty);
    return;
  }
  const children = new Map();
  for (const module of state.view.modules) {
    if (!visible.has(module.directory) || module.directory === ".") continue;
    const index = module.directory.lastIndexOf("/");
    const parent = index < 0 ? "." : module.directory.slice(0, index);
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(module);
  }
  const roots = state.view.modules.filter((module) => module.directory === ".");
  const searching = state.search.length > 0 || state.filter !== "all";
  const visibleModules = state.view.modules.filter((module) => visible.has(module.directory));
  const findingCounts = treeFindingCounts(visibleModules,
    searching ? new Set(visibleModules.map((module) => module.directory)) : state.expanded);
  const render = (module) => {
    const item = el("li", "tree-item");
    item.setAttribute("role", "none");
    const row = el("button", "tree-row" +
      (state.selected === module.key ? " selected" : "") +
      (!matches.has(module.directory) ? " context-row" : "") +
      (module.status === "removed" ? " removed-row" : ""));
    row.type = "button";
    row.dataset.directory = module.directory;
    row.dataset.key = module.key;
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-selected", String(state.selected === module.key));
    const title = module.title?.trim() || module.name;
    row.title = title + "\n" + module.directory;
    const nested = module.status === "removed" && state.view.modules.some((m) => m.directory === module.directory && m !== module) ? [] : children.get(module.directory) ?? [];
    const expanded = searching || state.expanded.has(module.directory);
    if (nested.length) row.setAttribute("aria-expanded", String(expanded));
    const caret = el("span", "tree-caret", nested.length ? "›" : "");
    caret.dataset.toggle = "true";
    if (expanded) caret.classList.add("expanded");
    const label = el("span", "tree-label");
    label.append(el("span", "tree-name", title));
    if (title !== module.name) label.append(el("span", "tree-path", module.name));
    row.append(caret, icon("folder"), label);
    const findings = findingCounts.get(module.key) ?? 0;
    if (findings) {
      const marker = el("span", "finding-marker");
      marker.title = "Открытые замечания" + (findings > moduleFindingCount(module) ? " в модуле и вложенных модулях" : " модуля") + " · " + findings;
      marker.setAttribute("role", "img");
      marker.setAttribute("aria-label", marker.title);
      marker.append(findingBug());
      row.append(marker);
    }
    if (module.documentState !== "documented") {
      const marker = el("span", "missing-marker", "!");
      marker.title = module.documentState === "missing" ? "Нет arch.yaml" : "Контракт требует исправления";
      row.append(marker);
    }
    if (module.descendantChanges) {
      const count = el("span", "descendant-count", module.descendantChanges);
      count.title = "Изменённые вложенные модули";
      row.append(count);
    }
    if (module.reviewStatus) {
      // Проверка и оценка изменения независимы: значок предупреждает, если
      // перепроверки требует хотя бы одна из двух оценок поддерева.
      const subtree = module.reviewStatus.subtree;
      const values = [subtree.current, subtree.change].filter(Boolean);
      const tone = values.find((value) => value.status === "stale") ? "stale" :
        values.find((value) => value.status !== "fresh")?.status ?? "fresh";
      const review = el("span", "review-marker " + tone,
        values.some((value) => value.conflict || value.current_violation) ? "!" : tone === "fresh" ? "◉" : "◷");
      review.title = "Поддерево · проверка: " + freshnessLabel(subtree.current, { compact: true }) +
        " · оценка изменения: " + freshnessLabel(subtree.change, { compact: true });
      row.append(review);
    }
    row.append(badge(module.status, true, module.descendantChanges));
    row.addEventListener("click", (event) => {
      if (event.target.closest("[data-toggle]") && nested.length) {
        if (state.expanded.has(module.directory)) state.expanded.delete(module.directory);
        else state.expanded.add(module.directory);
        renderTree();
      } else selectModule(module.key);
    });
    item.append(row);
    if (nested.length) {
      const group = el("ul", "tree-group");
      group.setAttribute("role", "group");
      group.hidden = !expanded;
      for (const child of nested) group.append(render(child));
      item.append(group);
    }
    return item;
  };
  const list = el("ul", "tree-root");
  list.setAttribute("role", "group");
  for (const root of roots) list.append(render(root));
  tree.append(list);
}

/** Обновляет хлебные крошки, статус и контекст выбранного каталога. */
function renderHeading(module) {
  const group = byId("module-heading-content");
  group.className = "module-heading-content";
  group.removeAttribute("title");
  group.onclick = null;
  group.querySelector(":scope > .contract-change-action")?.remove();
  byId("module-title").className = "";
  byId("module-title").removeAttribute("title");
  byId("module-title").onclick = null;
  byId("module-title").textContent = module.title ?? module.name;
  byId("module-status").replaceChildren(badge(module.status, false, module.descendantChanges));
  byId("module-subtitle").textContent = module.directory === "." ?
    "Корневой модуль проекта" : module.directory;
  byId("module-subtitle").hidden = false;
  byId("module-contract-heading").replaceChildren();
  byId("module-contract-heading").hidden = true;
  const breadcrumbs = byId("breadcrumbs");
  breadcrumbs.replaceChildren();
  for (const [index, directory] of ancestors(module.directory).entries()) {
    if (index) breadcrumbs.append(el("span", "breadcrumb-separator", "/"));
    const button = el("button", "breadcrumb", directory === "." ?
      state.view.modules[0].name : directory.split("/").at(-1));
    button.type = "button";
    button.addEventListener("click", () => selectModule(directory));
    breadcrumbs.append(button);
  }
  const meta = byId("module-meta");
  meta.replaceChildren();
  const documentLabel = module.documentState === "invalid" ? "Ошибка формата" : module.documentState === "missing" ? "Описание отсутствует" :
    module.documentState === "empty" ? "Описание пустое" :
      module.documentChanged ? "Описание изменено" : "Описание без изменений";
  for (const [label, value] of [["Контракт", documentLabel],
    ["Файлы", module.filesChanged + " изменено"],
    ["Подмодули", module.descendantChanges + " с изменениями"]]) {
    const item = el("div", "meta-item");
    item.append(el("span", "meta-label", label), el("span", "meta-value", value));
    meta.append(item);
  }
  byId("copy-path").disabled = false;
  // Собственная проверка и оценка изменения, затем то же для поддерева.
  // Статусы объединяются только подписью: актуальность входов не подменяется.
  const reviewStatuses = module.reviewStatus ? "Модуль · проверка: " +
    freshnessLabel(module.reviewStatus.self.current, { compact: true }) + " · оценка изменения: " +
    freshnessLabel(module.reviewStatus.self.change, { compact: true }) + " · Поддерево · проверка: " +
    freshnessLabel(module.reviewStatus.subtree.current, { compact: true }) + " · оценка изменения: " +
    freshnessLabel(module.reviewStatus.subtree.change, { compact: true }) : "Содержательной проверки нет";
  byId("review-status").textContent = reviewStatuses;
  byId("files-count").textContent = module.filesChanged;
  byId("files-count").hidden = module.filesChanged === 0;
  const findings = module.review?.findings ?? 0;
  byId("tab-findings").textContent = "Замечания" + (findings ? " · " + findings : "");
  if (moduleFindingCount(module)) byId("tab-findings").prepend(findingBug());
  document.title = module.name + " — ArchiView";
  renderAnalysisControls();
}

/** Загружает детали из того же снимка сравнения, что и дерево слева. */
async function selectModule(directory) {
  const module = state.view.modules.find((item) => item.key === directory) ?? state.view.modules.find((item) => item.directory === directory);
  if (!module) return;
  state.selected = module.key;
  state.detail = null;
  const token = ++state.selection;
  for (const parent of ancestors(module.directory)) state.expanded.add(parent);
  // URL sandbox-ресурса принадлежит хосту; about:srcdoc и opaque origins
  // запрещают replaceState. Обычная веб-страница сохраняет собственный hash.
  if (transportMode === "http") history.replaceState(null, "", "#" + encodeURIComponent(directory));
  renderHeading(module);
  renderTree();
  document.body.classList.remove("tree-open");
  byId("document-panel").replaceChildren(el("div", "loading-state", "Читаем документ…"));
  try {
    const detail = await client.getModule({ view: state.view.id, path: module.key });
    if (token !== state.selection) return;
    state.detail = detail;
    renderPanel();
  } catch (error) {
    if (token === state.selection) renderFailure(error);
  }
}

/** Создаёт уведомление в контексте документа, не подменяя его содержимое. */
function notice(title, description, kind = "") {
  const box = el("div", "notice " + kind);
  box.append(el("strong", "", title), el("p", "", description));
  return box;
}

/** Показывает структурированный контракт либо исторический документ удалённого модуля. */
function renderDocument(panel, detail) {
  const selected = detail.after ?? detail.before;
  if (detail.status === "removed") panel.append(notice("Модуль удалён",
    "Показано описание из выбранной базы сравнения.", "removed-notice"));
  if (selected.document.state === "documented" && selected.document.contract) {
    if (detail.moved) panel.append(notice("Модуль перемещён", detail.baselinePath + " → " + detail.currentPath));
    renderContract(panel, selected.document, { before: detail.before?.document.contract ?? null,
      after: detail.after?.document.contract ?? null, compare: detail.status !== "initial",
      rawChanged: detail.documentChanged, showRawDiff: () => openDocumentDiff(detail), hideHeading: true,
      review: detail.reviews.find((bundle) => bundle.report.id === detail.review?.id) ?? detail.reviews[0],
      openFinding: openReviewFinding }); return;
  }
  if (selected.document.state !== "documented") {
    const box = notice(selected.document.state === "missing" ? "arch.yaml ещё не создан" :
      selected.document.state === "empty" ? "Описание модуля пустое" : selected.document.state === "migration_required" ? "Нужно перенести module.md в arch.yaml" : "Контракт недоступен или содержит ошибки",
    selected.document.errors?.join("; ") ?? selected.document.action ?? "Нужно проанализировать исходники и родительские контракты, затем записать arch.yaml.", "missing-notice");
    const parent = ancestors(detail.directory).slice(0, -1).reverse().find((directory) =>
      state.view.modules.some((module) => module.directory === directory &&
        module.documentState === "documented"));
    if (parent !== undefined) {
      const button = el("button", "text-button", "Открыть описание родителя →");
      button.type = "button";
      button.addEventListener("click", () => selectModule(parent));
      box.append(button);
    }
    panel.append(box);
    return;
  }
  panel.append(notice("Исторический документ", "Содержимое сохранено в прежнем снимке."),
    el("pre", "evidence-code", selected.document.text ?? ""));
}

/** Показывает построчную разницу контрактов с координатами обеих версий. */
function renderDiff(panel, detail) {
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
  heading.append(icon("file"), el("strong", "", (detail.after ?? detail.before).documentPath),
    el("span", "diff-added-count", "+" + added), el("span", "diff-removed-count", "−" + removed));
  const labels = el("div", "diff-labels");
  labels.append(el("span", "", "Было"), el("span", "", "Стало"),
    el("span", "", state.view.before.label + " → рабочее дерево"));
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
function openDocumentDiff(detail) {
  const dialog = el("dialog", "contract-diff-dialog");
  const heading = el("div", "evidence-heading");
  const close = el("button", "button button-quiet", "Закрыть");
  close.onclick = () => dialog.close();
  heading.append(el("strong", "", "arch.yaml · изменения"), close);
  dialog.append(heading);
  renderDiff(dialog, detail);
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}

/**
 * Переходит из замечания к конкретному пункту контракта его владельца. Сохранённая
 * попытка и сторона снимка задают ожидаемый пункт: если активное сравнение его уже
 * не содержит, вместо молчаливого перехода показывается явная историческая карточка.
 */
async function openReviewClause(reference, review) {
  byId("document-panel").querySelectorAll("[data-historical-clause]").forEach((node) => node.remove());
  const module = state.view.modules.find((item) => item.moduleId === reference.module_id);
  state.tab = "document";
  if (!module) {
    // Владельца нет в сравнении: документ остаётся прежним, но карточка
    // сохранённого пункта явно объясняет причину перехода.
    renderPanel();
    renderHistoricalClause(reference, review,
      "Модуль не входит в активное сравнение, поэтому показан только сохранённый пункт проверки.");
    return;
  }
  await selectModule(module.key);
  const row = [...document.querySelectorAll("[data-contract-clause]")].find((item) =>
    item.dataset.clauseSection === reference.section && item.dataset.clauseId === reference.id);
  if (row) {
    row.scrollIntoView({ block: "center" });
    row.classList.add("clause-target");
    row.tabIndex = -1;
    row.focus({ preventScroll: true });
    return;
  }
  renderHistoricalClause(reference, review,
    "В активном сравнении этого пункта нет: контракт изменился после сохранённой проверки.");
}

/**
 * Показывает сохранённую версию пункта, когда текущий контракт его не содержит.
 * Текст и сторона снимка берутся из неизменяемого пакета проверки, а не из
 * рабочего документа; карточка ставится перед контрактом и получает фокус.
 */
function renderHistoricalClause(reference, review, explanation) {
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

/** Жук открывает конкретное замечание той попытки, из которой он был показан. */
function openReviewFinding(target) {
  state.tab = "findings";
  renderPanel({ reviewId: target.reviewId, findingId: target.findingId });
}

/** Показывает файлы выбранного модуля и их индивидуальные статусы. */
function renderFiles(panel, detail) {
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

/** Переключает представления одного модуля, сохраняя навигацию и базу сравнения. */
function renderPanel(navigation = {}) {
  for (const button of document.querySelectorAll("[data-tab]")) {
    button.setAttribute("aria-selected", String(button.dataset.tab === state.tab));
  }
  const panel = byId("document-panel");
  panel.setAttribute("aria-labelledby", "tab-" + state.tab);
  if (!state.detail) return;
  panel.replaceChildren();
  const heading = byId("module-contract-heading");
  const selected = state.detail.after ?? state.detail.before;
  heading.replaceChildren();
  heading.hidden = !selected.document.contract;
  byId("module-subtitle").hidden = Boolean(selected.document.contract);
  if (selected.document.contract) renderContractHeading(heading, selected.document, {
    before: state.detail.before?.document.contract ?? null, after: state.detail.after?.document.contract ?? null,
    compare: state.detail.status !== "initial", titleElement: byId("module-title"), groupElement: byId("module-heading-content"),
  });
  byId("document-version").textContent = state.detail.status === "removed" ?
    "Из базы сравнения" : timelineLabel(state.view.target ?? { id: "current" });
  if (state.tab === "document") renderDocument(panel, state.detail);
  else if (["checks", "findings"].includes(state.tab)) {
    // Копирование доступно самостоятельной странице; встроенный хост без
    // capability отправки показывает недоступное действие, не меняя транспорт.
    const send = state.bridge?.send;
    const copying = !send && transportMode === "http" && transportBase === "";
    renderReview(panel, state.detail, state.tab, { openClause: openReviewClause,
      projectRoot: state.view.root, fixStates: state.findingFixes, fixMode: copying ? "copy" : "send",
      fixFinding: send ? (prompt) => send(prompt) : copying ? (prompt) => navigator.clipboard.writeText(prompt) : undefined,
      fixChanged: (reviewId) => {
        if (state.tab === "findings" && panel.querySelector(".review-body")?.dataset.reviewId === reviewId)
          renderPanel({ reviewId });
      },
      ...navigation });
  }
  else renderFiles(panel, state.detail);
  renderAnalysisControls();
}

/** Объясняет ошибку загрузки и предлагает повторить доступное действие. */
function renderFailure(error) {
  if (error.code === "PROJECT_REQUIRED") return renderProjectSelection();
  const box = notice("Не удалось открыть данные", error.message, "removed-notice");
  const retry = el("button", "button button-quiet", "Повторить");
  retry.type = "button";
  retry.addEventListener("click", () => refresh());
  box.append(retry);
  byId("document-panel").replaceChildren(box);
}

/** Прямое открытие плагина не содержит пути чата; пользователь выбирает его один раз. */
function renderProjectSelection() {
  byId("project-name").textContent = "Выберите проект";
  byId("project-path").textContent = "";
  byId("tree").replaceChildren();
  const box = notice("Папка проекта", "Укажите абсолютный путь к проекту.");
  const form = el("form", "project-form");
  const input = el("input");
  input.type = "text";
  input.required = true;
  input.setAttribute("aria-label", "Папка проекта");
  input.placeholder = "D:\\projects\\my-project";
  const submit = el("button", "button", "Открыть проект");
  submit.type = "submit";
  const error = el("p");
  error.setAttribute("role", "alert");
  form.append(input, submit, error);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    error.textContent = "";
    try {
      await client.setProject({ projectRoot: input.value.trim() });
      await refresh();
    } catch (cause) { error.textContent = cause.message; }
    finally { submit.disabled = false; }
  });
  box.append(form);
  byId("document-panel").replaceChildren(box);
}

/** Обновляет дерево целиком; выбранные модуль и состояние сохраняются, если доступны. */
async function refresh(options = {}) {
  const token = ++state.refresh;
  const button = byId("refresh");
  button.disabled = true;
  byId("timeline").disabled = true;
  button.classList.add("is-loading");
  try {
    const selectedTarget = options.target ?? state.target;
    const view = await client.getComparison({ target: selectedTarget, baseline: "auto", historyLimit: state.historyLimit });
    if (token !== state.refresh) return;
    state.view = view;
    state.target = view.target?.id ?? selectedTarget;
    renderTimeline();
    byId("project-name").textContent = view.modules[0]?.name ?? "Проект";
    byId("project-path").textContent = view.root;
    byId("project-path").title = view.root;
    byId("warning").hidden = view.complete && !view.reviewDiagnostics.length;
    byId("warning").textContent = [...view.diagnostics, ...view.reviewDiagnostics].join("; ");
    byId("updated").textContent = state.target === "current" ? "Обновлено " + new Intl.DateTimeFormat("ru-RU",
      { hour: "2-digit", minute: "2-digit" }).format(new Date(view.after.capturedAt)) : "Состояние от " + timelineDate(view.after.capturedAt);
    if (!state.expanded.size && view.modules.length < 100) {
      for (const module of view.modules) state.expanded.add(module.directory);
    }
    renderFilters();
    let hash;
    try { hash = decodeURIComponent(location.hash.slice(1)); } catch {}
    const selected = [state.selected, hash, "."].find((directory) =>
      view.modules.some((module) => module.key === directory)) ?? view.modules[0]?.key;
    if (selected !== undefined) await selectModule(selected);
  } catch (error) { renderFailure(error); }
  finally {
    if (token === state.refresh) {
      button.disabled = false; button.classList.remove("is-loading");
      byId("timeline").value = state.target;
      byId("timeline").disabled = !state.view;
    }
  }
}

/** Копирует путь выбранного модуля или файла без изменения документов. */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast("Путь скопирован"); }
  catch { toast(text); }
}

initializeTreeWidth();
connection.then((bridge) => {
  state.bridge = bridge;
  renderAnalysisControls();
  if (state.detail && state.tab === "findings") renderPanel();
});
byId("refresh").prepend(icon("refresh"));
byId("refresh").addEventListener("click", () => refresh());
byId("timeline").addEventListener("change", (event) => {
  if (event.target.value === "load-earlier") {
    state.historyLimit += 50;
    event.target.value = state.target;
    refresh();
  } else refresh({ target: event.target.value });
});
byId("search").addEventListener("input", (event) => {
  state.search = event.target.value.trim().toLowerCase();
  renderTree();
});
byId("collapse").addEventListener("click", () => {
  state.expanded = new Set(["."]);
  renderTree();
});
byId("tree-toggle").addEventListener("click", () => document.body.classList.toggle("tree-open"));
byId("copy-path").addEventListener("click", () => {
  if (state.detail) copyText(state.detail.directory === "." ? state.view.root :
    state.view.root.replace(/[\\/]$/, "") + "/" + state.detail.directory);
});
for (const tab of document.querySelectorAll("[data-tab]")) {
  tab.addEventListener("click", () => { state.tab = tab.dataset.tab; renderPanel(); });
}
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    byId("search").focus();
  }
});
byId("tree").addEventListener("keydown", (event) => {
  const row = event.target.closest(".tree-row");
  if (!row) return;
  const rows = [...byId("tree").querySelectorAll(".tree-row")].filter((node) => node.offsetParent);
  const index = rows.indexOf(row);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    rows[Math.max(0, Math.min(rows.length - 1, index +
      (event.key === "ArrowDown" ? 1 : -1)))].focus();
  } else if (["ArrowLeft", "ArrowRight"].includes(event.key) && row.hasAttribute("aria-expanded")) {
    event.preventDefault();
    const directory = row.dataset.directory;
    if (event.key === "ArrowRight") state.expanded.add(directory);
    else state.expanded.delete(directory);
    renderTree();
    [...byId("tree").querySelectorAll(".tree-row")].find((node) =>
      node.dataset.directory === directory)?.focus();
  }
});
await refresh();
