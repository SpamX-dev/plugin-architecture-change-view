import type { ReviewBundle } from "../reviews/types.js";
import type { ReviewOptions, ReviewEntry } from "./types.js";
import { digest } from "../serialization/digest.js";
import { validateReviewBundle } from "../reviews/bundle.js";
import { ModuleStateContext } from "./module-state.js";
import { REPORT_SCHEMA_VERSION } from "./types.js";
import { entryContentDigest, resultDigest, isSemanticReview } from "./review-identity.js";
import { technicalReport } from "./technical-report.js";
import { createInputs } from "./review-state.js";
import { validateReviewEntry } from "./review-validation.js";

/** Факты внешнего/широкого review не теряются при миграции прежнего пакета. */
export function createReviewEntry(input: unknown, options: ReviewOptions = {}): ReviewEntry {
  if (!input || typeof input !== "object") throw new Error("Invalid review bundle");
  let bundle = input as ReviewBundle | ReviewEntry;
  const context = new ModuleStateContext();
  if ("schema_version" in bundle && bundle.schema_version === REPORT_SCHEMA_VERSION && ["review", "review-input"].includes(bundle.kind)) {
    if (bundle.kind === "review") return validateReviewEntry(structuredClone(bundle));
    const entry = structuredClone(bundle);
    entry.kind = "review";
    entry.analysis_kind = isSemanticReview(entry) ? "semantic" : "structure";
    entry.input_digest = digest({ inputs: entry.inputs, manifest: entry.manifest });
    entry.result_digest = resultDigest(entry.report);
    entry.content_digest = entryContentDigest(entry);
    return validateReviewEntry(entry);
  }
  const legacy = bundle as ReviewBundle;
  validateReviewBundle(legacy);
  bundle = legacy;
  const id = bundle.report.module.id ?? "directory:" + (bundle.report.module.current_path ?? bundle.report.module.baseline_path);
  const semantic = isSemanticReview(bundle);
  const inputs = createInputs(bundle.baseline, bundle.current, id,
    { ...options, contractScope: bundle.manifest.contract_scope ?? "effective" }, semantic, context);
  const comparisonModule = { moduleId: id, directory: (bundle.report.module.current_path ?? bundle.report.module.baseline_path)! };
  const technical = technicalReport(options.projectId ?? options.project_id ?? "legacy", bundle.baseline, bundle.current, comparisonModule, context);
  const entry: ReviewEntry = { schema_version: REPORT_SCHEMA_VERSION, kind: "review", module_id: id,
    review_id: bundle.report.id, project_id: options.projectId ?? options.project_id ?? null,
    check_hash: technical.check_hash,
    analysis_kind: semantic ? "semantic" : "structure", format: "legacy-v1", inputs,
    report: structuredClone(bundle.report), manifest: structuredClone(bundle.manifest), baseline: structuredClone(bundle.baseline), current: structuredClone(bundle.current) };
  entry.input_digest = digest({ inputs, manifest: entry.manifest });
  entry.result_digest = resultDigest(entry.report);
  entry.content_digest = entryContentDigest(entry);
  return validateReviewEntry(entry);
}
