import { realpath } from "node:fs/promises";
import { compareSnapshots } from "../snapshots/comparison.js";
import { createReportModel, type ReportModel } from "../reports/model.js";
import { readPublishedTree, PublicationChanged } from "../storage/published-reader.js";
import { errorDetails } from "../runtime/errors.js";
import type { ComparisonView, ModuleArgs, ModuleDetail } from "./api.js";
import { ApplicationError } from "./errors.js";
import { metadata, moduleDetail, moduleSummary, reviewSummary } from "./module-view.js";
import type { SessionView } from "./session-view.js";

/** Open the published comparison using only its portable work directory. */
export async function createPublishedView({ root: project, stateDirectory }: { root: string; stateDirectory?: string }) {
  const root = await realpath(project);
  const published = await readPublishedTree(root, stateDirectory);
  if (!published) return null;
  const { id, work, readReviews } = published;
  const { baseline, current } = published.pair;
  const tree = compareSnapshots(baseline, current, { projectRoot: root });
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
  async function getModule(args: ModuleArgs): Promise<ModuleDetail> {
    if (args.view !== id) throw new ApplicationError("STALE_VIEW", "Обновите сравнение");
    const module = modules.find(item => item.key === args.path);
    if (!module) throw new ApplicationError("NOT_FOUND", "Модуль не найден");
    try {
      const entries = await readReviews(module.moduleId ?? "directory:" + module.directory);
      model ??= createReportModel(baseline, current);
      return moduleDetail({ ...module, review: reviewSummary(entries, model) }, entries, model, modules, root, work);
    } catch (cause) {
      if (cause instanceof PublicationChanged || errorDetails(cause).code === "ENOENT")
        throw new ApplicationError("STALE_VIEW", "Публикация изменилась. Откройте сохранённое состояние ещё раз.");
      throw cause;
    }
  }
  return { comparison, getModule };
}
