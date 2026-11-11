import type { SnapshotData, ComparisonModule } from "../snapshots/types.js";
import type { ReviewEntry } from "./types.js";
import { ModuleStateContext } from "./module-state.js";
import { technicalReport } from "./technical-report.js";
import { freshness } from "./freshness.js";
import { treeStatuses } from "./tree-status.js";

/**
 * Переносимая модель отчётов v2 без ввода-вывода. Технический check_hash описывает
 * входы одного модуля, а применимость LLM-оценки — её собственный манифест.
 * Эти идентичности намеренно различаются: реализация потомка меняет техническое
 * поддерево родителя, но не обнуляет проверку его собственной композиции.
 */

/**
 * Фиксирует пару снимков для серии отчётов и оценок актуальности. Собственные
 * копии изолируют расчёт от последующих изменений объектов вызывающей стороны;
 * новая операция создаёт новую модель и видит новые данные без глобального кэша.
 * Готовые состояния каждого снимка вычисляются лениво и остаются внутри модели.
 */
export function createReportModel(baseline: SnapshotData | null, current: SnapshotData) {
  const snapshots = structuredClone({ baseline, current });
  const context = new ModuleStateContext();
  return Object.freeze({
    createTechnicalReport: (projectId: string, module: Partial<ComparisonModule>) => technicalReport(projectId, snapshots.baseline, snapshots.current, module, context),
    reviewFreshness: (entry: ReviewEntry) => freshness(entry, snapshots.baseline, snapshots.current, context),
    aggregateTreeStatuses: (entries: ReviewEntry[]) => treeStatuses(entries, snapshots.baseline, snapshots.current, context),
  });
}

/** Формирует чистый технический результат; будущие LLM-статусы в него не пишутся. */
export function createTechnicalReport(projectId: string, baseline: SnapshotData | null, current: SnapshotData, comparisonModule: Partial<ComparisonModule>) {
  return createReportModel(baseline, current).createTechnicalReport(projectId, comparisonModule);
}

/** Current зависит от проверенного состояния; change дополнительно от явной базы. */
export function reviewFreshness(entry: ReviewEntry, baseline: SnapshotData | null, current: SnapshotData) {
  return createReportModel(baseline, current).reviewFreshness(entry);
}

/** Объединяет полноту и актуальность вверх, не запускает LLM и не меняет вердикты. */
export function aggregateTreeStatuses(entries: ReviewEntry[], baseline: SnapshotData | null, current: SnapshotData) {
  return createReportModel(baseline, current).aggregateTreeStatuses(entries);
}

export type ReportModel = ReturnType<typeof createReportModel>;
