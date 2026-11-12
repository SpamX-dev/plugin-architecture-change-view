import type { ReviewBundle, ClauseReference, EvidenceReference } from "../reviews/types.js";
import type { ReviewEntry } from "./types.js";
import { canonical, digest } from "../serialization/digest.js";
import { contractDocument } from "../contracts/document.js";
import { validateReview } from "../reviews/schema.js";
import {
  effectiveClauses as effectiveClausesForSnapshot,
  requiredClauseChecks,
  validateContractScope,
  validateReviewBundle,
} from "../reviews/bundle.js";
import { normalizeText, moduleId, ModuleStateContext, baselineIdentity } from "./module-state.js";
import { REPORT_SCHEMA_VERSION } from "./types.js";
import { entryContentDigest, resultDigest } from "./review-identity.js";
import { reviewState } from "./review-state.js";

/** Проверяет ссылки внутри сохранённых частей, не читая нынешние исходники. */
function validateScopedProof(entry: ReviewEntry) {
  for (const snapshot of [entry.baseline, entry.current].filter((value) => value != null)) {
    const { scope_digest, ...content } = snapshot;
    if (snapshot.schema_version !== 2 || !snapshot.scoped || digest(content) !== scope_digest) throw new Error("Scoped snapshot digest mismatch");
    const allowed = ["schema_version", "id", "digest", "kind", "revision", "complete", "modules", "facts",
      "diagnostics", "evidenceLimitations", "scoped", "scope_digest"];
    if (Object.keys(snapshot).some((key) => !allowed.includes(key))) throw new Error("Unknown scoped snapshot field");
    if (!Array.isArray(snapshot.modules) || !Array.isArray(snapshot.facts)) throw new Error("Invalid scoped snapshot collections");
    const relative = (value: unknown, directory = false) => typeof value === "string" && (directory && value === "." ||
      value.length > 0 && !/[\\:]/.test(value) && !value.startsWith("/") &&
      !value.split("/").some((part) => ["", ".", ".."].includes(part)));
    if (new Set(snapshot.modules.map((module) => module.directory)).size !== snapshot.modules.length ||
      snapshot.modules.some((module) => !relative(module.directory, true) || !Array.isArray(module.files) ||
        module.files.some((file) => !relative(file.path)))) throw new Error("Invalid scoped module paths");
    if (new Set(snapshot.facts.map((fact) => fact.id)).size !== snapshot.facts.length) throw new Error("Duplicate scoped evidence identity");
    for (const module of snapshot.modules) if (module.document?.state === "documented") {
      const parsed = contractDocument(module.document.text, module.document.format);
      if (parsed.state !== "documented" || canonical(parsed.contract) !== canonical(module.document.contract)) throw new Error("Saved contract text disagrees with parsed contract");
      const contractFact = snapshot.facts.find((fact) => fact.kind === "file" && fact.path === module.documentPath);
      if (contractFact && normalizeText(contractFact.text) !== normalizeText(module.document.text ?? "")) throw new Error("Saved contract evidence disagrees with document");
    }
    for (const fact of snapshot.facts) {
      const { id, ...content } = fact;
      if (digest(content) !== id || typeof fact.text !== "string" || !relative(fact.path, fact.kind === "module")) throw new Error("Evidence content digest mismatch");
    }
  }
  const evidence = (reference: EvidenceReference) => {
    const snapshot = entry[reference.snapshot];
    if ((snapshot?.facts ?? []).filter((fact) => fact.id === reference.fact_id).length !== 1) throw new Error("Unresolved evidence: " + reference.fact_id);
  };
  const clause = (reference: ClauseReference) => {
    const modules = entry[reference.snapshot]?.modules.filter((module) => module.document?.contract?.id === reference.module_id) ?? [];
    if (modules.length !== 1 || !Object.hasOwn(modules[0].document.contract![reference.section] ?? {}, reference.id)) throw new Error("Unresolved contract clause: " + reference.module_id);
  };
  for (const check of entry.report.checks) { clause(check.contract); check.evidence.forEach(evidence); }
  for (const finding of entry.report.findings) { finding.clauses.forEach(clause); finding.evidence.forEach(evidence); }
  for (const observed of Object.values(entry.report.observed)) observed?.responsibilities.forEach((item) => item.evidence.forEach(evidence));
  // Все требуемые собственные пункты остаются явными, включая честное not_checked.
  // Удаление неудобного пункта не превращает неполный анализ в полный.
  for (const { item, subject } of requiredClauseChecks(entry.manifest, entry.report.module.current_path !== null)) {
    if (!entry.report.checks.some((check) => check.subject === subject &&
      canonical(check.contract) === canonical(item.reference))) throw new Error("Missing explicit clause check: " + item.reference.id);
  }
}

/** Строгая целостность переносимой записи; неизвестные версии не «актуальны». */
export function validateReviewEntry(input: unknown): ReviewEntry {
  const entry = input as ReviewEntry;
  const context = new ModuleStateContext();
  if (entry?.schema_version !== REPORT_SCHEMA_VERSION || entry.kind !== "review" || !["native-v2", "legacy-v1"].includes(entry.format)) throw new Error("Unsupported review entry schema");
  if (!entry.module_id || entry.review_id !== entry.report?.id || !/^[a-f0-9]{64}$/.test(entry.check_hash)) throw new Error("Invalid review entry identity");
  validateReview(entry.report);
  if (entry.report.module.id !== null && entry.module_id !== entry.report.module.id) throw new Error("Review module identity mismatch");
  if (!entry.inputs || entry.inputs.schema_version !== 1 || !["self", "subtree"].includes(entry.inputs.scope)) throw new Error("Unsupported review inputs");
  const contractScope = validateContractScope(entry.report, entry.manifest, entry);
  if ((entry.inputs.contract_scope ?? "effective") !== contractScope) throw new Error("Review contract scope mismatch");
  if (digest(entry.inputs.current) !== entry.inputs.current_digest ||
    digest({ baseline_identity: entry.inputs.baseline_identity, baseline: entry.inputs.baseline, current: entry.inputs.current }) !== entry.inputs.change_digest) throw new Error("Review assessment input digest mismatch");
  for (const input of [entry.inputs.current, entry.inputs.baseline].filter((value) => value != null)) {
    if (!Array.isArray(input.dependencies) || !["complete", "unknown"].includes(input.dependency_coverage?.status) ||
      !Array.isArray(input.dependency_coverage.potential_influence)) throw new Error("Missing explicit dependency coverage");
    if (input.dependency_coverage.status === "complete" && input.dependency_coverage.potential_influence.length) throw new Error("Complete dependencies still have unresolved influence");
    if (new Set(input.dependencies.map((dependency) => canonical(dependency.selector))).size !== input.dependencies.length) throw new Error("Duplicate dependency selector");
  }
  if (entry.input_digest !== digest({ inputs: entry.inputs, manifest: entry.manifest }) || entry.result_digest !== resultDigest(entry.report) || entry.content_digest !== entryContentDigest(entry)) throw new Error("Review entry content digest mismatch");
  if (entry.format === "legacy-v1") validateReviewBundle(entry as ReviewBundle);
  else {
    if (typeof entry.project_id !== "string" || !entry.project_id || !entry.check_manifest || digest(entry.check_manifest).slice(7) !== entry.check_hash ||
      entry.check_manifest.project_id !== entry.project_id || entry.check_manifest.module_id !== entry.module_id ||
      entry.check_manifest.domain !== "archiview/module-check/v1") throw new Error("Native technical check manifest mismatch");
    if (!entry.report.analysis.model || !entry.report.analysis.prompt_digest) throw new Error("Native LLM review needs model and prompt_digest");
    if (digest(entry.manifest) !== entry.report.analysis.input_digest ||
      digest(entry.manifest.module) !== digest(entry.report.module) ||
      digest(entry.manifest.comparison) !== digest(entry.report.comparison) ||
      entry.manifest.scope !== entry.report.analysis.scope ||
      entry.manifest.review_scope !== entry.inputs.scope ||
      digest(entry.manifest.analyzer) !== digest(entry.report.analysis.analyzer) ||
      digest(entry.manifest.model) !== digest(entry.report.analysis.model) || entry.manifest.prompt_digest !== entry.report.analysis.prompt_digest) throw new Error("Native review manifest mismatch");
    validateScopedProof(entry);
    for (const [side, snapshot] of ([["baseline", entry.baseline], ["current", entry.current]] as const)) {
      const reference = entry.report.comparison[side];
      if ((snapshot === null) !== (reference === null) || (snapshot &&
        (snapshot.id !== reference?.id || snapshot.digest !== reference?.digest))) throw new Error("Native snapshot provenance mismatch: " + side);
      const input = entry.inputs[side];
      if ((snapshot === null) !== (input === null)) throw new Error("Missing native assessment input: " + side);
      if (!snapshot) continue;
      if (!input) throw new Error("Missing scoped input");
      const selectors = input.dependencies.map((dependency) => dependency.selector);
      const actual = reviewState(snapshot, entry.module_id, entry.inputs.scope, selectors, input.dependency_coverage, contractScope, context);
      if (canonical(actual) !== canonical(input)) throw new Error("Native assessment inputs disagree with saved snapshot: " + side);
      const directory = entry.report.module[`${side}_path`];
      const own = snapshot.modules.find((module) => moduleId(module) === entry.module_id);
      if ((own?.directory ?? null) !== directory) throw new Error("Native module path mismatch: " + side);
      const state = context.states(snapshot).get(entry.module_id);
      const technicalReference = side === "baseline" ? entry.check_manifest.baseline?.state : entry.check_manifest.current;
      if (technicalReference?.exists !== Boolean(state) || (state && (technicalReference.directory !== state.directory ||
        technicalReference.self_digest !== state.technical_digest))) throw new Error("Native technical own-state mismatch: " + side);
      const actualClauses = effectiveClausesForSnapshot(snapshot, directory, side, contractScope);
      if (canonical(actualClauses) !== canonical(entry.manifest.contracts?.[side])) throw new Error("Native effective contracts mismatch: " + side);
    }
    if (canonical(entry.inputs.baseline_identity) !== canonical(baselineIdentity(entry.baseline, context))) throw new Error("Native baseline identity mismatch");
    if (canonical(entry.check_manifest.baseline?.identity ?? null) !== canonical(entry.inputs.baseline_identity)) throw new Error("Native technical baseline mismatch");
    if (entry.report.analysis.coverage.status === "complete") {
      if ([entry.inputs.current, entry.inputs.baseline].filter((value) => value != null).some((input) => !input.complete ||
        input.dependency_coverage.status !== "complete" || input.dependencies.some((dependency) => !dependency.available)) ||
        entry.report.checks.some((check) => ["not_checked", "uncertain"].includes(check.verdict))) throw new Error("Complete native review has unreviewed inputs or clauses");
    }
  }
  if (entry.resolution && (!Array.isArray(entry.resolution.review_ids) || !entry.resolution.review_ids.length ||
    entry.resolution.review_ids.some((id) => typeof id !== "string" || !id || id === entry.review_id) ||
    new Set(entry.resolution.review_ids).size !== entry.resolution.review_ids.length ||
    typeof entry.resolution.reason !== "string" || !entry.resolution.reason.trim())) throw new Error("Invalid explicit review resolution");
  return entry;
}
