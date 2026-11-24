/** Location metadata of one checked-out repository, relative to its selected workspace. */
export interface WorkspaceProject {
  repository: string;
  hasModuleMap: boolean;
}

/** On-disk origin of historical snapshots. The active checkout may have moved. */
export interface ProjectIdentity {
  schema_version: 1;
  snapshot_root: string;
}

export interface ProjectSourceLocation {
  workspaceRoot: string;
  root: string;
  repository: string;
  directory: string;
  existingDirectory: string;
  plannedPath?: string;
}
