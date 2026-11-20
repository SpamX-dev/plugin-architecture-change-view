export type Section = "purpose" | "boundaries" | "invariants";

export const PROTOTYPE_EXTENSION = "archiview.prototype";
export function isPrototype(contract?: StoredContract | null) {
  return contract?.extensions?.[PROTOTYPE_EXTENSION] === true;
}

export interface Contract {
  schema_version: number;
  id: string;
  title: string;
  kind: string;
  purpose: string;
  boundaries: Record<string, string>;
  invariants: Record<string, string>;
  rationale?: string;
  owners?: string[];
  tags?: string[];
  references?: { title: string; uri: string }[];
  extensions?: Record<string, unknown>;
}

/** Historical snapshots may predate purpose or contain the former R clauses. */
export type StoredContract = Omit<Contract, "purpose"> & { purpose?: string; responsibilities?: Record<string, string> };
export type ReviewSection = Section | "responsibilities";

export function clauseEntries(contract: Partial<StoredContract>, section: ReviewSection): Record<string, string> {
  if (section === "purpose") return contract.purpose ? { purpose: contract.purpose } : {};
  return contract[section] ?? {};
}

export interface ContractDocument {
  state: string;
  text: string | null;
  format?: string;
  contract?: StoredContract | null;
  errors?: string[];
  action?: string;
}
