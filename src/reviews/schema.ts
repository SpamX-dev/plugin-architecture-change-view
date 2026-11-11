import { fail, string, object, enumeration, nullable, array, shape, strings, references, extensions } from "../serialization/schema.js";

import type { Validator } from "../serialization/schema.js";

import type { ReviewReport } from "./types.js";

const hash: Validator = (v, at) => /^sha256:[a-f0-9]{64}$/.test(String(v)) ? undefined : fail(at, "ожидается sha256:<64 hex>");
const version = enumeration(1);
const side = enumeration("baseline", "current");
const section = enumeration("responsibilities", "boundaries", "invariants");
const relativePath: Validator = (value, at) => {
  string(value, at);
  const v = value as string;
  if (v !== "." && (v.startsWith("/") || /[\\:]/.test(String(v)) ||
      v.split("/").some((part) => ["", ".", ".."].includes(part)))) fail(at, "нужен путь относительно проекта");
};
const timestamp: Validator = (value, at) => {
  string(value, at);
  const v = value as string;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(String(v)) || !Number.isFinite(Date.parse(v))) fail(at, "нужно время UTC");
};
const evidence = shape({ snapshot: side, fact_id: string });
const clause = shape({ snapshot: side, module_id: string, section, id: string });
const snapshot = shape({ id: string, digest: hash });
const observation = shape({ summary: string, responsibilities: array(shape({ text: string, evidence: array(evidence, 1) })) });
const assessment = shape({ verdict: enumeration("consistent", "violation", "needs_review", "inconclusive", "not_applicable"), summary: string });

/** Полная схема отчёта; успешные выводы требуют явных доказательств. */
export function validateReview(input: unknown): ReviewReport {
  const value = input as ReviewReport;
  shape({ schema_version: version, id: string,
    module: shape({ id: nullable(string), baseline_path: nullable(relativePath), current_path: nullable(relativePath) }),
    comparison: shape({ baseline: nullable(snapshot), current: snapshot }),
    analysis: shape({ created_at: timestamp, analyzer: shape({ name: string, version: string, config_digest: hash }),
      input_digest: hash, scope: enumeration("module", "changes"), coverage: shape({
        status: enumeration("complete", "partial", "unavailable"), limitations: strings }) },
    { model: shape({ provider: string, id: string }, { revision: string, parameters: object }), prompt_digest: hash }),
    observed: shape({ baseline: nullable(observation), current: nullable(observation) }),
    checks: array(shape({ id: string, contract: clause, subject: side,
      verdict: enumeration("consistent", "violation", "uncertain", "not_checked", "not_applicable"),
      explanation: string, evidence: array(evidence) })),
    // contract_change читается только для сохранения совместимости с неизменяемой историей.
    findings: array(shape({ id: string, kind: enumeration("boundary_violation", "invariant_violation",
      "undeclared_responsibility", "responsibility_gap", "contract_conflict", "contract_change", "missing_contract"),
      certainty: enumeration("confirmed", "suspected"), severity: enumeration("info", "warning", "error"),
      lifecycle: enumeration("introduced", "persisting", "resolved", "unknown"), summary: string,
      clauses: array(clause), evidence: array(evidence, 1) },
    { details: string, recommendation: string, related_modules: strings })),
    assessment: shape({ current: assessment, change: assessment }) }, { references, extensions })(value, "review");
  if (value.module.baseline_path === null && value.module.current_path === null) fail("review.module", "оба пути отсутствуют");
  for (const s of ["baseline", "current"] as const) {
    if ((value.module[`${s}_path`] === null) !== (value.observed[s] === null)) fail("review.observed." + s, "не совпадает с наличием модуля");
  }
  if (value.comparison.baseline === null && (value.module.baseline_path !== null || value.assessment.change.verdict !== "not_applicable")) fail("review.comparison", "первый анализ не имеет базы и оценки изменения");
  if (Boolean(value.analysis.model) !== Boolean(value.analysis.prompt_digest)) fail("review.analysis", "model и prompt_digest нужны вместе");
  if (value.analysis.coverage.status !== "complete" && !value.analysis.coverage.limitations.length) fail("review.analysis.coverage", "укажите ограничения анализа");
  for (const key of ["checks", "findings"] as const) {
    if (new Set(value[key].map((item) => item.id)).size !== value[key].length) fail("review." + key, "повторяющийся id");
  }
  for (const check of value.checks) if (["consistent", "violation"].includes(check.verdict) && !check.evidence.length) fail("review.checks." + check.id, "нужны доказательства");
  return value;
}
