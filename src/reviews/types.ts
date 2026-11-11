import type { Section } from "../contracts/types.js";
import type { Snapshot, SnapshotReference } from "../snapshots/types.js";

export type Side = "baseline" | "current";

export type AssessmentSide = "current" | "change";

export interface ClauseReference {
  snapshot: Side;
  module_id: string;
  section: Section;
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
  contracts: Record<Side, ClauseInput[]>;
  instructions: string;
  context: Record<string, unknown>;
  model?: Model;
  prompt_digest?: string;
  review_scope?: string;
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
