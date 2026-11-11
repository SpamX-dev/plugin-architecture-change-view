import type { AssessmentSide, Analyzer, FreshnessReason, Coverage, ReviewBundle } from "../reviews/types.js";
import type { Contract } from "../contracts/types.js";
import type { Fact, SnapshotModule, Snapshot, SnapshotData } from "../snapshots/types.js";

export const REPORT_SCHEMA_VERSION = 2;

export interface FileInput {
  path: string;
  digest: string;
  normalization: string;
  error?: string;
}

export interface InheritedInput {
  module_id: string;
  section: string;
  id: string;
  text: string;
}

export interface SelfState {
  normalization: string;
  module_id: string;
  directory: string;
  own_files: FileInput[];
  contract: Partial<Contract> | null;
  inherited?: InheritedInput[];
  children: {
    module_id: string;
    directory: string;
    contract: Partial<Contract> | null;
    document_state: string;
  }[];
}

export interface ModuleState {
  module_id: string;
  directory: string;
  parent_id: string | null;
  children: string[];
  technical: {
    normalization: string;
    module_id: string;
    directory: string;
    own_files: FileInput[];
    contract: Contract | null;
    document_state: string;
    inherited: InheritedInput[];
    invalid_contract_digest?: string;
  };
  technical_digest: string;
  complete: boolean;
  self: SelfState;
  self_digest?: string;
  subtree?: { self: string; children: { module_id: string; digest: string }[] };
  subtree_digest?: string;
  semantic_subtree?: {
    self: string | undefined;
    children: { module_id: string; digest: string | undefined }[];
  };
  semantic_subtree_digest?: string;
}

export interface DependencySelector {
  kind: string;
  module_id?: string;
  path?: string;
  fields?: string[];
  scope?: string;
}

export interface DependencyCoverage {
  status: string;
  potential_influence: { scope: string; module_id?: string; path?: string }[];
}

export interface DependencyInput {
  selector: DependencySelector;
  available: boolean;
  digest?: string;
  content?: unknown;
}

export interface ReviewState {
  exists: boolean;
  state: SelfState | null;
  subtree?: { module_id: string; state: SelfState }[];
  complete: boolean;
  dependencies: DependencyInput[];
  dependency_coverage: DependencyCoverage;
}

export interface ReviewInputs {
  schema_version: number;
  scope: string;
  contract_scope?: string;
  current: ReviewState;
  baseline: ReviewState | null;
  baseline_identity: { kind: string; id: string } | null;
  current_digest?: string;
  change_digest?: string;
}

export interface ReviewOptions {
  scope?: string;
  contractScope?: string;
  dependencies?: DependencySelector[];
  dependencyCoverage?: DependencyCoverage;
  dependency_coverage?: DependencyCoverage;
  projectId?: string;
  project_id?: string;
  reviewId?: string;
}

export interface ReviewEntry extends Omit<
  ReviewBundle,
  "baseline" | "current"
> {
  baseline: SnapshotData | null;
  current: SnapshotData;
  schema_version: number;
  kind: string;
  module_id: string;
  review_id: string;
  project_id: string | null;
  check_hash: string;
  check_manifest?: TechnicalReport["input_manifest"];
  analysis_kind: string;
  format: string;
  inputs: ReviewInputs;
  input_digest?: string;
  result_digest?: string;
  content_digest?: string;
  registration_order?: number;
  resolution?: { review_ids: string[]; reason?: string };
}

export type ReviewInput = ReviewEntry;

export interface TechnicalReport {
  schema_version: number;
  kind: "archi";
  module_id: string;
  project_id: string;
  check_hash: string;
  input_manifest: {
    domain: string;
    project_id: string;
    module_id: string;
    baseline: {
      identity: { kind: string; id: string } | null;
      state: StateReference;
    } | null;
    current: StateReference;
    analyzer: Analyzer;
  };
  baseline: ModuleState | null;
  current: ModuleState | null;
  change: {
    existence: string;
    own: boolean;
    own_code: boolean;
    own_contract: boolean;
    inherited_constraints: boolean;
    descendants: boolean;
    child_composition: boolean;
    moved: boolean;
  };
  structure: {
    complete: boolean;
    diagnostics: string[];
    document_state: string;
  };
  publication?: {
    generation: number;
    comparison_key: string;
    baseline: SnapshotFragment | null;
    current: SnapshotFragment | null;
  };
  review_status?: TreeReviewStatus;
  storage_diagnostics?: string[];
}

export interface SnapshotFragment {
  metadata: Omit<Snapshot, "modules" | "facts">;
  module_index: number;
  module: SnapshotModule;
  facts: { index: number; fact: Fact }[];
}

export interface PublishedComparison {
  baseline: Snapshot | null;
  current: Snapshot;
}

export interface ReviewHistory {
  schema_version: number;
  kind: "review_history";
  module_id: string;
  entries: ReviewEntry[];
}

export interface Freshness {
  status: string;
  reasons: FreshnessReason[];
  coverage: Coverage;
  dependency_coverage?: DependencyCoverage;
  input_changed?: boolean;
}

export interface ReviewFreshness {
  current: Freshness;
  change: Freshness;
}

export interface AggregateAssessment {
  status: string;
  reasons?: FreshnessReason[];
  verdict?: string | null;
  verdicts?: string[];
  review_ids?: string[];
  conflict: boolean;
  coverage: Coverage;
  current_violation: boolean;
  counts?: Record<string, number>;
}

export interface ReviewStatus {
  current: AggregateAssessment;
  change: AggregateAssessment;
  conflict: boolean;
  coverage: { current: Coverage; change: Coverage };
}

export interface TreeReviewStatus {
  self: ReviewStatus;
  subtree: Record<AssessmentSide, AggregateAssessment>;
  explicit_subtree: Record<AssessmentSide, AggregateAssessment>;
}

export interface StateReference {
  exists: boolean;
  directory?: string;
  self_digest?: string;
  subtree_digest?: string;
}
