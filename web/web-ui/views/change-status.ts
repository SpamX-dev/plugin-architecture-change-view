import type { ChangeStatus, ModuleSummary } from "../view-model/types.js";
import { el } from "./dom.js";

/** Человекочитаемые подписи сравнительных статусов. */
export const labels: Record<string, string> = { initial: "Первый", new: "Новый", changed: "Изменён", removed: "Удалён", unchanged: "Без изменений" };

/** Представляет статус цветом и подписью, доступной без различения цветов. */
export function badge(status: ChangeStatus, descendantChanges = 0) {
  const title = descendantChanges && status === "unchanged" ? "Изменены подмодули" :
    descendantChanges && status === "changed" ? "Изменены модуль и подмодули" : labels[status];
  return el("span", "status-badge " + status, title);
}

const filesLabels: Record<ChangeStatus, string> = {
  initial: "Файлы в первом снимке", new: "Файлы добавлены", changed: "Файлы изменены",
  removed: "Файлы удалены", unchanged: "Файлы без изменений",
};
type TreeChangeStatus = ChangeStatus | "unavailable";
const contractLabels: Record<TreeChangeStatus, string> = {
  initial: "Контракт в первом снимке", new: "Контракт добавлен", changed: "Контракт изменён",
  removed: "Контракт удалён", unchanged: "Контракт без изменений",
  unavailable: "Состояние контракта недоступно",
};

function treeChangeBadge(letter: "F" | "C", status: TreeChangeStatus, label: string) {
  const marker = el("span", "status-badge tree-change-badge " + status, letter);
  marker.title = "";
  marker.dataset.status = status;
  marker.dataset.statusLabel = label;
  return marker;
}

export function treeChangeBadges({ filesStatus, contractStatus }: Pick<ModuleSummary, "filesStatus" | "contractStatus">) {
  const files = filesLabels[filesStatus], contract = contractLabels[contractStatus];
  const markers = el("span", "tree-change-badges");
  markers.setAttribute("aria-hidden", "true");
  markers.append(treeChangeBadge("F", filesStatus, files), treeChangeBadge("C", contractStatus, contract));
  return { markers, description: files + ". " + contract + "." };
}

export function createTreeChangeTooltip(tree: HTMLElement) {
  // Keep the tooltip outside the scrolling tree so its edges cannot clip the text.
  const tooltip = el("div", "status-badge tree-change-tooltip");
  tooltip.id = "tree-change-tooltip";
  tooltip.setAttribute("aria-hidden", "true");
  tooltip.hidden = true;
  document.body.append(tooltip);
  const hide = () => { tooltip.hidden = true; };
  tree.addEventListener("pointerover", event => {
    const badge = event.target instanceof Element ? event.target.closest<HTMLElement>(".tree-change-badge") : null;
    const group = badge?.parentElement;
    if (!badge || !group) return;
    tooltip.className = "status-badge tree-change-tooltip " + badge.dataset.status;
    tooltip.textContent = badge.dataset.statusLabel ?? "";
    tooltip.hidden = false;
    const gap = 6;
    const pair = group.getBoundingClientRect();
    const spaceLeft = pair.left - 2 * gap;
    const spaceRight = innerWidth - pair.right - 2 * gap;
    tooltip.style.maxWidth = Math.max(spaceLeft, spaceRight) + "px";
    const { width, height } = tooltip.getBoundingClientRect();
    const left = width <= spaceLeft ? pair.left - width - gap : pair.right + gap;
    const top = pair.top + (pair.height - height) / 2;
    tooltip.style.left = left + "px";
    tooltip.style.top = Math.max(gap, Math.min(top, innerHeight - height - gap)) + "px";
  });
  tree.addEventListener("pointerout", hide);
  tree.addEventListener("scroll", hide);
  window.addEventListener("resize", hide);
  return hide;
}
