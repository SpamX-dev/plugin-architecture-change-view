import type { ComparisonView, ModuleSummary } from "./types.js";
import { byId, el, icon } from "./dom.js";
import { badge, labels } from "./change-status.js";
import { findingBug, moduleFindingCount, treeFindingCounts } from "./findings.js";
import { freshnessLabel } from "./review-status.js";
import { roleBadge } from "./role-badge.js";

import { treeParents } from "./module-path.js";

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
  let drag: { pointerId: number; x: number; width: number; preferred: number } | null = null;
  try {
    const saved = localStorage.getItem(storageKey);
    const width = saved === null ? NaN : Number(saved);
    if (Number.isFinite(width) && width >= minimum) preferred = Math.min(800, width);
  } catch { /* Запрет браузерного хранилища не мешает регулировке в текущей вкладке. */ }

  /** Сохраняет место документу и отражает фактические пределы в доступном разделителе. */
  function applyWidth(value: number) {
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
    if (drag && event.pointerId === drag.pointerId) preferred = applyWidth(drag.width + event.clientX - drag.x);
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
    const targets: Record<string, number> = { ArrowLeft: width - step, ArrowRight: width + step,
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

export function createModuleTree(getView: () => ComparisonView | null, getSelection: () => string | null,
  selectModule: (key: string, repository?: string) => Promise<void>) {
  let filter = "all";
  let search = "";
  // Keep expansion and cached comparisons separate even when two checkouts have identical modules.
  const trees = new Map<string, { view: ComparisonView; expanded: Set<string>; historyLimit: number }>();
  const closed = new Set<string>();
  let treeRoot: string | undefined;

  /** Перерисовывает счётчики и сохраняет выбранный статус фильтра. */
  function renderFilters() {
    const filters = byId("filters");
    filters.replaceChildren();
    const view = getView();
    if (!view) return;
    const loaded = [...trees.values()].map((entry) => entry.view);
    const total = loaded.reduce((count, entry) => count + entry.modules.length, 0);
    for (const status of ["all", "initial", "new", "changed", "removed", "unchanged"]) {
      const count = status === "all" ? total : loaded.reduce((sum, entry) => sum + (entry.counts[status] ?? 0), 0);
      const button = el("button", "filter-chip " + status +
        (filter === status ? " active" : ""));
      button.type = "button";
      button.setAttribute("aria-pressed", String(filter === status));
      button.append(el("span", "filter-dot"), el("span", "", status === "all" ? "Все" : labels[status]),
        el("span", "filter-count", count));
      button.addEventListener("click", () => {
        filter = status;
        renderFilters();
        renderTree();
      });
      filters.append(button);
    }
    byId("module-total").textContent = String(total);
  }

  /** Строит отфильтрованное дерево, оставляя предков совпавших модулей видимыми. */
  function renderTree() {
    const tree = byId("tree");
    tree.replaceChildren();
    const view = getView();
    if (!view) return;
    if (!view.workspace) {
      renderModules(tree, view, trees.get("")!.expanded);
      return;
    }
    for (const repository of view.workspace.repositories) {
      const cached = trees.get(repository);
      const open = Boolean(cached && !closed.has(repository));
      const section = el("div", "repository-section");
      section.setAttribute("role", "none");
      const label = repository === "." ? view.workspace.root.split(/[\\/]/).at(-1) || "." : repository;
      const header = el("button", "tree-row repository-row");
      header.type = "button";
      header.dataset.repositoryRoot = repository;
      header.setAttribute("role", "treeitem");
      header.setAttribute("aria-expanded", String(open));
      const caret = el("span", "tree-caret" + (open ? " expanded" : ""), "›");
      caret.dataset.toggle = "true";
      header.append(caret, icon("folder"), el("span", "repository-name", label));
      header.title = label;
      const activate = (toggle: boolean) => {
        if (toggle && cached) {
          if (open) closed.add(repository); else closed.delete(repository);
          renderTree();
          focusRepository(repository);
        } else {
          closed.delete(repository);
          void selectModule(".", repository);
        }
      };
      header.addEventListener("click", (event) => activate(event.target instanceof Element && !!event.target.closest("[data-toggle]")));
      header.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        event.stopPropagation();
        if ((event.key === "ArrowRight") !== open) activate(true);
      });
      section.append(header);
      if (open && cached) renderModules(section, cached.view, cached.expanded, repository);
      tree.append(section);
    }
  }

  function focusRepository(repository: string) {
    [...byId("tree").querySelectorAll<HTMLButtonElement>("[data-repository-root]")]
      .find((node) => node.dataset.repositoryRoot === repository)?.focus();
  }

  function renderModules(tree: HTMLElement, view: ComparisonView, expanded: Set<string>, repository?: string) {
    const visible = new Set<string>();
    const matches = new Set<string>();
    const parents = treeParents(view.modules);
    for (const module of view.modules) {
      if (filter !== "all" && module.status !== filter) continue;
      if (search && !module.directory.toLowerCase().includes(search) &&
          !module.name.toLowerCase().includes(search) && !module.title?.toLowerCase().includes(search) && !module.moduleId?.toLowerCase().includes(search)) continue;
      matches.add(module.key);
      let row: ModuleSummary | undefined = module;
      while (row && !visible.has(row.key)) {
        visible.add(row.key);
        row = parents.get(row.key);
      }
    }
    if (!matches.size) {
      const empty = el("div", "empty-tree");
      empty.append(el("strong", "", "Модули не найдены"),
        el("p", "", "Попробуйте другой запрос или статус."));
      tree.append(empty);
      return;
    }
    const children = new Map<string, ModuleSummary[]>();
    const visibleModules = view.modules.filter((module) => visible.has(module.key));
    const roots: ModuleSummary[] = [];
    for (const module of visibleModules) {
      const parent = parents.get(module.key);
      if (!parent) { roots.push(module); continue; }
      if (!children.has(parent.key)) children.set(parent.key, []);
      children.get(parent.key)!.push(module);
    }
    const searching = search.length > 0 || filter !== "all";
    const findingCounts = treeFindingCounts(visibleModules,
      searching ? visible : expanded, parents);
    const render = (module: ModuleSummary): HTMLLIElement => {
      const item = el("li", "tree-item");
      item.setAttribute("role", "none");
      const selected = getView()?.workspace?.repository === repository && getSelection() === module.key;
      const row = el("button", "tree-row" +
        (selected ? " selected" : "") +
        (!matches.has(module.key) ? " context-row" : "") +
        (module.status === "removed" ? " removed-row" : ""));
      row.type = "button";
      row.dataset.directory = module.directory;
      row.dataset.key = module.key;
      if (repository !== undefined) row.dataset.repository = repository;
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-selected", String(selected));
      const title = module.title?.trim() || module.name;
      row.title = title + "\n" + module.directory;
      const nested = children.get(module.key) ?? [];
      const isExpanded = searching || expanded.has(module.key);
      if (nested.length) row.setAttribute("aria-expanded", String(isExpanded));
      const caret = el("span", "tree-caret", nested.length ? "›" : "");
      caret.dataset.toggle = "true";
      if (isExpanded) caret.classList.add("expanded");
      const label = el("span", "tree-label");
      label.append(el("span", "tree-name", title));
      if (title !== module.name) label.append(el("span", "tree-path", module.name));
      if (module.roles?.length) {
        const roles = el("span", "tree-roles");
        roles.append(...module.roles.map(roleBadge));
        label.append(roles);
        row.title += "\nРоли по контракту: " + module.roles.map(role => role.id).join(" · ");
      }
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
        marker.title = module.documentState === "missing" ? "Нет контракта модуля" : "Контракт требует исправления";
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
        if ((event.target instanceof Element ? event.target : null)?.closest("[data-toggle]") && nested.length) {
          if (expanded.has(module.key)) expanded.delete(module.key);
          else expanded.add(module.key);
          renderTree();
        } else void selectModule(module.key, repository);
      });
      item.append(row);
      if (nested.length) {
        const group = el("ul", "tree-group");
        group.setAttribute("role", "group");
        group.hidden = !isExpanded;
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

  function showComparison(view: ComparisonView, historyLimit: number) {
    const root = view.workspace?.root ?? view.root;
    if (treeRoot !== root) {
      trees.clear();
      closed.clear();
      treeRoot = root;
    }
    const repository = view.workspace?.repository ?? "";
    for (const key of trees.keys()) {
      if (key !== repository && !view.workspace?.repositories.includes(key)) {
        trees.delete(key);
        closed.delete(key);
      }
    }
    const expanded = trees.get(repository)?.expanded ?? new Set(view.modules.length < 100 ? view.modules.map((module) => module.key) : []);
    trees.set(repository, { view, expanded, historyLimit });
    closed.delete(repository);
    const repositoryCount = view.workspace?.repositories.length ?? trees.size;
    const partial = trees.size < repositoryCount;
    const searchInput = byId("search");
    const searchLabel = partial ? "Найти модуль в загруженных репозиториях" : "Найти модуль";
    const scope = partial ? `Поиск и счётчики учитывают загруженные репозитории (${trees.size} из ${repositoryCount}). Раскройте остальные, чтобы добавить их модули.` : "";
    searchInput.placeholder = searchLabel + "…";
    searchInput.setAttribute("aria-label", searchLabel);
    searchInput.title = scope;
    byId("module-total").title = scope;
    byId("filters").title = scope;
    renderFilters();
    renderTree();
  }

  function reveal(module: ModuleSummary) {
    const view = getView();
    if (!view) return;
    const repository = view.workspace?.repository ?? "";
    const expanded = trees.get(repository)!.expanded;
    closed.delete(repository);
    const parents = treeParents(view.modules);
    let row: ModuleSummary | undefined = module;
    while (row) {
      expanded.add(row.key);
      row = parents.get(row.key);
    }
    renderTree();
  }

  initializeTreeWidth();
  byId("search").addEventListener("input", (event) => {
    search = (event.target as HTMLInputElement | HTMLSelectElement).value.trim().toLowerCase();
    renderTree();
  });
  byId("collapse").addEventListener("click", () => {
    for (const [repository, { expanded, view }] of trees) {
      expanded.clear();
      if (view.workspace) closed.add(repository);
      else for (const module of view.modules) if (module.directory === ".") expanded.add(module.key);
    }
    renderTree();
  });
  byId("tree-toggle").addEventListener("click", () => document.body.classList.toggle("tree-open"));

  document.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      byId("search").focus();
    }
  });
  byId("tree").addEventListener("keydown", (event) => {
    const row = (event.target instanceof Element ? event.target : null)?.closest<HTMLButtonElement>(".tree-row");
    if (!row) return;
    const rows = [...byId("tree").querySelectorAll<HTMLButtonElement>(".tree-row")].filter((node) => node.offsetParent);
    const index = rows.indexOf(row);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      rows[Math.max(0, Math.min(rows.length - 1, index +
        (event.key === "ArrowDown" ? 1 : -1)))].focus();
    } else if (["ArrowLeft", "ArrowRight"].includes(event.key) && row.hasAttribute("aria-expanded")) {
      event.preventDefault();
      const key = row.dataset.key;
      if (!key) return;
      const expanded = trees.get(row.dataset.repository ?? "")!.expanded;
      if (event.key === "ArrowRight") expanded.add(key);
      else expanded.delete(key);
      renderTree();
      [...byId("tree").querySelectorAll<HTMLButtonElement>(".tree-row")].find((node) =>
        node.dataset.key === key && node.dataset.repository === row.dataset.repository)?.focus();
    }
  });
  return { showComparison, reveal, getRepository: (repository: string) => trees.get(repository) };
}
