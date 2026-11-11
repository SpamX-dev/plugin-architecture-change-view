import type { Contract } from "./types.js";

export const ROLE_EXTENSION = "archiview.roles";

/** Читает заявленные роли; отсутствие разметки не требует вывода по коду или предкам. */
export function declaredRoles(contract?: Pick<Contract, "extensions"> | null): string[] {
  const value = contract?.extensions?.[ROLE_EXTENSION];
  if (!Array.isArray(value) || !value.every((role): role is string =>
    typeof role === "string" && /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(role))) return [];
  return [...new Set(value)];
}
