import type { Snapshot } from "../../framework/snapshots/types.js";
import type { ReviewEntry } from "../../framework/static-report/types.js";
import type { GitTreeReader } from "../git-changes/git-tree.js";
import { analysisFingerprint, analysisModules } from "./analysis-scope.js";

/** Equal content on two endpoints also needs an uninterrupted path along the selected timeline. */
export async function followsAnalysis(entry: ReviewEntry, target: Snapshot, reader?: GitTreeReader) {
  const origin = entry.manifest.source_snapshot;
  if (!target.revision && target.kind !== "working" && entry.manifest.source_captured_at &&
      target.capturedAt < entry.manifest.source_captured_at) return false;

  const from = entry.current.revision ?? entry.manifest.source_head;
  const to = target.revision ?? target.baseRevision;
  if (origin?.id === target.id && origin.digest === target.digest && from === to) return true;
  if (entry.current.revision && target.revision === entry.current.revision) return true;
  if (target.revision && !entry.current.revision && to === from) return false;
  if (from === undefined || to === undefined) return !target.revision && !entry.current.revision;
  if (to === from) return true;
  if (!to || !reader) return false;
  const history = await reader.firstParentHistory(to);
  const start = from === null ? history.length : history.indexOf(from);
  if (start < 0) return false;
  const type = entry.manifest.analysis_type!;
  const own = entry.current.modules.find(module => module.document.contract?.id === entry.module_id)!;
  const expected = analysisFingerprint(type, analysisModules(type, entry.current, own));
  for (const revision of history.slice(0, start)) {
    const snapshot = await reader.revision(revision);
    const module = snapshot.modules.find(item => item.document.contract?.id === entry.module_id);
    if (!snapshot.complete || !module || analysisFingerprint(type, analysisModules(type, snapshot, module)) !== expected) return false;
  }
  return true;
}
