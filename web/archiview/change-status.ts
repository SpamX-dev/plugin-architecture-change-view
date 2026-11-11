import type { ChangeStatus } from "./types.js";
import { el } from "./dom.js";

/** Человекочитаемые подписи сравнительных статусов. */
export const labels: Record<string, string> = { initial: "Первый", new: "Новый", changed: "Изменён", removed: "Удалён", unchanged: "Без изменений" };

/** Представляет статус цветом и подписью, доступной без различения цветов. */
export function badge(status: ChangeStatus, small = false, descendantChanges = 0) {
  const title = descendantChanges && status === "unchanged" ? "Изменены подмодули" :
    descendantChanges && status === "changed" ? "Изменены модуль и подмодули" : labels[status];
  return el("span", "status-badge " + status + (small ? " small" : ""), title);
}
