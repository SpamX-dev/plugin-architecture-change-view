/** Serializable operations exposed by a project session to all panel transports. */
import type { AggregateAssessment, DependencySelector, ReviewFreshness, TreeReviewStatus } from "../framework/static-report/types.js";
import type { AnalysisStatus, PreparedAnalysis, HarnessOption, Delivery } from "./analysis-record.js";
export type { AnalysisStatus, PreparedAnalysis } from "./analysis-record.js";
import type { AnalysisType, ClauseInput, ReviewReport, Side } from "../framework/ai-report/types.js";
import type { Comparison, ComparisonModule, Fact, Snapshot } from "../framework/snapshots/types.js";
import type { compareContracts, RoleChange } from "../analyse/git-changes/contract-diff.js";
import type { StructuredPatchHunk } from "diff";
import type { Section } from "../framework/contracts/types.js";
import type { DependencyCycleCheck, ModuleRelations } from "../framework/module-relations/types.js";

import type { FindingDisposition } from "../framework/ai-report/types.js";
export interface RepositoryArgs { repository?: string }
export type ReviewSetting = "autoAnalysis" | "codexHooks";
export interface ReviewSettings {
  autoAnalysis: boolean;
  codexHooks: "on" | "off" | "partial";
  codexStatus?: "trusted" | "needsTrust" | "disabled" | "unknown";
}
export type FindingFixArgs = RepositoryArgs & { id: string; harnessId: string; reviewId: string; findingId: string };
export type ComparisonArgs = RepositoryArgs & { target?: string; baseline?: string; historyLimit?: number; published?: boolean; watch?: boolean };
export type ModuleArgs = RepositoryArgs & { view: string; path: string; analysis?: boolean; currentOnly?: boolean; analysisType?: AnalysisType };
export type ClauseChange = { action: "add"; section: Exclude<Section, "purpose">; clauseId?: string; text: string }
  | ({ section: Section; clauseId: string } & (
    | { action: "edit"; text: string }
    | { action: "delete" }
    | { action: "revert" }
    | { action: "restore"; undoToken: string }
  ));
export interface DeletedClause { section: Section; clauseId: string; undoToken: string; text: string }
export type ChangeClauseArgs = ModuleArgs & ClauseChange;
export type PrototypeChange = RepositoryArgs & { view: string; path: string } & (
  | { action: "create"; moduleId: string; title: string; purpose: string }
  | { action: "edit"; text: string }
  | { action: "delete" }
);
export type FileDiffArgs = RepositoryArgs & { view: string; path: string; file: string };
export interface FileDiff { hunks: StructuredPatchHunk[]; message?: string; unchangedText?: string }
export type SnapshotArgs = RepositoryArgs & { view: string; label?: string };

export type TimelineEntry = Pick<Snapshot, "id" | "kind" | "label" | "revision" | "isHead" | "subject" | "baseRevision">
  & { capturedAt?: string };
export interface ModuleReviewState {
  analyses?: Partial<Record<AnalysisType, { id: string; openFindings: number }>>;
  descendantsNeedAnalysis?: boolean;
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
  analysisType?: AnalysisType;
  dispositions?: Record<string, FindingDisposition>;
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
  /** YAML in the current format when the selected snapshot uses a retired field. */
  contractYaml?: string;
  /** Last recoverable deletion for clients using the single-deletion control. */
  deletedClause?: Omit<DeletedClause, "text">;
  deletedClauses?: DeletedClause[];
  reviews: ModuleReview[];
  diff: DocumentDiffLine[];
  contractDiff: ReturnType<typeof compareContracts>;
}
export interface SessionOperations {
  getReviewSettings(args: RepositoryArgs): Promise<ReviewSettings>;
  setReviewSetting(args: RepositoryArgs & {setting: ReviewSetting; enabled: boolean}): Promise<ReviewSettings>;
  waitForChanges(args: RepositoryArgs & { cursor: string }, signal?: AbortSignal): Promise<{ cursor: string; reviewsChanged: boolean }>;
  getComparison(args?: ComparisonArgs): Promise<ComparisonView>;
  getReviewStatuses(args: RepositoryArgs & {view: string}): Promise<{modules: (ModuleReviewState & {key: string})[]; diagnostics: string[]}>;
  getModule(args: ModuleArgs): Promise<ModuleDetail>;
  getRelations(args: ModuleArgs): Promise<ModuleRelations>;
  getDependencyCycles(args: ModuleArgs): Promise<DependencyCycleCheck>;
  buildRelations(args: ModuleArgs): Promise<ModuleRelations>;
  getRelationSource(args: FileDiffArgs): Promise<{ text: string }>;
  changeClause(args: ChangeClauseArgs): Promise<{ clauseId: string; undoToken?: string }>;
  changePrototype(args: PrototypeChange): Promise<{ directory: string }>;
  getFileDiff(args: FileDiffArgs): Promise<FileDiff>;
  listHarnesses(args: RepositoryArgs): Promise<{ harnesses: HarnessOption[] }>;
  deliverFindingFix(args: FindingFixArgs): Promise<Delivery>;
  deliverAnalysis(args: RepositoryArgs & { id: string; harnessId: string }): Promise<Delivery>;
  prepareAnalysis(args: ModuleArgs): Promise<PreparedAnalysis>;
  getAnalysis(args: RepositoryArgs & { id: string }): Promise<AnalysisStatus>;
  updateFinding(args: ModuleArgs & { reviewId: string; findingId: string; status: FindingDisposition["status"]; decision: string; expected: FindingDisposition }): Promise<FindingDisposition>;
  buildReview(args: ModuleArgs): Promise<{ automatic: boolean; module_id?: string | null }>;
  saveSnapshot(args: SnapshotArgs): Promise<TimelineEntry>;
}
