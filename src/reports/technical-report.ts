import type { SnapshotData, ComparisonModule } from "../snapshots/types.js";
import type { ModuleState, TechnicalReport } from "./types.js";
import { canonical, digest } from "../serialization/digest.js";
import { ANALYZER } from "../reviews/bundle.js";
import { moduleId, type ModuleStateContext, baselineIdentity } from "./module-state.js";
import { REPORT_SCHEMA_VERSION } from "./types.js";

/** Состояние отсутствующего модуля отличается от отсутствующей базы. */
const stateReference = (state: ModuleState | null | undefined) => state ? { exists: true, directory: state.directory,
  self_digest: state.technical_digest, subtree_digest: state.subtree_digest } : { exists: false };

/** Готовые состояния принадлежат контексту; наружу передаются независимые данные отчёта. */
export function technicalReport(projectId: string, baseline: SnapshotData | null, current: SnapshotData, comparisonModule: Partial<ComparisonModule>, context: ModuleStateContext): TechnicalReport {
  const id = comparisonModule.moduleId ?? comparisonModule.module_id ??
    (comparisonModule.after ? moduleId(comparisonModule.after) : comparisonModule.before ? moduleId(comparisonModule.before) :
      "directory:" + comparisonModule.directory);
  const before = context.states(baseline).get(id);
  const after = context.states(current).get(id);
  const input = { domain: "archiview/module-check/v1", project_id: projectId, module_id: id,
    baseline: baseline ? { identity: baselineIdentity(baseline, context), state: stateReference(before) } : null,
    current: stateReference(after), analyzer: structuredClone(ANALYZER) };
  const ownChanged = canonical(before?.technical.own_files ?? null) !== canonical(after?.technical.own_files ?? null);
  const childrenChanged = canonical(before?.subtree?.children ?? []) !== canonical(after?.subtree?.children ?? []);
  const contractChanged = canonical(before?.technical.contract ?? null) !== canonical(after?.technical.contract ?? null);
  const inheritedChanged = canonical(before?.self.inherited ?? []) !== canonical(after?.self.inherited ?? []);
  return { schema_version: REPORT_SCHEMA_VERSION, kind: "archi", module_id: id, project_id: projectId,
    check_hash: digest(input).slice(7), input_manifest: input,
    baseline: before ? structuredClone(before) : null, current: after ? structuredClone(after) : null,
    change: { existence: !baseline ? "initial" : !before ? "added" : !after ? "removed" : "retained",
      own: ownChanged || contractChanged || before?.directory !== after?.directory,
      own_code: ownChanged, own_contract: contractChanged, inherited_constraints: inheritedChanged,
      descendants: childrenChanged,
      child_composition: canonical(before?.self.children ?? []) !== canonical(after?.self.children ?? []),
      moved: Boolean(before && after && before.directory !== after.directory) },
    structure: { complete: (before?.complete ?? true) && (after?.complete ?? true),
      diagnostics: structuredClone([...(baseline?.diagnostics ?? []), ...(current?.diagnostics ?? [])]),
      document_state: after?.technical.document_state ?? before?.technical.document_state ?? "missing" } };
}


/** Обе версии используют одинаковые правила технического состояния; новые версии добавляются после проверки совместимости. */
export const SUPPORTED_TECHNICAL_ANALYZER_VERSIONS = Object.freeze(["1.0.1", "1.0.2"]);

/** Проверяет минимум переносимой технической схемы и её содержательный отпечаток. */
export function validateArchiReport(input: unknown): TechnicalReport {
  const value = input as TechnicalReport;
  if (!value || value.schema_version !== REPORT_SCHEMA_VERSION || value.kind !== "archi" || typeof value.module_id !== "string" || !value.module_id || !/^[a-f0-9]{64}$/.test(value.check_hash)) throw new Error("Invalid archi report schema");
  if (Object.keys(value).some((key) => !["schema_version", "kind", "module_id", "project_id", "check_hash", "input_manifest", "baseline", "current", "change", "structure", "publication", "review_status", "storage_diagnostics"].includes(key))) throw new Error("Unknown archi report field");
  if (!value.input_manifest || digest(value.input_manifest).slice(7) !== value.check_hash) throw new Error("Technical check hash mismatch");
  if (value.input_manifest.project_id !== value.project_id || value.input_manifest.module_id !== value.module_id) throw new Error("Technical report identity mismatch");
  const version = value.input_manifest.analyzer?.version;
  if (!SUPPORTED_TECHNICAL_ANALYZER_VERSIONS.includes(version)) throw new Error(
    "Версия анализатора технического отчёта «" + (typeof version === "string" ? version : "не указана") +
    "» не поддерживается. Поддерживаемые версии: " + SUPPORTED_TECHNICAL_ANALYZER_VERSIONS.join(", ") + ".");
  for (const side of ["baseline", "current"] as const) {
    const state = value[side];
    const reference = side === "baseline" ? value.input_manifest.baseline?.state : value.input_manifest.current;
    const expected = stateReference(state);
    if ((side !== "baseline" || value.input_manifest.baseline) && canonical(reference) !== canonical(expected)) throw new Error("Technical state reference mismatch");
    if (state) {
      if (state.module_id !== value.module_id || state.technical.module_id !== value.module_id || state.self.module_id !== value.module_id || state.technical.directory !== state.directory || state.self.directory !== state.directory) throw new Error("Technical state identity mismatch");
      for (const key of ["technical", "self", "subtree", "semantic_subtree"] as const) if (digest(state[key]) !== state[`${key}_digest`]) throw new Error("Technical state digest mismatch");
    }
  }
  return value;
}
