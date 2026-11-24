import type { Snapshot, ComparisonModule, Comparison } from "../framework/snapshots/types.js";
import type { ReviewEntry } from "../framework/static-report/types.js";
import type { ReportModel } from "../analyse/module-review/model.js";
import type { ModuleReviewState } from "./api.js";

export interface SessionView extends Comparison {
  modules: (ComparisonModule & ModuleReviewState)[];
  gitTree?: boolean;
  reviewLoad?: Promise<void>;
  target?: { id: string };
  reviewDiagnostics: string[];
  baselineSnapshot: Snapshot | null;
  currentSnapshot: Snapshot;
  reviews: ReviewEntry[];
  reportModel: ReportModel;
}
