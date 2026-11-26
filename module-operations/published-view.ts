import path from "node:path";
import { followsAnalysis } from "../analyse/module-review/analysis-timeline.js";
import { FindingDecisions } from "../analyse/module-review/dispositions.js";
import { realpath } from "node:fs/promises";
import { compareRepositorySnapshots } from "../analyse/git-changes/comparison.js";
import { createReportModel, type ReportModel } from "../analyse/module-review/model.js";
import { readPublishedTree, PublicationChanged } from "../analyse/module-review/published-reader.js";
import { errorDetails } from "../node-errors.js";
import type { ComparisonView, FileDiffArgs, ModuleArgs, ModuleDetail } from "./api.js";
import { fileDiff } from "./file-diff.js";
import * as relations from "./relations.js";
import { ApplicationError } from "./errors.js";
import { metadata, moduleDetail, moduleSummary, reviewSummary, currentAnalysisEntries, analysisSummary } from "./module-view.js";
import type { SessionView } from "./session-view.js";

/** Open the published comparison using only its portable work directory. */
export async function createPublishedView({ root: project, stateDirectory }: { root: string; stateDirectory?: string }) {
  const root = await realpath(project);
  const published = await readPublishedTree(root, stateDirectory);
  if (!published) return null;
  const { id, work, readReviews } = published;
  const decisions = new FindingDecisions(root, path.dirname(work));
  const { baseline, current } = published.pair;
  const tree = await compareRepositorySnapshots(root, baseline, current);
  const byId = new Map(published.reports.map(report => [report.module_id, report]));
  const modules: SessionView["modules"] = tree.modules.map(module => {
    const id = module.moduleId ?? "directory:" + module.directory;
    const report = byId.get(id);
    if (!report) throw new Error("В публикации нет технического отчёта модуля " + id);
    return { ...module, structure: { automatic: true, complete: tree.complete,
      checkHash: report.check_hash, diagnostics: report.structure.diagnostics },
      reviewStatus: report.review_status ?? null, ...(published.hasReviews(id) ? {} : { review: null }) };
  });
  const target = { id: "current", kind: "current", label: "Последнее опубликованное состояние", capturedAt: current.capturedAt };
  const comparison: ComparisonView = structuredClone({ ...tree, published: true, id, modules: modules.map(moduleSummary),
    reviewDiagnostics: [...new Set(published.reports.flatMap(report => report.storage_diagnostics ?? []))],
    target, timeline: [target], baselines: baseline ? [metadata(baseline)] : [], historyHasMore: false });
  let model: ReportModel | undefined;
  function selectedModule(args: ModuleArgs) {
    if (args.view !== id) throw new ApplicationError("STALE_VIEW", "Обновите сравнение");
    const module = modules.find(item => item.key === args.path);
    if (!module) throw new ApplicationError("NOT_FOUND", "Модуль не найден");
    return module;
  }
  async function getModule(args: ModuleArgs): Promise<ModuleDetail> {
    const module = selectedModule(args);
    try {
      const entries = await readReviews(module.moduleId ?? "directory:" + module.directory);
      model ??= createReportModel(baseline, current);
      const selected = await currentAnalysisEntries(entries, model, current, entry => followsAnalysis(entry, current));
      const detail = moduleDetail({ ...module, review: reviewSummary(entries, model) },
        args.currentOnly ? selected : entries, model, modules, root, work);
      detail.analyses = await analysisSummary(selected, decisions, detail.reviews);
      return detail;
    } catch (cause) {
      if (cause instanceof PublicationChanged || errorDetails(cause).code === "ENOENT")
        throw new ApplicationError("STALE_VIEW", "Публикация изменилась. Откройте сохранённое состояние ещё раз.");
      throw cause;
    }
  }
  const getFileDiff = (args: FileDiffArgs) => fileDiff(selectedModule(args), baseline, current, args.file, { repository: root });
  const getRelations = (args: ModuleArgs) => relations.getRelations(root, stateDirectory, current, selectedModule(args).currentPath);
  const getRelationSource = (args: FileDiffArgs) => {
    if (!selectedModule(args).after?.files.some(f => f.path === args.file)) throw new ApplicationError("NOT_FOUND", "Файл отсутствует в модуле.");
    return relations.getRelationSource(root, stateDirectory, current, args.file);
  };
  return { comparison, getModule, getFileDiff, getRelations, getRelationSource };
}
