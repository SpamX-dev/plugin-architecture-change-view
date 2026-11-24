import type { ModuleDetail, ModuleReview, SessionOperations } from "../../module-operations/api.js";
import type { ClauseReference, Finding as SavedFinding, FreshnessReason, ReviewReport, Side, Coverage } from "../../framework/ai-report/types.js";
import type { Contract } from "../../framework/contracts/types.js";
import type { SnapshotReference, Fact } from "../../framework/snapshots/types.js";
import type { AggregateAssessment } from "../../framework/static-report/types.js";
import type { ClauseControls } from "./module-presenter/clause-editor.js";

export type { ComparisonArgs, ComparisonView, ModuleDetail, ModuleSummary, TimelineEntry } from "../../module-operations/api.js";
export type { Assessment, ClauseCheck as Check, ClauseReference, Coverage, EvidenceReference, Observation, Side } from "../../framework/ai-report/types.js";
export type { Contract, ContractDocument, Section } from "../../framework/contracts/types.js";
export type { ChangeStatus, Fact } from "../../framework/snapshots/types.js";

/** Older saved reviews can omit details shown by current producers. */
export type Reason = string | (FreshnessReason & { message?: string; description?: string });
export type Freshness = Pick<AggregateAssessment, "status"> & {
  conflict?: boolean; current_violation?: boolean; coverage?: Coverage; reasons?: Reason[];
};
export type Finding = Pick<SavedFinding, "id" | "severity" | "summary" | "clauses" | "evidence"> & Partial<SavedFinding> & { assessmentOnly?: boolean };
export type ReviewBundle = Pick<ModuleReview, "contracts"> & Partial<Pick<ModuleReview, "reviewFile" | "stale" | "dependencies" | "referencedContracts">> & {
  freshness?: Partial<Record<"current" | "change", Freshness>>;
  facts: Record<Side, (Pick<Fact, "id" | "path"> & Partial<Fact>)[]>;
  report: Pick<ReviewReport, "id" | "module" | "assessment" | "observed" | "checks"> & {
    comparison: Partial<Record<Side, SnapshotReference | null>>;
    analysis: Pick<ReviewReport["analysis"], "created_at" | "coverage">;
    findings: Finding[];
  };
};

export interface AnalysisRecord {
  request?: Awaited<ReturnType<SessionOperations["prepareAnalysis"]>>;
  status: "preparing" | "ready" | "prepared" | "completed" | "error";
  message: string;
}
export interface FixRecord { status: string; message: string }
export interface FindingTarget { reviewId: string; findingId: string; severity?: string; summary?: string; label?: string }
export interface ClientOptions { fetcher?: typeof fetch; base?: string }
export type ArchiViewClient = SessionOperations;
export interface ContractRenderOptions {
  clauseControls?: ClauseControls;
  contractDiff: ModuleDetail["contractDiff"]; previousReferences?: Contract["references"]; titleElement?: HTMLElement; groupElement?: HTMLElement;
  hideHeading?: boolean; rawChanged?: boolean; showRawDiff?: () => void; review?: ReviewBundle; openFinding?: (target: FindingTarget) => void;
}
export interface ReviewRenderOptions {
  reviewId?: string; findingId?: string; projectRoot?: string; fixStates?: Map<string, FixRecord>;
  copyFixPrompt?: (prompt: string) => Promise<void>; fixChanged?: (reviewId: string) => void;
  openClause?: (reference: ClauseReference, review: ReviewBundle) => void;
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
export function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
export function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
