export type Section = "responsibilities" | "boundaries" | "invariants";

export const PROTOTYPE_EXTENSION = "archiview.prototype";
export function isPrototype(contract?: Contract | null) {
  return contract?.extensions?.[PROTOTYPE_EXTENSION] === true;
}

export interface Contract {
  schema_version: number;
  id: string;
  title: string;
  kind: string;
  responsibilities: Record<string, string>;
  boundaries: Record<string, string>;
  invariants: Record<string, string>;
  rationale?: string;
  owners?: string[];
  tags?: string[];
  references?: { title: string; uri: string }[];
  extensions?: Record<string, unknown>;
}

export interface ContractDocument {
  state: string;
  text: string | null;
  format?: string;
  contract?: Contract | null;
  errors?: string[];
  action?: string;
}
