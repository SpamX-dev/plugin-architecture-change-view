/** Serializable operations exposed by a project session to all panel transports. */
import type { AggregateAssessment, DependencySelector, ReviewFreshness, TreeReviewStatus } from "../reports/types.js";
import type { AnalysisStatus, PreparedAnalysis } from "./analysis-record.js";
export type { AnalysisStatus, PreparedAnalysis } from "./analysis-record.js";
import type { ClauseInput, ReviewReport, Side } from "../reviews/types.js";
import type { Comparison, ComparisonModule, Fact, Snapshot } from "../snapshots/types.js";

export type ComparisonArgs = { target?: string; baseline?: string; historyLimit?: number };
export type ModuleArgs = { view: string; path: string };
export type SnapshotArgs = { view: string; label?: string };

export type TimelineEntry = Pick<Snapshot, "id" | "kind" | "label" | "revision" | "isHead" | "subject" | "baseRevision">
  & { capturedAt?: string };
export interface ModuleReviewState {
  review?: {
    id: string;
    stale: boolean;
    assessment: ReviewReport["assessment"];
    findings: number;
    activeFindings: number;
    createdAt: string;
  } | null;
  structure?: {
    automatic: boolean;
    complete: boolean;
    checkHash: string | null;
    diagnostics: string[];
  };
  reviewStatus?: TreeReviewStatus | null;
}

export type ModuleSummary = Omit<ComparisonModule, "before" | "after" | "files"> & ModuleReviewState;
export interface ComparisonView extends Pick<Comparison, "schema_version" | "id" | "root" | "complete" | "diagnostics" | "counts" | "before" | "after"> {
  reviewDiagnostics: string[];
  modules: ModuleSummary[];
  timeline: TimelineEntry[];
  target: TimelineEntry;
  baselines: TimelineEntry[];
  historyHasMore: boolean;
}

export interface ModuleReview {
  report: ReviewReport;
  stale: boolean;
  reviewFile: string;
  freshness: ReviewFreshness;
  dependencies: {
    selector: DependencySelector;
    available: boolean;
    contractOnly: boolean;
    providerStatus: AggregateAssessment | null;
  }[];
  facts: Record<Side, Fact[]>;
  contracts: Record<Side, ClauseInput[]>;
}
export interface DocumentDiffLine {
  kind: "added" | "removed" | "same";
  beforeLine: number | null;
  afterLine: number | null;
  text: string;
}
export interface ModuleDetail extends ComparisonModule, ModuleReviewState {
  reviews: ModuleReview[];
  diff: DocumentDiffLine[];
}
export interface SessionOperations {
  getComparison(args?: ComparisonArgs): Promise<ComparisonView>;
  getModule(args: ModuleArgs): Promise<ModuleDetail>;
  prepareAnalysis(args: ModuleArgs): Promise<PreparedAnalysis>;
  getAnalysis(args: { id: string }): Promise<AnalysisStatus>;
  buildReview(args: ModuleArgs): Promise<{ automatic: boolean; module_id?: string | null }>;
  saveSnapshot(args: SnapshotArgs): Promise<TimelineEntry>;
}
