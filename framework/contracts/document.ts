import { parseDocument } from "yaml";
import { fail, string, object, enumeration, shape, strings, references, extensions } from "../serialization/schema.js";

import type { Validator } from "../serialization/schema.js";

import type { Contract, ContractDocument, StoredContract } from "./types.js";
import { parseYaml } from "../serialization/yaml.js";

const clauses = (min: number): Validator => (v, at) => {
  object(v, at);
  if (Object.keys(v as object).length < min) fail(at, "нужен хотя бы один пункт");
  for (const [key, text] of Object.entries(v as Record<string, unknown>)) { string(key, at); string(text, at + "." + key); }
};

const common = { schema_version: enumeration(1), id: string, title: string, kind: enumeration("module", "group"),
  boundaries: clauses(0), invariants: clauses(0) };
const optional = { rationale: string, owners: strings, tags: strings, references, extensions };
const currentSchema = shape({ ...common, purpose: string }, optional);
const legacySchema = shape({ ...common, responsibilities: clauses(1) }, { ...optional, purpose: string });

export function validateArch(input: unknown): Contract {
  currentSchema(input, "arch");
  return input as Contract;
}

/** Presents a valid legacy contract in the current format while retaining the original snapshot text. */
export function currentContractYaml(source: string): string {
  const doc = parseDocument(source, { intAsBigInt: true });
  if (!doc.delete("responsibilities")) return source;
  if (!doc.has("purpose")) doc.set("purpose", "");
  const yaml = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  return source.includes("\r\n") ? yaml.replaceAll("\n", "\r\n") : yaml;
}

/** Parses architecture contract YAML without inferring its module from the file's location. */
export function contractDocument(text: string | null | undefined, format = "yaml",
  projection: "current" | "legacy" | "legacy-r" = "current"): ContractDocument {
  if (!text?.trim()) return { state: "empty", text: text ?? null, format, contract: null };
  try {
    const contract = parseYaml<StoredContract>(text, value => {
      if (value && typeof value === "object" && "responsibilities" in value) {
        legacySchema(value, "arch");
        const original = value as StoredContract;
        // Replay the two historical representations exactly when validating a sealed review.
        if (projection === "legacy-r") { const { purpose, ...fields } = original; return fields; }
        if (projection === "legacy") return original;
        const { responsibilities, ...fields } = original;
        return fields;
      }
      return validateArch(value);
    });
    return { state: "documented", text, format, contract,
      ...(projection === "current" && !contract.purpose ? { action: "Укажите назначение модуля в поле purpose." } : {}) };
  }
  catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    return { state: "invalid", text, format, contract: null, errors: [message] };
  }
}
