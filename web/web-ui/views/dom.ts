import { errorMessage } from "../view-model/types.js";

/** Статические SVG-значки, не содержащие пользовательских строк. */
const icons = {
  edit: '<path d="m15 5 4 4M4 20l4-1 12-12a2.8 2.8 0 0 0-4-4L4.8 15.5 4 20Z"/>',
  folder: '<path d="M3 6.5h6l2 2h10v11H3z"/><path d="M3 9h18"/>',
  file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 12h6m-6 4h6"/>',
  refresh: '<path d="M20 7v5h-5"/><path d="M19 12a7 7 0 1 0-2 5"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
};

/** Возвращает элемент по фиксированному идентификатору страницы. */
type PageElements = { "analysis-status": HTMLElement; "toast": HTMLElement; "timeline": HTMLSelectElement; "app-shell": HTMLElement; "tree-resizer": HTMLElement; "module-sidebar": HTMLElement; "filters": HTMLElement; "module-total": HTMLElement; "tree": HTMLElement; "module-heading-content": HTMLElement; "module-title": HTMLElement; "module-status": HTMLElement; "module-subtitle": HTMLElement; "module-contract-heading": HTMLElement; "breadcrumbs": HTMLElement; "module-meta": HTMLElement; "copy-path": HTMLButtonElement; "files-count": HTMLElement; "tab-composition": HTMLButtonElement; "tab-implementation": HTMLButtonElement; "document-panel": HTMLElement; "project-name": HTMLElement; "project-path": HTMLElement; "refresh": HTMLButtonElement; "warning": HTMLElement; "updated": HTMLElement; "search": HTMLInputElement; "collapse": HTMLButtonElement; "tree-toggle": HTMLButtonElement };
type PageControls = PageElements & { "new-prototype": HTMLButtonElement; "project-settings": HTMLButtonElement };
export function byId<K extends keyof PageControls>(id: K): PageControls[K] {
  const node = document.getElementById(id);
  if (!node) throw new Error("Missing page element: " + id);
  return node as PageControls[K];
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

/** Общий жук для пункта, вкладки и дерева, независимый от цвета изменения контракта. */
export function findingBug(kind: "cycle" | "review" = "review") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  svg.classList.add("finding-bug");
  if (kind === "cycle") svg.classList.add("cycle-bug");
  const shape = document.createElementNS(svg.namespaceURI, "path");
  shape.setAttribute("d", "M7 7h6v6a3 3 0 0 1-6 0V7ZM8 7V5a2 2 0 0 1 4 0v2M10 8v8M7 9H4M7 12H3M7 15l-3 2M13 9h3M13 12h4M13 15l3 2M8 4 6 2M12 4l2-2");
  svg.append(shape);
  return svg;
}

export function findingMarker(label: string, kind: "cycle" | "review" = "review") {
  const marker = el("span", "finding-marker");
  marker.title = label;
  marker.setAttribute("role", "img");
  marker.setAttribute("aria-label", label);
  marker.append(findingBug(kind));
  return marker;
}

/** Создаёт уведомление в контексте документа, не подменяя его содержимое. */
export function notice(title: string, description: string, kind = "") {
  const box = el("div", "notice " + kind);
  box.append(el("strong", "", title), el("p", "", description));
  return box;
}

/** Объясняет ошибку загрузки и предлагает повторить доступное действие. */
export function renderFailure(error: unknown, retryOperation: () => Promise<void>) {
  const box = notice("Не удалось открыть данные", errorMessage(error), "removed-notice");
  const retry = el("button", "button button-quiet", "Повторить");
  retry.type = "button";
  retry.addEventListener("click", retryOperation);
  box.append(retry);
  byId("document-panel").replaceChildren(box);
}
