export type Section = "responsibilities" | "boundaries" | "invariants";

export interface Contract {
  schema_version: number;
  id: string;
  title: string;
  kind: string;
  purpose: string;
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
  migration?: { document: string; text: string };
}
