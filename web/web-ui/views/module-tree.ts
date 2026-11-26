import type { ChangeStatus, ModuleSummary } from "../view-model/types.js";
import { byId, el, findingMarker, icon } from "./dom.js";
import { createTreeChangeTooltip, labels, treeChangeBadges } from "./change-status.js";
import { roleBadge } from "./role-badge.js";
import { initializeTreeWidth } from "./tree-layout.js";

export type Filter = ChangeStatus | "all";
export interface ModuleRow {
  module: ModuleSummary;
  selected: boolean;
  context: boolean;
  expanded: boolean;
  finding?: string;
  cycle?: string;
  analysis: string | null;
  children: ModuleRow[];
}
export interface TreeSection {
  repository?: { key: string; label: string; loaded: boolean; expanded: boolean };
  rows: ModuleRow[];
}

interface TreeActions {
  selectModule(key: string, repository?: string): void;
  expandModule(key: string, repository?: string, expand?: boolean): void;
  selectRepository(repository: string): void;
  toggleRepository(repository: string): void;
  filter(status: Filter): void;
  search(value: string): void;
  collapse(): void;
}

export function createTreeView(actions: TreeActions) {
  const tree = byId("tree");
  const hideChangeTooltip = createTreeChangeTooltip(tree);
  const search = byId("search");
  initializeTreeWidth();
  search.addEventListener("input", () => actions.search(search.value));
  byId("collapse").addEventListener("click", actions.collapse);
  byId("tree-toggle").addEventListener("click", () => document.body.classList.toggle("tree-open"));
  document.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      search.focus();
    }
  });
  tree.addEventListener("keydown", event => {
    const row = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".tree-row") : null;
    if (!row) return;
    const { key, repository } = row.dataset;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const rows = [...tree.querySelectorAll<HTMLButtonElement>(".tree-row")].filter(node => node.offsetParent);
      const next = rows.indexOf(row) + (event.key === "ArrowDown" ? 1 : -1);
      rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
    } else if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && key && row.hasAttribute("aria-expanded")) {
      event.preventDefault();
      actions.expandModule(key, repository, event.key === "ArrowRight");
      [...tree.querySelectorAll<HTMLButtonElement>(".tree-row")].find(node => node.dataset.key === key && node.dataset.repository === repository)?.focus();
    }
  });

  function renderFilters(filters: { status: Filter; count: number }[], selected: Filter, total: number) {
    const buttons = filters.map(({status, count}) => {
      const button = el("button", "filter-chip " + status + (selected === status ? " active" : ""));
      button.type = "button";
      button.setAttribute("aria-pressed", String(selected === status));
      button.append(el("span", "filter-dot"), el("span", "", status === "all" ? "Все" : labels[status]), el("span", "filter-count", count));
      button.addEventListener("click", () => actions.filter(status));
      return button;
    });
    byId("filters").replaceChildren(...buttons);
    byId("module-total").textContent = String(total);
  }

  function repositoryHeader({key, label, loaded, expanded}: NonNullable<TreeSection["repository"]>) {
    const header = el("button", "tree-row repository-row");
    header.type = "button";
    header.dataset.repositoryRoot = key;
    header.setAttribute("role", "treeitem");
    header.setAttribute("aria-expanded", String(expanded));
    const caret = el("span", "tree-caret" + (expanded ? " expanded" : ""), "›");
    caret.dataset.toggle = "true";
    header.append(caret, icon("folder"), el("span", "repository-name", label));
    header.title = label;
    const activate = (toggle: boolean) => {
      if (toggle && loaded) {
        actions.toggleRepository(key);
        [...tree.querySelectorAll<HTMLButtonElement>("[data-repository-root]")].find(node => node.dataset.repositoryRoot === key)?.focus();
      } else actions.selectRepository(key);
    };
    header.addEventListener("click", event => activate(event.target instanceof Element && !!event.target.closest("[data-toggle]")));
    header.addEventListener("keydown", event => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      event.stopPropagation();
      if ((event.key === "ArrowRight") !== expanded) activate(true);
    });
    return header;
  }

  function moduleItem(data: ModuleRow, repository?: string): HTMLLIElement {
    const { module, selected, context, expanded, children, finding, cycle, analysis } = data;
    const item = el("li", "tree-item");
    item.setAttribute("role", "none");
    const row = el("button", "tree-row" + (selected ? " selected" : "") + (context ? " context-row" : "") +
      (module.status === "removed" ? " removed-row" : ""));
    row.type = "button";
    row.dataset.directory = module.directory;
    row.dataset.key = module.key;
    if (repository !== undefined) row.dataset.repository = repository;
    row.setAttribute("role", "treeitem");
    row.setAttribute("aria-selected", String(selected));
    const title = module.title?.trim() || module.name;
    row.title = title + "\n" + module.directory;
    if (children.length) row.setAttribute("aria-expanded", String(expanded));
    const caret = el("span", "tree-caret" + (expanded ? " expanded" : ""), children.length ? "›" : "");
    caret.dataset.toggle = "true";
    const label = el("span", "tree-label");
    label.append(el("span", "tree-name", title));
    if (module.prototypeModule) label.append(el("span", "tree-path", "Прототип"));
    if (title !== module.name) label.append(el("span", "tree-path", module.name));
    if (module.roles?.length) {
      const roles = el("span", "tree-roles");
      roles.append(...module.roles.map(roleBadge));
      label.append(roles);
      row.title += "\nРоли по контракту: " + module.roles.map(role => role.id).join(" · ");
    }
    row.append(caret, icon("folder"), label);
    if (finding) row.append(findingMarker(finding));
    if (cycle) row.append(findingMarker(cycle, "cycle"));
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
    if (analysis) {
      const marker = el("span", "review-marker", "◷");
      marker.title = analysis;
      marker.setAttribute("role", "img");
      marker.setAttribute("aria-label", analysis);
      row.append(marker);
    }
    const { markers, description } = treeChangeBadges(module);
    row.setAttribute("aria-description", description);
    row.append(markers);
    row.addEventListener("click", event => {
      if (children.length && event.target instanceof Element && event.target.closest("[data-toggle]")) {
        actions.expandModule(module.key, repository);
      } else actions.selectModule(module.key, repository);
    });
    item.append(row);
    if (children.length) {
      const group = el("ul", "tree-group");
      group.setAttribute("role", "group");
      group.hidden = !expanded;
      for (const child of children) group.append(moduleItem(child, repository));
      item.append(group);
    }
    return item;
  }

  function moduleList(rows: ModuleRow[], repository?: string) {
    if (!rows.length) {
      const empty = el("div", "empty-tree");
      empty.append(el("strong", "", "Модули не найдены"), el("p", "", "Попробуйте другой запрос или статус."));
      return empty;
    }
    const list = el("ul", "tree-root");
    list.setAttribute("role", "group");
    for (const row of rows) list.append(moduleItem(row, repository));
    return list;
  }

  function renderTree(sections: TreeSection[]) {
    hideChangeTooltip();
    tree.replaceChildren();
    for (const {repository, rows} of sections) {
      if (!repository) { tree.append(moduleList(rows)); continue; }
      const section = el("div", "repository-section");
      section.setAttribute("role", "none");
      section.append(repositoryHeader(repository));
      if (repository.expanded) section.append(moduleList(rows, repository.key));
      tree.append(section);
    }
  }

  function searchScope(loaded: number, total: number) {
    const partial = loaded < total;
    const label = partial ? "Найти модуль в загруженных репозиториях" : "Найти модуль";
    const scope = partial ? "Поиск и счётчики учитывают загруженные репозитории (" + loaded + " из " + total + "). Раскройте остальные, чтобы добавить их модули." : "";
    search.placeholder = label + "…";
    search.setAttribute("aria-label", label);
    search.title = scope;
    byId("module-total").title = scope;
    byId("filters").title = scope;
  }
  return { tree: renderTree, filters: renderFilters, searchScope };
}
