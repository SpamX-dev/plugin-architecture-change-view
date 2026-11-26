import { normalizeAnalysisType, type AnalysisType, type ReviewManifest, type ReviewReport } from "../../framework/ai-report/types.js";
import type { Snapshot, SnapshotData, SnapshotModule } from "../../framework/snapshots/types.js";
import { snapshotDigest } from "../../framework/snapshots/identity.js";
import { digest } from "../../framework/serialization/digest.js";
import * as composition from "../composition/analysis.js";
import * as implementation from "../implementation/analysis.js";
import { directChildContracts } from "./module-state.js";

export const analysisInstructions = { composition: composition.instructions, implementation: implementation.instructions };

export function analysisModules(type: AnalysisType, snapshot: SnapshotData, own: SnapshotModule) {
  if (type === "implementation") return [own];
  return [own, ...(composition.compositionChildren(snapshot.modules).get(own.directory) ?? [])];
}

/** Both full bundles and compact records must prove the projection of the declared analysis. */
export function validateTypedAnalysis({ report, manifest, current, baseline }: {
  report: ReviewReport; manifest: ReviewManifest; current: SnapshotData; baseline: SnapshotData | null;
}) {
  const storedType = manifest.analysis_type;
  const type = normalizeAnalysisType(storedType);
  const analyzer = report.analysis.analyzer.name;
  if (storedType === undefined && !["archiview-grasp", "archiview-composition", "archiview-implementation"].includes(analyzer)) return;
  const source = manifest.source_snapshot;
  if (!type || analyzer !== "archiview-" + storedType || baseline || !current.complete ||
      !source || source.id !== current.id || typeof source.digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(source.digest) ||
      report.analysis.coverage.status !== "complete" || report.assessment.current.verdict === "inconclusive" ||
      report.checks.some(check => check.verdict === "not_checked" || check.verdict === "uncertain"))
    throw new Error("Для сохранения нужен завершённый анализ выбранного вида и среза.");
  const own = current.modules.find(module => module.document.contract?.id === report.module.id);
  if (!own) throw new Error("Missing analysis module: " + report.module.id);
  const selected = analysisModules(type, current, own);
  if (current.modules.length !== selected.length) throw new Error("Modules outside analysis scope");
  if (type === "composition") {
    const children = selected.slice(1).map(module => {
      if (!module.document.contract) throw new Error("Missing analysis contract: " + module.directory);
      return module.document.contract.id;
    });
    composition.validateComposition(report, children);
  }
  const paths = new Set(selected.map(module => module.documentPath));
  if (type === "implementation") {
    for (const file of implementation.sourceFiles(own)) paths.add(file.path);
  }
  for (const fact of current.facts) {
    if (fact.kind !== "file" || !paths.delete(fact.path)) throw new Error("Evidence outside analysis scope: " + fact.path);
  }
  if (paths.size) throw new Error("Missing analysis evidence: " + [...paths].join(", "));
}

/** Build the immediate-child index once when comparing analysis inputs for a whole repository. */
export function projectAnalysisScopes(snapshot: SnapshotData) {
  const children = directChildContracts(snapshot.modules);
  const directories = new Map(snapshot.modules.map(module => [module.directory, module]));
  return snapshot.modules.map(module => {
    const composition = children.get(module.directory) ?? [];
    const participants = composition.map(child => directories.get(child.directory)!);
    const hashes = { composition: analysisFingerprint("composition", [module, ...participants]),
      implementation: analysisFingerprint("implementation", [module]) };
    return {module, composition, hashes};
  });
}

export function analysisFingerprint(type: AnalysisType, modules: SnapshotModule[]) {
  const contracts = [...modules].sort((a, b) => a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0)
    .map(module => [module.directory, module.document.contract ?? null]);
  const files = type === "implementation" ? implementation.sourceFiles(modules[0]) : [];
  // The digest domain is shared by both names so unchanged inputs keep their identity.
  return digest({type: type === "composition" ? "grasp" : type, contracts, files: files.map(file => [file.path, file.hash, file.mode ?? null])});
}

/** Export only evidence belonging to this analysis. Keep the original snapshot reference in the manifest. */
export function analysisSnapshot(type: AnalysisType, source: Snapshot, moduleId: string): Snapshot {
  const own = source.modules.find(module => module.document.contract?.id === moduleId);
  if (!source.complete || !own) throw new Error("Для анализа нужен модуль в выбранном срезе.");
  const selected = analysisModules(type, source, own);
  const factsByPath = new Map(source.facts.filter(fact => fact.kind === "file").map(fact => [fact.path, fact]));
  const facts: Snapshot["facts"] = [];
  const modules = selected.map(module => {
    if (!module.document.contract || !module.document.text) throw new Error("Отсутствует контракт модуля " + module.directory);
    const documentFact = { kind: "file", path: module.documentPath, start_line: 1,
      end_line: module.document.text.split("\n").length, text: module.document.text };
    facts.push(factsByPath.get(module.documentPath) ?? { ...documentFact, id: digest(documentFact) });
    const sources = type === "implementation" ? implementation.sourceFiles(module) : [];
    for (const file of sources) {
      const fact = factsByPath.get(file.path);
      if (!fact || file.error) throw new Error("В срезе отсутствует исходный текст " + file.path);
      facts.push(fact);
    }
    const files = module.files.filter(file => file.path === module.documentPath || sources.includes(file));
    return { ...module, files, sourceFiles: sources.length, fingerprint: digest(files) };
  });
  let observations: Snapshot["observations"];
  const observed = source.observations?.[moduleId];
  if (observed) {
    const { grasp, ...observation } = observed;
    if (grasp !== undefined) observation.composition ??= grasp;
    observations = { [moduleId]: observation };
  }
  const snapshot = { ...source, modules, facts, fingerprint: analysisFingerprint(type, selected),
    diagnostics: [], evidenceLimitations: [], observations };
  snapshot.digest = snapshotDigest(snapshot);
  return snapshot;
}
