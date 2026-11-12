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
    purpose: string, responsibilities: clauses(1), boundaries: clauses(0), invariants: clauses(0) },
  { rationale: string, owners: strings, tags: strings, references, extensions })(value, "arch");
  return value;
}

/** Parses architecture contract YAML without inferring its module from the file's location. */
export function contractDocument(text: string | null | undefined, format = "yaml"): ContractDocument {
  if (!text?.trim()) return { state: "empty", text: text ?? null, format, contract: null };
  try { return { state: "documented", text, format, contract: parseYaml(text, validateArch) }; }
  catch (cause) { const error = errorDetails(cause); return { state: "invalid", text, format, contract: null, errors: [error.message] }; }
}
