import type { AnalysisType } from "../../framework/ai-report/types.js";
import type { Snapshot, SnapshotData, SnapshotModule } from "../../framework/snapshots/types.js";
import { snapshotDigest } from "../../framework/snapshots/identity.js";
import { digest } from "../../framework/serialization/digest.js";
import * as grasp from "../grasp/analysis.js";
import * as implementation from "../implementation/analysis.js";

export const analysisInstructions = { grasp: grasp.instructions, implementation: implementation.instructions };

export function analysisModules(type: AnalysisType, snapshot: SnapshotData, own: SnapshotModule) {
  if (type === "implementation") return [own];
  const children = grasp.childDirectories(snapshot.modules, own.directory);
  return [own, ...snapshot.modules.filter(module => children.has(module.directory))];
}

export function analysisFingerprint(type: AnalysisType, modules: SnapshotModule[]) {
  const contracts = [...modules].sort((a, b) => a.directory < b.directory ? -1 : a.directory > b.directory ? 1 : 0)
    .map(module => [module.directory, module.document.contract ?? null]);
  const files = type === "implementation" ? implementation.sourceFiles(modules[0]) : [];
  return digest({type, contracts, files: files.map(file => [file.path, file.hash, file.mode ?? null])});
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
  const snapshot = { ...source, modules, facts, fingerprint: analysisFingerprint(type, selected),
    diagnostics: [], evidenceLimitations: [], observations: source.observations?.[moduleId] ?
      { [moduleId]: source.observations[moduleId] } : undefined };
  snapshot.digest = snapshotDigest(snapshot);
  return snapshot;
}
