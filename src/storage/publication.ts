import type { Snapshot } from "../snapshots/types.js";
import type { PublishedComparison, SnapshotFragment, TechnicalReport } from "../reports/types.js";
import { snapshotDigest } from "../snapshots/identity.js";
import { canonical, digest } from "../serialization/digest.js";
import { createReportModel } from "../reports/model.js";
import { validateArchiReport } from "../reports/technical-report.js";

/** Match the JSON-compatible shape returned when the same persisted data is read back. */
export function persistedCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/** Verify storage metadata after checking the portable report model. */
export function validateStoredReport(input: unknown): TechnicalReport {
  const value = validateArchiReport(input);
  if (value.publication && (!Number.isSafeInteger(value.publication.generation) || value.publication.generation < 1 || !/^sha256:[a-f0-9]{64}$/.test(value.publication.comparison_key))) throw new Error("Invalid publication identity");
  if (value.storage_diagnostics && (!Array.isArray(value.storage_diagnostics) || value.storage_diagnostics.some((item) => typeof item !== "string"))) throw new Error("Invalid storage diagnostics");
  return value;
}

const snapshotContentDigest = (snapshot: Snapshot) => snapshot.digest ?? snapshotDigest(snapshot);

export const technicalCore = ({ publication, review_status, storage_diagnostics, ...report }: TechnicalReport) => report;

/** Идентичность опубликованной пары снимков. */
export function publicationIdentity(comparison: PublishedComparison | null): string {
  return digest(comparison ? {
    baseline: comparison.baseline ? [comparison.baseline.id, snapshotContentDigest(comparison.baseline)] : null,
    current: [comparison.current.id, snapshotContentDigest(comparison.current)],
  } : null);
}

/** Собственные фрагменты вместе восстанавливают точный снимок без сырых snapshots. */
export function snapshotFragment(snapshot: Snapshot | null, directory: string | null | undefined): SnapshotFragment | null {
  if (!snapshot) return null;
  const { modules, facts = [], ...metadata } = snapshot;
  const moduleIndex = modules.findIndex((m) => m.directory === directory);
  if (moduleIndex < 0) return null;
  const module = modules[moduleIndex];
  const paths = new Set(module.files.map((f) => f.path));
  return { metadata, module_index: moduleIndex, module: persistedCopy(module), facts: facts.flatMap((fact, index) =>
    (fact.kind === "module" ? fact.path === directory : paths.has(fact.path)) ? [{ index, fact: persistedCopy(fact) }] : []) };
}

/** Не пытается угадать отсутствующие фрагменты: повреждённая публикация не база. */
export function reconstruct(reports: TechnicalReport[]): PublishedComparison | null {
  const generations = reports.filter((r) => r.publication).map((r) => r.publication!.generation);
  if (!generations.length) return null;
  const generation = Math.max(...generations);
  const selected = reports.filter((r) => r.publication?.generation === generation);
  const keys = new Set(selected.map((r) => r.publication!.comparison_key));
  if (keys.size !== 1) throw new Error("Inconsistent published comparison");
  const result: { baseline: Snapshot | null; current: Snapshot | null } = { baseline: null, current: null };
  for (const side of ["baseline", "current"] as const) {
    const fragments = selected.map((r) => r.publication![side]).filter((value) => value != null);
    if (!fragments.length) { result[side] = null; continue; }
    const metadata = fragments[0].metadata;
    if (fragments.some((f) => canonical(f.metadata) !== canonical(metadata))) throw new Error("Inconsistent snapshot metadata");
    const modules = fragments.map((f) => [f.module_index, f.module] as const).sort((a, b) => a[0] - b[0]);
    if (new Set(modules.map(([i]) => i)).size !== modules.length || modules.some(([i], index) => i !== index)) throw new Error("Incomplete published snapshot modules");
    const facts = fragments.flatMap((f) => f.facts).sort((a, b) => a.index - b.index);
    if (new Set(facts.map((f) => f.index)).size !== facts.length || facts.some((f, index) => f.index !== index)) throw new Error("Incomplete published snapshot facts");
    const snapshot = { ...metadata, modules: modules.map(([, m]) => m), facts: facts.map((f) => f.fact) };
    if (snapshot.digest && snapshotDigest(snapshot) !== snapshot.digest) throw new Error("Published snapshot digest mismatch");
    result[side] = snapshot;
  }
  if (!result.current) throw new Error("Missing published current snapshot");
  const expectedKey = publicationIdentity({ baseline: result.baseline, current: result.current });
  if (selected[0].publication!.comparison_key !== expectedKey) throw new Error("Published comparison identity mismatch");
  const model = createReportModel(result.baseline, result.current);
  for (const report of selected) {
    const expected = model.createTechnicalReport(report.project_id, { moduleId: report.module_id });
    // validateArchiReport допускает только явно поддержанные версии. Общий
    // обработчик сохраняет версию старого отчёта в manifest и его check_hash;
    // имя, конфигурация анализатора и все состояния сверяются без послаблений.
    expected.input_manifest.analyzer.version = report.input_manifest.analyzer.version;
    expected.check_hash = digest(expected.input_manifest).slice(7);
    if (canonical(technicalCore(report)) !== canonical(expected)) throw new Error("Published technical state differs from saved snapshot: " + report.module_id);
  }
  return {...result, current: result.current};
}
