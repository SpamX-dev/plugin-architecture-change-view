import path from "node:path";
import { lstat } from "node:fs/promises";
import { git, gitFileHashes, readGitHeadRevision } from "./capture.js";
import { snapshotModules } from "./module-layout.js";
import { excludedProjectPath, regularProjectFile } from "../contracts/source-files.js";
import { MODULE_TREE_FILE, isModuleContractPath, readContractStorageFile, decodeContractText, MAX_DOCUMENT_BYTES, MAX_TREE_BYTES } from "../contracts/module-tree.js";
import { repositoryDirectoryOwnership } from "../project/workspace.js";
import { digest } from "../serialization/digest.js";
import { snapshotDigest } from "./identity.js";
import type { Snapshot, FileRecord } from "./types.js";

const contract = (file: string) => file === MODULE_TREE_FILE || isModuleContractPath(file);
const included = (file: string) => !excludedProjectPath(file) || contract(file);
const regular = (mode: string) => mode === "100644" || mode === "100755";
const fields = (bytes: Buffer) => bytes.toString().split("\0").filter(Boolean);

async function commitRecords(root: string, revision: string) {
  const records = new Map<string, FileRecord>();
  const diagnostics: string[] = [];
  const contracts: FileRecord[] = [];
  for (const row of fields(await git(root, ["ls-tree", "-rz", revision, "--", "."]))) {
    const tab = row.indexOf("\t");
    const file = row.slice(tab + 1);
    if (!included(file)) continue;
    const [mode, , hash] = row.slice(0, tab).trim().split(/\s+/);
    if (!regular(mode)) {
      if (contract(file)) diagnostics.push("Expected regular contract storage: " + file);
      continue;
    }
    const record: FileRecord = { path: file, hash, ...(mode === "100755" ? { mode } : {}) };
    records.set(file, record);
    if (contract(file)) contracts.push(record);
  }
  for (let start = 0; start < contracts.length; start += 64) {
    const group = contracts.slice(start, start + 64);
    const sizes = (await git(root, ["cat-file", "--batch-check=%(objectsize)"],
      group.map(record => record.hash).join("\n") + "\n")).toString().trim().split("\n");
    const batch = group.filter((record, i) => {
      const limit = record.path === MODULE_TREE_FILE ? MAX_TREE_BYTES : MAX_DOCUMENT_BYTES;
      if (Number(sizes[i]) <= limit) return true;
      record.error = "Contract exceeds the size limit";
      diagnostics.push(record.path + ": " + record.error);
      return false;
    });
    if (!batch.length) continue;
    const blobs = await git(root, ["cat-file", "--batch"], batch.map(record => record.hash).join("\n") + "\n");
    let offset = 0;
    for (const record of batch) {
      const newline = blobs.indexOf(10, offset);
      const [hash, type, size] = blobs.toString("ascii", offset, newline).split(" ");
      const end = newline + 1 + Number(size);
      if (hash !== record.hash || type !== "blob" || blobs[end] !== 10) throw new Error("Incomplete Git contract: " + record.path);
      try { record.text = decodeContractText(blobs.subarray(newline + 1, end), record.path).replace(/\r\n?/g, "\n"); }
      catch (cause) { record.error = String(cause); diagnostics.push(record.path + ": " + record.error); }
      offset = end + 1;
    }
  }
  return { records, diagnostics };
}

async function snapshot(root: string, origin: string, records: Map<string, FileRecord>, diagnostics: string[], revision?: string): Promise<Snapshot> {
  const modules = await snapshotModules([...records.values()], diagnostics,
    revision ? undefined : {root, ownsDirectory: repositoryDirectoryOwnership(root)});
  const value: Snapshot = { schema_version: 2, id: "", digest: "", root: origin, modules, facts: [], evidenceLimitations: [],
    capturedAt: new Date().toISOString(), fingerprint: digest(modules), diagnostics, complete: !diagnostics.length,
    kind: revision ? "git" : "working", label: revision ? "Revision " + revision.slice(0, 7) : "Рабочее дерево", revision };
  value.digest = snapshotDigest(value);
  value.id = revision ? "git-" + revision : "working-" + value.digest.slice(7);
  return value;
}

/** Immutable Git objects supply unchanged file identities. Only contract blobs need decoding for the tree. */
export class GitTreeReader {
  private readonly commits = new Map<string, Awaited<ReturnType<typeof commitRecords>> & { snapshot?: Snapshot }>();
  constructor(private readonly root: string, private readonly origin: string) {}

  private async commit(revision: string) {
    let value = this.commits.get(revision);
    if (!value) {
      value = await commitRecords(this.root, revision);
      if (this.commits.size >= 4) this.commits.delete(this.commits.keys().next().value!);
      this.commits.set(revision, value);
    }
    return value;
  }

  async revision(revision: string) {
    const value = await this.commit(revision);
    return value.snapshot ??= await snapshot(this.root, this.origin, value.records, [...value.diagnostics], revision);
  }

  async working(head: string | null) {
    const root = this.root;
    const base = head ? await this.commit(head) : null;
    const records = new Map(base?.records);
    const diagnostics: string[] = [];
    // Explicit object name pins the baseline through an index/branch switch.
    const [tracked, extra, staged] = await Promise.all([
      head ? git(root, ["diff", "--raw", "-z", "--relative", "--no-renames", "--no-ext-diff", head, "--", "."]) : Promise.resolve(Buffer.alloc(0)),
      git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--", "."]),
      git(root, ["ls-files", "-z", "--stage", ...(head ? ["--unmerged"] : []), "--", "."]),
    ]);
    const changes = new Map<string, string>();
    const conflicts = new Set<string>();
    for (const row of fields(staged)) {
      const tab = row.indexOf("\t");
      const [mode, , stage] = row.slice(0, tab).split(" ");
      const file = row.slice(tab + 1);
      if (!included(file)) continue;
      if (stage !== "0") conflicts.add(file);
      else if (!head) changes.set(file, mode);
    }
    const raw = fields(tracked);
    for (let i = 0; i < raw.length; i += 2) {
      const [, mode, , , status] = raw[i].split(" ");
      if (status === "U" && included(raw[i + 1])) conflicts.add(raw[i + 1]);
      if (included(raw[i + 1])) changes.set(raw[i + 1], mode);
    }
    for (const file of conflicts) diagnostics.push("Unmerged file: " + file);
    for (const file of fields(extra)) if (included(file) && !file.endsWith("/")) changes.set(file, "");
    for (const record of records.values()) {
      if (record.error && !changes.has(record.path)) diagnostics.push(record.path + ": " + record.error);
    }
    const owns = repositoryDirectoryOwnership(root);
    // A directory tracked in HEAD may now belong to a separate nested checkout.
    const directories = new Set([...records.keys()].filter(file => !contract(file)).map(file => path.posix.dirname(file)));
    const foreign = new Set<string>();
    await Promise.all([...directories].map(async directory => { if (!await owns(directory)) foreign.add(directory); }));
    if (foreign.size) for (const file of records.keys()) {
      if (foreign.has(path.posix.dirname(file))) records.delete(file);
    }
    const candidates: { file: string; executable: boolean; text?: string }[] = [];
    for (const [file, mode] of changes) {
      records.delete(file);
      if (mode && !regular(mode)) continue;
      let text: string | undefined;
      if (contract(file)) {
        try {
          const stored = await readContractStorageFile(root, file);
          if (stored === null) continue;
          text = stored.replace(/\r\n?/g, "\n");
        } catch (cause) {
          diagnostics.push(file + ": " + String(cause));
          continue;
        }
      } else if (!await owns(path.posix.dirname(file)) || !await regularProjectFile(root, file)) continue;
      const executable = mode ? mode === "100755" :
        process.platform !== "win32" && Boolean((await lstat(path.join(root, file))).mode & 0o111);
      candidates.push({ file, executable, text });
    }
    if (candidates.length) {
      const hashes = await gitFileHashes(root, candidates.map(candidate => candidate.file));
      candidates.forEach(({file, executable, text}, i) => {
        records.set(file, { path: file, hash: hashes[i], text, ...(executable ? { mode: "100755" } : {}) });
      });
    }
    if (await readGitHeadRevision(root) !== head) throw new Error("HEAD изменился, обновите дерево");
    return snapshot(root, this.origin, records, diagnostics);
  }
}
