import type { Snapshot, ComparisonModule, Comparison } from "../snapshots/types.js";
import type { ReviewEntry } from "../reports/types.js";
import type { ReportModel } from "../reports/model.js";
import type { ModuleReviewState } from "./api.js";

export interface SessionView extends Comparison {
  modules: (ComparisonModule & ModuleReviewState)[];
  target?: { id: string };
  reviewDiagnostics: string[];
  baselineSnapshot: Snapshot | null;
  currentSnapshot: Snapshot;
  reviews: ReviewEntry[];
  reportModel: ReportModel;
}
