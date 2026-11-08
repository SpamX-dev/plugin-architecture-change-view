/**
 * Строгие форматы arch.yaml/review.yaml v1 и единый SHA-256 для их входов.
 * Проверяет структуру, а разрешение ссылок на факты выполняет модель проверок.
 * Неизвестные поля и неоднозначный YAML отвергаются до использования данных.
 */
import { createHash } from "node:crypto";
import { parseDocument } from "yaml";

/** Канонический JSON сортирует ключи словарей, сохраняя порядок массивов. */
export function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map((v) => canonical(v ?? null)).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).filter((key) => value[key] !== undefined).sort()
    .map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  return JSON.stringify(value ?? null);
}

/** Все внешние отпечатки используют одинаковые байты UTF-8 и префикс алгоритма. */
export function digest(value) {
  return "sha256:" + createHash("sha256").update(canonical(value)).digest("hex");
}

/** Минимальный словарь валидаторов: каждая ошибка содержит точный путь поля. */
const fail = (at, message) => { throw new Error(at + ": " + message); };
const string = (v, at) => typeof v === "string" && v.trim() ? undefined : fail(at, "ожидается непустая строка");
const object = (v, at) => v && typeof v === "object" && !Array.isArray(v) ? undefined : fail(at, "ожидается словарь");
const enumeration = (...values) => (v, at) => values.includes(v) ? undefined : fail(at, "допустимо: " + values.join(", "));
const nullable = (check) => (v, at) => v === null ? undefined : check(v, at);
const array = (check, min = 0) => (v, at) => {
  if (!Array.isArray(v) || v.length < min) fail(at, "ожидается массив, минимум " + min);
  v.forEach((item, i) => check(item, at + "[" + i + "]"));
};
const shape = (required, optional = {}) => (v, at) => {
  object(v, at);
  for (const [key, check] of Object.entries(required)) check(v[key], at + "." + key);
  for (const key of Object.keys(v)) {
    if (Object.hasOwn(required, key)) continue;
    if (!Object.hasOwn(optional, key)) fail(at + "." + key, "неизвестное поле");
    optional[key](v[key], at + "." + key);
  }
};
const hash = (v, at) => /^sha256:[a-f0-9]{64}$/.test(v) ? undefined : fail(at, "ожидается sha256:<64 hex>");
const version = enumeration(1);
const side = enumeration("baseline", "current");
const section = enumeration("responsibilities", "boundaries", "invariants");
const strings = array(string);
const references = array(shape({ title: string, uri: string }));
const extensions = (v, at) => {
  object(v, at);
  for (const key of Object.keys(v)) if (!/^[^.\s]+\.[^\s]+$/.test(key)) fail(at, "расширению нужно пространство имён");
};
const clauses = (min) => (v, at) => {
  object(v, at);
  if (Object.keys(v).length < min) fail(at, "нужен хотя бы один пункт");
  for (const [key, text] of Object.entries(v)) { string(key, at); string(text, at + "." + key); }
};
const relativePath = (v, at) => {
  string(v, at);
  if (v !== "." && (v.startsWith("/") || /[\\:]/.test(v) ||
      v.split("/").some((part) => ["", ".", ".."].includes(part)))) fail(at, "нужен путь относительно проекта");
};
const timestamp = (v, at) => {
  string(v, at);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(v) || !Number.isFinite(Date.parse(v))) fail(at, "нужно время UTC");
};
const evidence = shape({ snapshot: side, fact_id: string });
const clause = shape({ snapshot: side, module_id: string, section, id: string });
const snapshot = shape({ id: string, digest: hash });
const observation = shape({ summary: string, responsibilities: array(shape({ text: string, evidence: array(evidence, 1) })) });
const assessment = shape({ verdict: enumeration("consistent", "violation", "needs_review", "inconclusive", "not_applicable"), summary: string });

/** Контракт не содержит путь, историю или результаты анализа; они принадлежат снимкам. */
export function validateArch(value) {
  shape({ schema_version: version, id: string, title: string, kind: enumeration("module", "group"),
    purpose: string, responsibilities: clauses(1), boundaries: clauses(0), invariants: clauses(0) },
  { rationale: string, owners: strings, tags: strings, references, extensions })(value, "arch");
  return value;
}

/** Полная схема отчёта; успешные выводы требуют явных доказательств. */
export function validateReview(value) {
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
    findings: array(shape({ id: string, kind: enumeration("boundary_violation", "invariant_violation",
      "undeclared_responsibility", "responsibility_gap", "contract_conflict", "contract_change", "missing_contract"),
      certainty: enumeration("confirmed", "suspected"), severity: enumeration("info", "warning", "error"),
      lifecycle: enumeration("introduced", "persisting", "resolved", "unknown"), summary: string,
      clauses: array(clause), evidence: array(evidence, 1) },
    { details: string, recommendation: string, related_modules: strings })),
    assessment: shape({ current: assessment, change: assessment }) }, { references, extensions })(value, "review");
  if (value.module.baseline_path === null && value.module.current_path === null) fail("review.module", "оба пути отсутствуют");
  for (const s of ["baseline", "current"]) {
    if ((value.module[s + "_path"] === null) !== (value.observed[s] === null)) fail("review.observed." + s, "не совпадает с наличием модуля");
  }
  if (value.comparison.baseline === null && (value.module.baseline_path !== null || value.assessment.change.verdict !== "not_applicable")) fail("review.comparison", "первый анализ не имеет базы и оценки изменения");
  if (Boolean(value.analysis.model) !== Boolean(value.analysis.prompt_digest)) fail("review.analysis", "model и prompt_digest нужны вместе");
  if (value.analysis.coverage.status !== "complete" && !value.analysis.coverage.limitations.length) fail("review.analysis.coverage", "укажите ограничения анализа");
  for (const key of ["checks", "findings"]) {
    if (new Set(value[key].map((item) => item.id)).size !== value[key].length) fail("review." + key, "повторяющийся id");
  }
  for (const check of value.checks) if (["consistent", "violation"].includes(check.verdict) && !check.evidence.length) fail("review.checks." + check.id, "нужны доказательства");
  return value;
}

/** Парсер запрещает дубликаты, aliases, нестандартные теги и несколько документов. */
export function parseYaml(text, validate) {
  const doc = parseDocument(text, { uniqueKeys: true, strict: true, version: "1.2" });
  if (doc.errors.length || doc.warnings.length) throw new Error([...doc.errors, ...doc.warnings].map((e) => e.message).join("; "));
  return validate(doc.toJS({ maxAliasCount: 0 }));
}

/** Старый файл возвращается только как материал немедленного переноса, не как контракт. */
export function contractDocument(text, format = "arch.yaml") {
  if (!text?.trim()) return { state: "empty", text: text ?? null, format, contract: null };
  if (format === "module.md") return { state: "migration_required", text, format, contract: null,
    action: "Немедленно перенесите ответственность в arch.yaml, проверьте его и удалите module.md." };
  try { return { state: "documented", text, format, contract: parseYaml(text, validateArch) }; }
  catch (error) { return { state: "invalid", text, format, contract: null, errors: [error.message] }; }
}
