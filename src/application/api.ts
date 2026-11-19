/** Serializable operations exposed by a project session to all panel transports. */
import type { AggregateAssessment, DependencySelector, ReviewFreshness, TreeReviewStatus } from "../reports/types.js";
import type { AnalysisStatus, PreparedAnalysis } from "./analysis-record.js";
export type { AnalysisStatus, PreparedAnalysis } from "./analysis-record.js";
import type { ClauseInput, ReviewReport, Side } from "../reviews/types.js";
import type { Comparison, ComparisonModule, Fact, Snapshot } from "../snapshots/types.js";
import type { compareContracts, RoleChange } from "../snapshots/contract-diff.js";
import type { StructuredPatchHunk } from "diff";
import type { Section } from "../contracts/types.js";

export interface RepositoryArgs { repository?: string }
export type ComparisonArgs = RepositoryArgs & { target?: string; baseline?: string; historyLimit?: number; published?: boolean; watch?: boolean };
export type ModuleArgs = RepositoryArgs & { view: string; path: string; analysis?: boolean };
export type ClauseChange = { section: Section; clauseId: string } & (
  | { action: "add" | "edit"; text: string }
  | { action: "delete" }
  | { action: "restore"; undoToken: string }
);
export type ChangeClauseArgs = ModuleArgs & ClauseChange;
export type PrototypeChange = RepositoryArgs & { view: string; path: string } & (
  | { action: "create"; moduleId: string; title: string; purpose: string; responsibility: string }
  | { action: "edit"; text: string }
  | { action: "delete" }
);
export type FileDiffArgs = RepositoryArgs & { view: string; path: string; file: string };
export interface FileDiff { hunks: StructuredPatchHunk[]; message?: string; unchangedText?: string }
export type SnapshotArgs = RepositoryArgs & { view: string; label?: string };

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

export type ModuleSummary = Omit<ComparisonModule, "before" | "after" | "files"> & ModuleReviewState & { roles?: RoleChange[]; prototypeModule?: boolean };
export interface ComparisonView extends Pick<Comparison, "schema_version" | "id" | "root" | "complete" | "diagnostics" | "counts" | "before" | "after"> {
  /** Served from the last complete publication, before checking the working tree. */
  published?: true;
  separateAnalysis?: true;
  watchCursor?: string;
  watchError?: string;
  workspace?: { root: string; repositories: string[]; repository: string };
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
  /** Saved clauses referenced by findings, kept separate from the manifest checklist. */
  referencedContracts?: Record<Side, ClauseInput[]>;
}
export interface DocumentDiffLine {
  kind: "added" | "removed" | "same";
  beforeLine: number | null;
  afterLine: number | null;
  text: string;
}
export interface ModuleDetail extends ComparisonModule, ModuleReviewState {
  deletedClause?: { section: Section; clauseId: string; undoToken: string };
  reviews: ModuleReview[];
  diff: DocumentDiffLine[];
  contractDiff: ReturnType<typeof compareContracts>;
}
export interface SessionOperations {
  waitForChanges(args: RepositoryArgs & { cursor: string }, signal?: AbortSignal): Promise<{ cursor: string; reviewsChanged: boolean }>;
  getComparison(args?: ComparisonArgs): Promise<ComparisonView>;
  getReviewStatuses(args: RepositoryArgs & {view: string}): Promise<{modules: (ModuleReviewState & {key: string})[]; diagnostics: string[]}>;
  getModule(args: ModuleArgs): Promise<ModuleDetail>;
  changeClause(args: ChangeClauseArgs): Promise<{ undoToken?: string }>;
  changePrototype(args: PrototypeChange): Promise<{ directory: string }>;
  getFileDiff(args: FileDiffArgs): Promise<FileDiff>;
  prepareAnalysis(args: ModuleArgs): Promise<PreparedAnalysis>;
  getAnalysis(args: RepositoryArgs & { id: string }): Promise<AnalysisStatus>;
  buildReview(args: ModuleArgs): Promise<{ automatic: boolean; module_id?: string | null }>;
  saveSnapshot(args: SnapshotArgs): Promise<TimelineEntry>;
}
