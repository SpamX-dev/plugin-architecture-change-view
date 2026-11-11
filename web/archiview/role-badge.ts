import type { RoleChange } from "../../src/snapshots/contract-diff.js";
import { el } from "./dom.js";

const statusLabel = { added: "добавлена", unchanged: "без изменений", removed: "удалена" };

export function roleBadge({ id, status }: RoleChange) {
  const badge = el("span", "role-badge", id);
  badge.dataset.changeStatus = status;
  badge.title = id + " — " + statusLabel[status];
  badge.setAttribute("role", "img");
  badge.setAttribute("aria-label", badge.title);
  return badge;
}
