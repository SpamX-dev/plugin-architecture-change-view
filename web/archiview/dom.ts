/** Статические SVG-значки, не содержащие пользовательских строк. */
const icons = {
  folder: '<path d="M3 6.5h6l2 2h10v11H3z"/><path d="M3 9h18"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 12h6m-6 4h6"/>',
  refresh: '<path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 0-2 5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
};

/** Возвращает элемент по фиксированному идентификатору страницы. */
type PageElements = { "analysis-status": HTMLElement; "toast": HTMLElement; "timeline": HTMLSelectElement; "app-shell": HTMLElement; "tree-resizer": HTMLElement; "module-sidebar": HTMLElement; "filters": HTMLElement; "module-total": HTMLElement; "tree": HTMLElement; "module-heading-content": HTMLElement; "module-title": HTMLElement; "module-status": HTMLElement; "module-subtitle": HTMLElement; "module-contract-heading": HTMLElement; "breadcrumbs": HTMLElement; "module-meta": HTMLElement; "copy-path": HTMLButtonElement; "files-count": HTMLElement; "tab-findings": HTMLButtonElement; "document-panel": HTMLElement; "project-name": HTMLElement; "project-path": HTMLElement; "refresh": HTMLButtonElement; "warning": HTMLElement; "updated": HTMLElement; "search": HTMLInputElement; "collapse": HTMLButtonElement; "tree-toggle": HTMLButtonElement };
export function byId<K extends keyof PageElements>(id: K): PageElements[K] {
  const node = document.getElementById(id);
  if (!node) throw new Error("Missing page element: " + id);
  return node as PageElements[K];
}

/** Создаёт DOM-элемент и вставляет пользовательский текст безопасным textContent. */
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, className = "", text?: unknown): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

/** Формирует значок исключительно из локального каталога SVG. */
export function icon(name: keyof typeof icons) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("fill", "none");
  node.setAttribute("aria-hidden", "true");
  node.innerHTML = icons[name] ?? icons.file;
  return node;
}

/** Создаёт уведомление в контексте документа, не подменяя его содержимое. */
export function notice(title: string, description: string, kind = "") {
  const box = el("div", "notice " + kind);
  box.append(el("strong", "", title), el("p", "", description));
  return box;
}
