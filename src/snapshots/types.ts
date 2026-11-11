import type { ContractDocument } from "../contracts/types.js";

export interface SourceFile {
  path: string;
  hash: string | null;
  error?: string;
}

export interface FileRecord extends SourceFile {
  text?: string;
}

export interface Fact {
  id: string;
  kind: string;
  path: string;
  text: string;
  start_line?: number;
  end_line?: number;
}

export interface SnapshotModule {
  directory: string;
  documentPath: string;
  document: ContractDocument;
  files: SourceFile[];
  sourceFiles: number;
  fingerprint: string;
}

export interface Snapshot {
  schema_version: number;
  root: string;
  id: string;
  digest: string;
  capturedAt: string;
  fingerprint: string;
  kind: string;
  label: string;
  revision?: string;
  baseRevision?: string | null;
  subject?: string;
  isHead?: boolean;
  complete: boolean;
  diagnostics: string[];
  modules: SnapshotModule[];
  facts: Fact[];
  evidenceLimitations: string[];
  scoped?: boolean;
  scope_digest?: string;
}

export interface SnapshotOptions {
  maxFiles?: number;
  snapshotRoot?: string;
  revision?: string;
}

export type ChangeStatus = "initial" | "new" | "changed" | "removed" | "unchanged";

export interface FileChange {
  path: string;
  status: ChangeStatus;
}

export interface ComparisonModule {
  directory: string;
  key: string;
  sourceFiles: number;
  filesChanged: number;
  descendantChanges: number;
  name: string;
  moduleId?: string | null;
  module_id?: string;
  title?: string;
  baselinePath: string | null;
  currentPath: string | null;
  moved: boolean;
  status: ChangeStatus;
  documentState: string;
  documentChanged: boolean;
  files: FileChange[];
  before: SnapshotModule | null;
  after: SnapshotModule | null;
}

export interface Comparison {
  before: {
    id: string;
    label: string;
    kind: string;
    digest?: string;
    capturedAt?: string;
  };
  after: { id: string; digest: string; capturedAt: string };
  counts: Record<string, number>;
  schema_version: number;
  id: string;
  root: string;
  complete: boolean;
  diagnostics: string[];
  modules: ComparisonModule[];
}

export interface SnapshotReference {
  id: string;
  digest: string;
}

export type ScopedSnapshot = Pick<
  Snapshot,
  | "schema_version"
  | "id"
  | "digest"
  | "kind"
  | "revision"
  | "complete"
  | "modules"
  | "facts"
  | "diagnostics"
  | "evidenceLimitations"
> & { scoped: boolean; scope_digest?: string };

export type SnapshotData = Snapshot | ScopedSnapshot;

export interface GitRevision {
  id: string;
  revision: string;
  parentRevision: string | null;
  isHead: boolean;
  kind: string;
  capturedAt: string;
  date: string;
  subject: string;
  label: string;
}
