import { parseDocument } from "yaml";
import { fail, string, object, enumeration, shape, strings, references, extensions } from "../serialization/schema.js";

import type { Validator } from "../serialization/schema.js";

import type { Contract, ContractDocument } from "./types.js";
import { errorDetails } from "../runtime/errors.js";
import { parseYaml } from "../serialization/yaml.js";

const clauses = (min: number): Validator => (v, at) => {
  object(v, at);
  if (Object.keys(v as object).length < min) fail(at, "нужен хотя бы один пункт");
  for (const [key, text] of Object.entries(v as Record<string, unknown>)) { string(key, at); string(text, at + "." + key); }
};

/** Контракт не содержит путь, историю или результаты анализа; они принадлежат снимкам. */
export function validateArch(input: unknown): Contract {
  const value = input as Contract;
  shape({ schema_version: enumeration(1), id: string, title: string, kind: enumeration("module", "group"),
    responsibilities: clauses(1), boundaries: clauses(0), invariants: clauses(0) },
  { rationale: string, owners: strings, tags: strings, references, extensions })(value, "arch");
  return value;
}

/** Presents a valid legacy contract in the current format while retaining the original snapshot text. */
export function currentContractYaml(source: string): string {
  const doc = parseDocument(source, { intAsBigInt: true });
  if (!doc.delete("purpose")) return source;
  const yaml = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  return source.includes("\r\n") ? yaml.replaceAll("\n", "\r\n") : yaml;
}

/** Parses architecture contract YAML without inferring its module from the file's location. */
export function contractDocument(text: string | null | undefined, format = "yaml", preserveLegacyPurpose = false): ContractDocument {
  if (!text?.trim()) return { state: "empty", text: text ?? null, format, contract: null };
  try {
    const contract = parseYaml(text, value => {
      if (value && typeof value === "object" && "purpose" in value) {
        const { purpose, ...fields } = value;
        string(purpose, "arch.purpose");
        const current = validateArch(fields);
        // A sealed review must reproduce the object that was hashed when it was saved.
        return preserveLegacyPurpose ? { ...current, purpose } : current;
      }
      return validateArch(value);
    });
    return { state: "documented", text, format, contract };
  }
  catch (cause) { const error = errorDetails(cause); return { state: "invalid", text, format, contract: null, errors: [error.message] }; }
}
