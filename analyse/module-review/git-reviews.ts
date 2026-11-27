import { git } from "../git-changes/capture.js";
import { constants } from "node:buffer";
import { isProjectIdentity } from "../../framework/project/identity.js";
import { parseReportYaml } from "../../framework/serialization/yaml.js";
import { digest } from "../../framework/serialization/digest.js";
import type { ReviewEntry } from "../../framework/static-report/types.js";
import { parseFindingDecisions } from "./dispositions.js";
import { moduleReportName, validateHistoryFile, validatePublishedReviewSet } from "./report-store.js";

const work = ".archiview/work/";
const project = ".archiview/project.json";
const decisionDirectory = ".archiview/decisions/";
type Blob = { mode: string; type: string; hash: string };

/** Share in-flight loads across views and retain a bounded number of immutable objects per session. */
function cached<T>(cache: Map<string, Promise<T>>, key: string, limit: number, load: () => Promise<T>) {
  const existing = cache.get(key);
  if (existing) {
    cache.delete(key);
    cache.set(key, existing);
    return existing;
  }
  const value = load();
  cache.set(key, value);
  if (cache.size > limit) cache.delete(cache.keys().next().value!);
  value.catch(() => { if (cache.get(key) === value) cache.delete(key); });
  return value;
}

export class GitReviewArchive {
  private readonly trees = new Map<string, Promise<Map<string, Blob>>>();
  private readonly origins = new Map<string, Promise<string>>();
  private readonly modules = new Map<string, Promise<ReviewEntry[]>>();
  private readonly decisions = new Map<string, Promise<ReturnType<typeof parseFindingDecisions>>>();

  constructor(private readonly root: string) {}

  private files(revision: string) {
    return cached(this.trees, revision, 8, async () => {
      const listing = await git(this.root, ["ls-tree", "-rz", revision, "--", project, work, decisionDirectory]);
      const files = new Map<string, Blob>();
      for (const row of listing.toString().split("\0")) {
        if (!row) continue;
        const tab = row.indexOf("\t");
        const file = row.slice(tab + 1);
        if (file !== project && !/^\.archiview\/(?:work\/[^/]+\.analysis\.yaml|decisions\/[a-f0-9]{64}\.json)$/.test(file)) continue;
        const [mode, type, hash] = row.slice(0, tab).split(/\s+/);
        files.set(file, {mode, type, hash});
      }
      return files;
    });
  }

  private async text(blob: Blob, maxBytes = constants.MAX_LENGTH) {
    if (!["100644", "100755"].includes(blob.mode) || blob.type !== "blob")
      throw new Error("Expected an ordinary Git archive file");
    return (await git(this.root, ["cat-file", "blob", blob.hash], "", maxBytes)).toString("utf8");
  }

  private origin(files: Map<string, Blob>) {
    const identity = files.get(project);
    if (!identity) return this.root;
    return cached(this.origins, identity.mode + "/" + identity.hash, 8, async () => {
      const value: unknown = JSON.parse(await this.text(identity, 16 * 1024));
      if (!isProjectIdentity(value)) throw new Error("Invalid ArchiView project identity");
      return value.snapshot_root;
    });
  }

  async reviews(revision: string, moduleId?: string): Promise<ReviewEntry[]> {
    const files = await this.files(revision);
    const names = moduleId === undefined ? [...files.keys()].filter(file => file.startsWith(work)) :
      [work + moduleReportName(moduleId) + ".analysis.yaml"];
    const entries: ReviewEntry[] = [];
    for (const file of names) {
      const blob = files.get(file);
      if (!blob) continue;
      const name = file.slice(work.length);
      const identity = files.get(project);
      const key = [identity?.mode, identity?.hash, name, blob.mode, blob.hash].join("\0");
      const moduleEntries = await cached(this.modules, key, 128, async () => {
        const data = parseReportYaml(await this.text(blob));
        return validateHistoryFile(data, name, await this.origin(files));
      });
      entries.push(...moduleEntries);
    }
    if (moduleId === undefined) validatePublishedReviewSet(entries);
    return entries.sort((a,b) => (b.registration_order ?? 0) - (a.registration_order ?? 0));
  }

  async findingDecisions(revision: string, reviewId: string) {
    const files = await this.files(revision);
    const blob = files.get(decisionDirectory + digest(reviewId).slice(7) + ".json");
    if (!blob) return Object.create(null) as ReturnType<typeof parseFindingDecisions>;
    const states = await cached(this.decisions, blob.mode + "/" + blob.hash, 128, async () => parseFindingDecisions(await this.text(blob)));
    return Object.assign(Object.create(null), structuredClone(states)) as typeof states;
  }
}
