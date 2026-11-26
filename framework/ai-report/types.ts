import type { ReviewSection } from "../contracts/types.js";
import type { Snapshot, SnapshotReference } from "../snapshots/types.js";

export const analysisTypes = ["composition", "implementation"] as const;
export type AnalysisType = typeof analysisTypes[number];
export type StoredAnalysisType = AnalysisType | "grasp";
export function isAnalysisType(value: unknown): value is AnalysisType {
  return analysisTypes.some(type => type === value);
}

/** Translate the old stored/request key without changing the source data. */
export function normalizeAnalysisType(value: unknown): AnalysisType | undefined {
  if (value === "grasp") return "composition";
  if (isAnalysisType(value)) return value;
}

export const compositionExtension = "archiview.composition";
export interface CompositionParticipant { moduleId: string; role: "executor" | "utility"; task: string; assessment: string; consumers?: string[] }
export function compositionParticipants(report: Pick<ReviewReport, "extensions"> & {
  analysis: { analyzer?: Pick<Analyzer, "name"> };
}): CompositionParticipant[] | undefined {
  const key = report.analysis.analyzer?.name === "archiview-grasp" ? "archiview.grasp" : compositionExtension;
  const value = report.extensions?.[key];
  if (Array.isArray(value)) return value;
}

export interface FindingDisposition { status: "open" | "accepted" | "resolved"; decision: string }
export function validDisposition(value: unknown): value is FindingDisposition {
  if (!value || typeof value !== "object") return false;
  const item = value as FindingDisposition;
  return Object.keys(item).every(key => key === "status" || key === "decision") &&
    ["open", "accepted", "resolved"].includes(item.status) && typeof item.decision === "string";
}
export const openFinding: FindingDisposition = {status: "open", decision: ""};

export type Side = "baseline" | "current";

export type AssessmentSide = "current" | "change";

export interface ClauseReference {
  snapshot: Side;
  module_id: string;
  section: ReviewSection;
  id: string;
}

export interface ClauseInput {
  reference: ClauseReference;
  text: string;
}

export interface EvidenceReference {
  snapshot: Side;
  fact_id: string;
}

export interface Analyzer {
  name: string;
  version: string;
  config_digest: string;
}

export interface FreshnessReason {
  code: string;
  side?: string;
  potential_influence?: { scope: string; module_id?: string; path?: string }[];
}

export interface Coverage {
  status: string;
  limitations: string[];
  reasons?: FreshnessReason[];
}

export interface Model {
  provider: string;
  id: string;
  revision?: string;
  parameters?: Record<string, unknown>;
}

export interface ReviewManifest {
  schema_version: number;
  comparison: Record<Side, SnapshotReference | null>;
  module: {
    id: string | null;
    baseline_path: string | null;
    current_path: string | null;
  };
  analyzer: Analyzer;
  scope: string;
  contract_scope?: string;
  clause_format?: "purpose";
  contracts: Record<Side, ClauseInput[]>;
  instructions: string;
  context: Record<string, unknown>;
  model?: Model;
  prompt_digest?: string;
  review_scope?: string;
  analysis_type?: StoredAnalysisType;
  source_snapshot?: SnapshotReference;
  source_head?: string | null;
  source_captured_at?: string;
}

export interface Observation {
  summary: string;
  responsibilities: { text: string; evidence: EvidenceReference[] }[];
}

export interface ClauseCheck {
  id: string;
  contract: ClauseReference;
  subject: Side;
  verdict: string;
  explanation: string;
  evidence: EvidenceReference[];
}

export interface Finding {
  id: string;
  kind: string;
  certainty: string;
  severity: string;
  lifecycle: string;
  summary: string;
  clauses: ClauseReference[];
  evidence: EvidenceReference[];
  details?: string;
  recommendation?: string;
  related_modules?: string[];
}

export interface Assessment {
  verdict: string;
  summary: string;
}

export interface ReviewReport {
  schema_version: number;
  id: string;
  module: ReviewManifest["module"];
  comparison: ReviewManifest["comparison"];
  analysis: {
    created_at: string;
    analyzer: Analyzer;
    input_digest: string;
    scope: string;
    coverage: Coverage;
    model?: Model;
    prompt_digest?: string;
  };
  observed: Record<Side, Observation | null>;
  checks: ClauseCheck[];
  findings: Finding[];
  assessment: Record<AssessmentSide, Assessment>;
  references?: { title: string; uri: string }[];
  extensions?: Record<string, unknown>;
}

export interface ReviewBundle {
  report: ReviewReport;
  manifest: ReviewManifest;
  baseline: Snapshot | null;
  current: Snapshot;
}
