import type { ProjectIdentity } from "../project-types/types.js";

export function isProjectIdentity(value: unknown): value is ProjectIdentity {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.schema_version === 1 && typeof record.snapshot_root === "string" &&
    record.snapshot_root.length > 0 && !record.snapshot_root.includes("\0") &&
    Object.keys(record).every(key => key === "schema_version" || key === "snapshot_root");
}
