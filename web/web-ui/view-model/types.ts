import type { Delivery } from "../../../module-operations/analysis-record.js";
import type { ComparisonView, ModuleDetail, ModuleReview, ModuleSummary, SessionOperations, FindingFixArgs } from "../../../module-operations/api.js";
import type { ClauseReference, Finding as SavedFinding, FindingDisposition, FreshnessReason, ReviewReport, Side, Coverage } from "../../../framework/ai-report/types.js";
import type { Contract, Section } from "../../../framework/contracts/types.js";
import type { SnapshotReference, Fact } from "../../../framework/snapshots/types.js";
import type { AggregateAssessment } from "../../../framework/static-report/types.js";
import type { ContractFieldChange } from "../../../analyse/git-changes/contract-diff.js";

export type { ComparisonArgs, ComparisonView, ModuleDetail, ModuleSummary, TimelineEntry } from "../../../module-operations/api.js";
export type { Assessment, ClauseCheck as Check, ClauseReference, Coverage, EvidenceReference, Observation, Side } from "../../../framework/ai-report/types.js";
export type { Contract, ContractDocument, Section } from "../../../framework/contracts/types.js";
export type { ChangeStatus, Fact } from "../../../framework/snapshots/types.js";

/** Older saved reviews can omit details shown by current producers. */
export type Reason = string | (FreshnessReason & { message?: string; description?: string });
export type Freshness = Pick<AggregateAssessment, "status"> & {
  conflict?: boolean; current_violation?: boolean; coverage?: Coverage; reasons?: Reason[];
};
export type Finding = Pick<SavedFinding, "id" | "severity" | "summary" | "clauses" | "evidence"> & Partial<SavedFinding> & { assessmentOnly?: boolean };
export type ReviewBundle = Pick<ModuleReview, "contracts"> & Partial<Pick<ModuleReview, "analysisType" | "dispositions" | "reviewFile" | "stale" | "dependencies" | "referencedContracts">> & {
  freshness?: Partial<Record<"current" | "change", Freshness>>;
  facts: Record<Side, (Pick<Fact, "id" | "path"> & Partial<Fact>)[]>;
  report: Pick<ReviewReport, "id" | "module" | "assessment" | "observed" | "checks" | "extensions"> & {
    comparison: Partial<Record<Side, SnapshotReference | null>>;
    analysis: Pick<ReviewReport["analysis"], "created_at" | "coverage"> & Partial<Pick<ReviewReport["analysis"], "analyzer">>;
    findings: Finding[];
  };
};

export interface AnalysisRecord {
  delivery?: Delivery;
  request?: Awaited<ReturnType<SessionOperations["prepareAnalysis"]>>;
  status: "preparing" | "ready" | "prepared" | "completed" | "error";
  message: string;
}
export interface FixRecord { status: string; message: string; attempt?: { id: string; harnessId: string } }
export interface FindingTarget { reviewId: string; findingId: string; severity?: string; summary?: string; label?: string }
export interface ClientOptions { fetcher?: typeof fetch; base?: string }
export type ArchiViewClient = SessionOperations;
export interface ClauseNavigation {
  reference: ClauseReference;
  review: ReviewBundle;
}
export interface WorkspaceSelection {
  target?: string;
  historyLimit?: number;
  clause?: ClauseNavigation;
  repository?: string;
  key?: string;
}
export interface WorkspaceContext {
  readonly view: ComparisonView | null;
  readonly refreshing: boolean;
  readonly reviewError?: string;
  readonly statusLoaded: boolean;
  refresh(selection?: WorkspaceSelection): Promise<void>;
  loadStatuses(view: ComparisonView): Promise<void>;
  reveal(module: ModuleSummary): void;
}
export interface ClauseItem { id: string; change: ContractFieldChange }
export interface ClauseControls {
  open(section: Section, title: string, item?: ClauseItem): void;
}
export interface ContractRenderOptions {
  clauseControls?: ClauseControls;
  contractDiff: ModuleDetail["contractDiff"]; previousReferences?: Contract["references"]; titleElement?: HTMLElement; groupElement?: HTMLElement;
  hideHeading?: boolean; rawChanged?: boolean; showRawDiff?: () => void; reviews?: ReviewBundle[]; review?: ReviewBundle; openFinding?: (target: FindingTarget) => void;
}
export interface ReviewRenderOptions {
  reviewId?: string; findingId?: string; projectRoot?: string; fixStates?: Map<string, FixRecord>;
  listFixHarnesses?: () => ReturnType<SessionOperations["listHarnesses"]>;
  deliverFix?: (args: Omit<FindingFixArgs, "repository">) => Promise<Delivery>;
  copyFixPrompt?: (prompt: string) => Promise<void>; fixChanged?: (reviewId: string) => void;
  saveDecision?: (reviewId: string, findingId: string, next: FindingDisposition, previous: FindingDisposition) => Promise<void>;
  openClause?: (reference: ClauseReference, review: ReviewBundle) => void;
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
export function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
