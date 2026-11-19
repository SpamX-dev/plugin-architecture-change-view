import { el, icon } from "./dom.js";
import { ancestors, treeParents } from "./module-path.js";
import type { ModuleSummary } from "./types.js";

/** Select a parent from the current side of this repository's comparison. */
export function prototypeLocation(dialog: HTMLDialogElement, modules: ModuleSummary[]) {
  const element = el("div");
  const picker = el("div", "prototype-parent");
  const label = el("label", "", "Родительский модуль");
  const trigger = el("button", "button button-quiet prototype-parent-trigger");
  trigger.type = "button";
  trigger.id = "prototype-parent";
  label.htmlFor = trigger.id;
  label.id = "prototype-parent-label";
  const value = el("span", "", "Корень репозитория");
  value.id = "prototype-parent-value";
  const chevron = el("span", "prototype-chevron", "▾");
  chevron.setAttribute("aria-hidden", "true");
  trigger.append(icon("folder"), value, chevron);
  trigger.setAttribute("aria-labelledby", label.id + " " + value.id);
  trigger.setAttribute("aria-haspopup", "tree");
  trigger.setAttribute("aria-expanded", "false");
  const tree = el("div", "prototype-parent-tree");
  tree.id = "prototype-parent-tree";
  tree.hidden = true;
  tree.setAttribute("role", "tree");
  tree.setAttribute("aria-labelledby", label.id);
  trigger.setAttribute("aria-controls", tree.id);
  picker.append(label, trigger, tree);

  const idLabel = el("label", "", "ID модуля");
  const id = el("input");
  id.required = true;
  id.placeholder = "catalog";
  idLabel.append(id);
  const pathLabel = el("label", "", "Путь от корня репозитория");
  const path = el("input");
  pathLabel.append(path);
  const identifiers = el("div", "prototype-identifiers");
  identifiers.append(idLabel, pathLabel);
  element.append(picker, identifiers);

  const current = modules.filter(module => module.currentPath !== null && module.status !== "removed");
  const parents = treeParents(current);
  const children = new Map<string | undefined, ModuleSummary[]>();
  for (const module of current) {
    const parent = parents.get(module.key)?.directory;
    const siblings = children.get(parent);
    if (siblings) siblings.push(module);
    else children.set(parent, [module]);
  }
  let selected = ".";
  let manualPath = false;
  const expanded = new Set(["."]);
  const rows = new Map<string, HTMLButtonElement>();
  const display = (directory: string) => directory === "." ? "Корень репозитория" : directory;
  const childPath = (name: string) => selected === "." ? name : selected + "/" + name;
  function updatePath() {
    path.placeholder = childPath("ID модуля");
    if (!manualPath) path.value = id.value.trim() ? childPath(id.value.trim()) : "";
  }
  id.oninput = updatePath;
  path.oninput = () => {
    const directory = path.value.trim();
    manualPath = Boolean(directory && directory !== "/");
    const slash = directory.lastIndexOf("/");
    selected = slash > 0 ? directory.slice(0, slash) : ".";
    value.textContent = display(selected);
    path.placeholder = childPath("ID модуля");
  };
  updatePath();

  function close(restoreFocus = false) {
    tree.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger.focus();
  }
  function focusRow(row: HTMLButtonElement | undefined) {
    if (!row) return;
    const previous = tree.querySelector<HTMLElement>('[tabindex="0"]');
    if (previous) previous.tabIndex = -1;
    row.tabIndex = 0;
    row.focus();
  }
  function render(focus: string) {
    tree.replaceChildren();
    rows.clear();
    function branch(parent: string | undefined, level: number) {
      const siblings = children.get(parent) ?? [];
      for (const [index, module] of siblings.entries()) {
        const directory = module.directory;
        const hasChildren = children.has(directory);
        const row = el("button", "prototype-parent-row");
        row.type = "button";
        row.tabIndex = -1;
        row.setAttribute("role", "treeitem");
        row.setAttribute("aria-level", String(level));
        row.setAttribute("aria-posinset", String(index + 1));
        row.setAttribute("aria-setsize", String(siblings.length));
        row.setAttribute("aria-selected", String(directory === selected));
        if (hasChildren) row.setAttribute("aria-expanded", String(expanded.has(directory)));
        row.style.paddingInlineStart = (8 + (level - 1) * 16) + "px";
        const caret = el("span", "prototype-branch-toggle", hasChildren ? "▸" : "");
        caret.setAttribute("aria-hidden", "true");
        const name = directory === "." ? display(directory) : module.title || module.name;
        row.append(caret, icon("folder"), el("span", "prototype-node-name", name));
        if (directory !== ".") row.append(el("code", "prototype-node-path", directory));
        row.title = display(directory);
        row.onclick = event => {
          if (hasChildren && event.target === caret) {
            if (expanded.has(directory)) expanded.delete(directory);
            else expanded.add(directory);
            render(directory);
            return;
          }
          selected = directory;
          manualPath = false;
          value.textContent = display(selected);
          updatePath();
          close(true);
        };
        rows.set(directory, row);
        tree.append(row);
        if (hasChildren && expanded.has(directory)) branch(directory, level + 1);
      }
    }
    branch(undefined, 1);
    const nearest = ancestors(focus).findLast(directory => rows.has(directory));
    focusRow(rows.get(nearest ?? "."));
  }
  function open() {
    const trail = ancestors(selected);
    for (const directory of trail.slice(0, -1)) expanded.add(directory);
    tree.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    render(selected);
  }
  trigger.onclick = () => tree.hidden ? open() : close();
  trigger.onkeydown = event => {
    if (event.key === "ArrowDown") { event.preventDefault(); open(); }
  };
  tree.onkeydown = event => {
    const visible = [...rows.keys()];
    const index = visible.findIndex(directory => rows.get(directory) === event.target);
    if (index < 0) return;
    const directory = visible[index];
    switch (event.key) {
      case "Escape": close(true); break;
      case "ArrowDown": focusRow(rows.get(visible[index + 1])); break;
      case "ArrowUp": focusRow(rows.get(visible[index - 1])); break;
      case "Home": focusRow(rows.get(visible[0])); break;
      case "End": focusRow(rows.get(visible[visible.length - 1])); break;
      case "ArrowRight": {
        const first = children.get(directory)?.[0];
        if (first && !expanded.has(directory)) { expanded.add(directory); render(directory); }
        else if (first) focusRow(rows.get(first.directory));
        break;
      }
      case "ArrowLeft":
        if (children.has(directory) && expanded.delete(directory)) render(directory);
        else focusRow(rows.get(ancestors(directory).at(-2) ?? "."));
        break;
      default: return;
    }
    event.preventDefault();
    event.stopPropagation();
  };
  function outside(event: Event) {
    if (!tree.hidden && event.target instanceof Node && !picker.contains(event.target)) close();
  }
  dialog.addEventListener("pointerdown", outside);
  dialog.addEventListener("focusin", outside);
  return { element, get moduleId() { return id.value.trim(); },
    get directory() { return manualPath ? path.value.trim() : childPath(id.value.trim()); } };
}
