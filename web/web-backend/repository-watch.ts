import { randomUUID } from "node:crypto";
import path from "node:path";
import { git } from "../../analyse/git-changes/capture.js";
import { isProjectMetadataPath, within } from "../../framework/project/paths.js";
import { watchFileChanges } from "./file-watcher/events.js";

const waitMs = 15000;
const idleMs = 60000;

/** A cursor identifies the native watch instance as well as changes since the last Git read. */
export class RepositoryWatch {
  private subscription?: ReturnType<typeof watchFileChanges>;
  private opening?: Promise<void>;
  private epoch = "";
  private revision = 0;
  private reviews = 0;
  private pending = new Set<string>();
  private dirty = false;
  private reviewDirty = false;
  private timer?: NodeJS.Timeout;
  private idle?: NodeJS.Timeout;
  private waiters = new Set<() => void>();
  private closed = false;

  constructor(private root: string, private storage: string) {}

  private get cursor() { return [this.epoch, this.revision, this.reviews].join("."); }

  async current() {
    if (this.closed) throw new Error("Наблюдение за репозиторием завершено");
    if (!this.opening) {
      this.opening = this.start().catch(error => { this.stop(); throw error; });
    }
    await this.opening;
    if (!this.epoch) throw new Error("Прервано наблюдение за рабочим деревом Git");
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(), idleMs).unref();
    return this.cursor;
  }

  async wait(cursor: string, signal?: AbortSignal) {
    await this.current();
    if (cursor === this.cursor && !signal?.aborted) {
      await new Promise<void>(resolve => {
        const done = () => {
          clearTimeout(timeout);
          this.waiters.delete(done);
          signal?.removeEventListener("abort", done);
          resolve();
        };
        const timeout = setTimeout(done, waitMs).unref();
        this.waiters.add(done);
        signal?.addEventListener("abort", done, { once: true });
      });
    }
    if (!this.epoch) throw new Error("Прервано наблюдение за рабочим деревом Git");
    const [epoch, , reviews] = cursor.split(".");
    return { cursor: this.cursor, reviewsChanged: epoch !== this.epoch || reviews !== String(this.reviews) };
  }

  private async start() {
    const info = await git(this.root, ["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir"]);
    const [gitDir, commonDir] = info.toString().trimEnd().split(/\r?\n/).map(dir => path.resolve(dir));
    const roots = [this.root, gitDir, commonDir, this.storage];
    const epoch = randomUUID();
    if (this.closed) throw new Error("Сессия закрыта");
    this.epoch = epoch;
    this.subscription = watchFileChanges(roots, ({ type: event, file }) => {
      if (epoch !== this.epoch) return;
      if (!file) { this.dirty = true; this.reviewDirty = true; }
      else {
        const rel = (base: string) => path.relative(base, file).split(path.sep).join("/");
        // Windows also reports timestamp changes on these containing directories.
        // Their child events carry the actual ref, contract or review filename.
        if (event === "change" && (rel(commonDir) === "refs/heads" || rel(commonDir) === "reftable" ||
            ["work", "decisions"].includes(rel(this.storage)) || rel(this.root) === ".archiview/modules")) return;
        if (within(gitDir, file) || within(commonDir, file)) {
          if (!["HEAD", "index", "commondir"].includes(rel(gitDir)) &&
              !/^(?:packed-refs|refs\/heads(?:\/.*)?|info\/(?:exclude|attributes)|config|reftable(?:\/.*)?)$/.test(rel(commonDir))) return;
          if (file.endsWith(".lock")) return;
          this.dirty = true;
        } else if (within(this.storage, file) && /^(?:work|work\/[^/]+\.review\.yaml|decisions|decisions\/[a-f0-9]{64}\.json)$/.test(rel(this.storage))) {
          this.reviewDirty = true;
        } else if (within(this.root, file)) {
          const source = rel(this.root);
          if (/^\.archiview\/(?:modules\.tree|modules(?:\/[^/]+\.yaml)?)$/.test(source)) this.dirty = true;
          else if (isProjectMetadataPath(source)) return;
          else this.pending.add(source);
        } else return;
      }
      // A bounded window coalesces editor temp files without starving a continuously edited repository.
      this.timer ??= setTimeout(() => { this.timer = undefined; void this.flush(epoch); }, 75).unref();
    }, () => { if (epoch === this.epoch) this.stop(); });
  }

  private async flush(epoch: string) {
    const files = [...this.pending];
    const dirty = this.dirty, reviews = this.reviewDirty;
    this.pending.clear();
    this.dirty = this.reviewDirty = false;
    if (!dirty && !reviews && files.length) {
      // Git's ignore rules apply to untracked paths; tracked files matching a rule still matter.
      try {
        const ignored = await git(this.root, ["check-ignore", "--stdin", "-z"], files.join("\0") + "\0");
        if (ignored.toString().split("\0").filter(Boolean).length === files.length) return;
      } catch { /* No ignored paths or a transient Git error: reconcile against the diff. */ }
    }
    if (epoch !== this.epoch) return;
    this.revision++;
    if (reviews) this.reviews++;
    for (const done of this.waiters) done();
  }

  private stop() {
    this.epoch = "";
    this.opening = undefined;
    clearTimeout(this.timer);
    clearTimeout(this.idle);
    this.timer = undefined;
    this.pending.clear();
    this.dirty = this.reviewDirty = false;
    this.subscription?.close();
    this.subscription = undefined;
    for (const done of this.waiters) done();
  }

  close() { this.closed = true; this.stop(); }
}
