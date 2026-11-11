import type { Contract } from "../contracts/types.js";
import { declaredRoles } from "../contracts/roles.js";
import { canonical } from "../serialization/digest.js";

export interface ContractFieldChange {
  key: string;
  before: unknown;
  after: unknown;
  status: "unchanged" | "added" | "modified" | "removed";
}

export interface RoleChange {
  id: string;
  status: "added" | "unchanged" | "removed";
}

/** Сначала роли выбранного снимка в порядке YAML, затем исчезнувшие роли в порядке базы. */
export function compareRoles(before: Partial<Contract> | null | undefined, after: Partial<Contract> | null | undefined, compare: boolean): RoleChange[] {
  const previous = new Set(declaredRoles(before));
  const current = new Set(declaredRoles(after));
  const changes: RoleChange[] = Array.from(current, id => ({ id, status: !compare || previous.has(id) ? "unchanged" : "added" }));
  if (compare) for (const id of previous) if (!current.has(id)) changes.push({ id, status: "removed" });
  return changes;
}

/** Compare the saved pair once, including removed clauses and the four-field heading. */
export function compareContracts(before: Partial<Contract> | null | undefined, after: Partial<Contract> | null | undefined, compare = true) {
  const fields: ContractFieldChange[] = [];
  function add(key: string, oldValue: unknown, newValue: unknown) {
    const status = !compare || oldValue === newValue ? "unchanged" : oldValue === undefined ? "added" :
      newValue === undefined ? "removed" : canonical(oldValue) === canonical(newValue) ? "unchanged" : "modified";
    fields.push({ key, before: oldValue, after: newValue, status });
  }
  const headingKeys = ["title", "kind", "id", "purpose"] as const;
  for (const key of [...headingKeys, "rationale", "owners", "tags", "references", "extensions"] as const)
    if (before?.[key] !== undefined || after?.[key] !== undefined) add(key, before?.[key], after?.[key]);
  for (const section of ["responsibilities", "boundaries", "invariants"] as const) {
    for (const id of new Set([...Object.keys(after?.[section] ?? {}), ...Object.keys(before?.[section] ?? {})]))
      add(section + "." + id, before?.[section]?.[id], after?.[section]?.[id]);
  }
  const headingValues = (contract: Partial<Contract> | null | undefined) => contract == null ? undefined :
    Object.fromEntries(headingKeys.filter((key) => contract[key] !== undefined).map((key) => [key, contract[key]]));
  const rank = { unchanged: 0, added: 1, modified: 2, removed: 3 };
  const heading: ContractFieldChange = { key: "heading", before: headingValues(before), after: headingValues(after), status: "unchanged" };
  for (const field of fields) {
    if (headingKeys.some((key) => key === field.key) && rank[field.status] > rank[heading.status]) heading.status = field.status;
  }
  return { fields, heading, roles: compareRoles(before, after, compare) };
}
