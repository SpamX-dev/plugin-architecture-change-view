import type { Snapshot } from "../../framework/snapshots/types.js";
import type { ReviewEntry } from "../../framework/static-report/types.js";
import type { GitTreeReader } from "../git-changes/git-tree.js";
import { analysisTypes, normalizeAnalysisType, type AnalysisType } from "../../framework/ai-report/types.js";
import { analysisFingerprint, analysisModules, projectAnalysisScopes } from "./analysis-scope.js";

/** For each analysis, keep only its tip fingerprint and the length of its uninterrupted run. */
class RevisionPrefix {
  private readonly modules = new Map<string, Record<AnalysisType, { hash: string; length: number }>>();
  private length = 0;
  private loading?: Promise<void>;

  constructor(private reader: GitTreeReader, private revisions: string[]) {}

  private async advance() {
    const snapshot = await this.reader.revision(this.revisions[this.length]);
    if (snapshot.complete) {
      for (const {module, hashes} of projectAnalysisScopes(snapshot)) {
        const id = module.document.contract?.id;
        if (!id) continue;
        if (this.length === 0) {
          this.modules.set(id, { composition: {hash: hashes.composition, length: 1},
            implementation: {hash: hashes.implementation, length: 1} });
        } else {
          const previous = this.modules.get(id);
          if (!previous) continue;
          for (const type of analysisTypes) {
            const run = previous[type];
            if (run.length === this.length && run.hash === hashes[type]) run.length++;
          }
        }
      }
    }
    this.length++;
  }

  async matches(distance: number, id: string, type: AnalysisType, expected: string) {
    while (this.length < distance) {
      const run = this.modules.get(id)?.[type];
      if (this.length && (!run || run.hash !== expected || run.length < this.length)) return false;
      this.loading ??= this.advance().finally(() => { this.loading = undefined; });
      await this.loading;
    }
    const run = this.modules.get(id)?.[type];
    return run?.hash === expected && run.length >= distance;
  }
}

/** The reader owns a bounded set of immutable first-parent histories per repository. */
export class AnalysisHistory {
  private readonly prefixes = new WeakMap<string[], RevisionPrefix>();
  constructor(private reader: GitTreeReader) {}

  async matches(entry: ReviewEntry, from: string | null, to: string) {
    const revisions = await this.reader.firstParentHistory(to);
    const distance = from === null ? revisions.length : revisions.indexOf(from);
    if (distance < 0) return false;
    const type = normalizeAnalysisType(entry.manifest.analysis_type);
    if (!type) return false;
    const own = entry.current.modules.find(module => module.document.contract?.id === entry.module_id)!;
    const expected = analysisFingerprint(type, analysisModules(type, entry.current, own));
    let prefix = this.prefixes.get(revisions);
    if (!prefix) {
      prefix = new RevisionPrefix(this.reader, revisions);
      this.prefixes.set(revisions, prefix);
    }
    return prefix.matches(distance, entry.module_id, type, expected);
  }
}

/** Equal content on two endpoints also needs an uninterrupted path along the selected timeline. */
export async function followsAnalysis(entry: ReviewEntry, target: Snapshot, history?: AnalysisHistory) {
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
  if (!to || !history) return false;
  return history.matches(entry, from, to);
}
