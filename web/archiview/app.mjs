/**
 * Клиент ArchiView: навигация, фильтры и представление документов.
 * Статусы получает от сервера; Контракты и доказательства вставляет безопасным текстом.
 * Сравнение остаётся привязанным к неизменяемому view, включая удалённые модули.
 */
import { renderContract, renderReview } from "/review.mjs";

/** Локальное состояние интерфейса, не изменяющее исходные документы проекта. */
const state = { view: null, detail: null, selected: null, tab: "document",
  filter: "all", search: "", expanded: new Set(), selection: 0, refresh: 0 };
/** Человекочитаемые подписи сравнительных статусов. */
const labels = { initial: "Первый", new: "Новый", changed: "Изменён", removed: "Удалён", unchanged: "Без изменений" };
/** Статические SVG-значки, не содержащие пользовательских строк. */
const icons = {
  folder: '<path d="M3 6.5h6l2 2h10v11H3z"/><path d="M3 9h18"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 12h6m-6 4h6"/>',
  refresh: '<path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 0-2 5"/>',
  save: '<path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5"/>',
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

/** Выполняет запрос к собственному API, сохраняя серверную причину ошибки. */
async function api(url, options) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? "Не удалось получить данные");
  return result;
}

/** Отображает краткое подтверждение действия без модального прерывания просмотра. */
function toast(message) {
  const node = byId("toast");
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { node.hidden = true; }, 4000);
}

/** Форматирует UTC-время снимка в локальное время пользователя. */
function date(value) {
  return new Intl.DateTimeFormat("ru-RU", { dateStyle: "short", timeStyle: "short" })
    .format(new Date(value));
}

/** Представляет статус цветом и подписью, доступной без различения цветов. */
function badge(status, small = false) {
  return el("span", "status-badge " + status + (small ? " small" : ""), labels[status]);
}

/** Возвращает цепочку каталогов выбранного модуля от корня проекта. */
function ancestors(directory) {
  if (directory === ".") return ["."];
  const parts = directory.split("/");
  return [".", ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))];
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
    row.title = module.directory;
    const nested = module.status === "removed" && state.view.modules.some((m) => m.directory === module.directory && m !== module) ? [] : children.get(module.directory) ?? [];
    const expanded = searching || state.expanded.has(module.directory);
    if (nested.length) row.setAttribute("aria-expanded", String(expanded));
    const caret = el("span", "tree-caret", nested.length ? "›" : "");
    caret.dataset.toggle = "true";
    if (expanded) caret.classList.add("expanded");
    row.append(caret, icon("folder"), el("span", "tree-name", module.name));
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
    if (module.review) {
      const review = el("span", "review-marker" + (module.review.stale ? " stale" : ""), module.review.stale ? "◷" : "◉");
      review.title = module.review.stale ? "Проверка устарела" : "Есть результат проверки"; row.append(review);
    }
    row.append(badge(module.status, true));
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
  byId("module-title").textContent = module.title ?? module.name;
  byId("module-status").replaceChildren(badge(module.status));
  byId("module-subtitle").textContent = module.directory === "." ?
    "Корневой модуль проекта" : module.directory;
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
  byId("review-status").textContent = module.review ? (module.review.stale ? "Проверка устарела" : "Есть проверка") : "Проверки нет";
  byId("files-count").textContent = module.filesChanged;
  byId("files-count").hidden = module.filesChanged === 0;
  byId("diff-count").textContent = module.documentChanged ? "1" : "";
  byId("diff-count").hidden = !module.documentChanged;
  document.title = module.name + " — ArchiView";
}

/** Загружает детали из того же снимка сравнения, что и дерево слева. */
async function selectModule(directory) {
  const module = state.view.modules.find((item) => item.key === directory) ?? state.view.modules.find((item) => item.directory === directory);
  if (!module) return;
  state.selected = module.key;
  state.detail = null;
  const token = ++state.selection;
  for (const parent of ancestors(module.directory)) state.expanded.add(parent);
  history.replaceState(null, "", "#" + encodeURIComponent(directory));
  renderHeading(module);
  renderTree();
  document.body.classList.remove("tree-open");
  byId("document-panel").replaceChildren(el("div", "loading-state", "Читаем документ…"));
  try {
    const detail = await api("/api/module?" + new URLSearchParams({
      view: state.view.id, path: module.key,
    }));
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
    renderContract(panel, selected.document); return;
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
    row.append(icon("file"), el("code", "file-path", file), badge(changed.get(file) ?? "unchanged", true));
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
function renderPanel() {
  for (const button of document.querySelectorAll("[data-tab]")) {
    button.setAttribute("aria-selected", String(button.dataset.tab === state.tab));
  }
  const panel = byId("document-panel");
  panel.setAttribute("aria-labelledby", "tab-" + state.tab);
  if (!state.detail) return;
  panel.replaceChildren();
  byId("document-version").textContent = state.detail.status === "removed" ?
    "Из базы сравнения" : "Рабочее дерево";
  if (state.tab === "document") renderDocument(panel, state.detail);
  else if (["checks", "findings"].includes(state.tab)) renderReview(panel, state.detail, state.tab, generateReview);
  else if (state.tab === "diff") renderDiff(panel, state.detail);
  else renderFiles(panel, state.detail);
}

/** Объясняет ошибку загрузки и предлагает повторить доступное действие. */
function renderFailure(error) {
  const box = notice("Не удалось открыть данные", error.message, "removed-notice");
  const retry = el("button", "button button-quiet", "Повторить");
  retry.type = "button";
  retry.addEventListener("click", () => refresh());
  box.append(retry);
  byId("document-panel").replaceChildren(box);
}

/** Обновляет дерево целиком; модуль и выбранная база сохраняются, если доступны. */
async function refresh(baseline) {
  const token = ++state.refresh;
  const button = byId("refresh");
  button.disabled = true;
  button.classList.add("is-loading");
  try {
    const selectedBase = baseline ?? state.view?.before.id;
    const view = await api("/api/comparison" +
      (selectedBase ? "?" + new URLSearchParams({ baseline: selectedBase }) : ""));
    if (token !== state.refresh) return;
    state.view = view;
    byId("project-name").textContent = view.modules[0]?.name ?? "Проект";
    byId("project-path").textContent = view.root;
    byId("project-path").title = view.root;
    const picker = byId("baseline");
    picker.replaceChildren();
    for (const base of view.baselines) {
      const option = el("option", "", base.label +
        (base.kind === "saved" ? " · " + date(base.capturedAt) : ""));
      option.value = base.id;
      option.selected = base.id === view.before.id;
      picker.append(option);
    }
    picker.disabled = false;
    byId("save").disabled = !view.complete;
    byId("warning").hidden = view.complete && !view.reviewDiagnostics.length;
    byId("warning").textContent = [...view.diagnostics, ...view.reviewDiagnostics].join("; ");
    byId("updated").textContent = "Обновлено " + new Intl.DateTimeFormat("ru-RU",
      { hour: "2-digit", minute: "2-digit" }).format(new Date(view.after.capturedAt));
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
  finally { if (token === state.refresh) { button.disabled = false; button.classList.remove("is-loading"); } }
}

/** Копирует путь выбранного модуля или файла без изменения документов. */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast("Путь скопирован"); }
  catch { toast(text); }
}

/** Сохраняет структурную проверку именно показанной пары снимков. */
async function generateReview() {
  try {
    await api("/api/reviews", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ view: state.view.id, path: state.selected }) });
    toast("Структурная проверка сохранена");
    await refresh();
  } catch (error) { toast(error.message); }
}

byId("refresh").prepend(icon("refresh"));
byId("save").prepend(icon("save"));
byId("refresh").addEventListener("click", () => refresh());
byId("baseline").addEventListener("change", (event) => refresh(event.target.value));
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
byId("save").addEventListener("click", () => {
  byId("snapshot-label").value = "Снимок · " + date(new Date().toISOString());
  byId("snapshot-dialog").showModal();
  byId("snapshot-label").select();
});
byId("cancel-save").addEventListener("click", () => byId("snapshot-dialog").close());
byId("snapshot-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = event.submitter;
  submit.disabled = true;
  try {
    await api("/api/snapshots", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ view: state.view.id, label: byId("snapshot-label").value }) });
    byId("snapshot-dialog").close();
    toast("Снимок сохранён и доступен в выборе базы");
    await refresh();
  } catch (error) { toast(error.message); }
  finally { submit.disabled = false; }
});
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
