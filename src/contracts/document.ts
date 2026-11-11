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

/** Старый файл возвращается только как материал немедленного переноса, не как контракт. */
export function contractDocument(text: string | null | undefined, format = "arch.yaml"): ContractDocument {
  if (!text?.trim()) return { state: "empty", text: text ?? null, format, contract: null };
  if (format === "module.md") return { state: "migration_required", text, format, contract: null,
    action: "Немедленно перенесите ответственность в arch.yaml, проверьте его и удалите module.md." };
  try { return { state: "documented", text, format, contract: parseYaml(text, validateArch) }; }
  catch (cause) { const error = errorDetails(cause); return { state: "invalid", text, format, contract: null, errors: [error.message] }; }
}
