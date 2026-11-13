/** Сбор файлов, контрактов и доказательств из рабочего дерева, коммита или индекса Git. */
import { snapshotDigest, structureHash } from "./identity.js";
import type {
  FileRecord, Fact, Snapshot, SnapshotOptions, GitRevision,
} from "./types.js";
import { errorDetails } from "../runtime/errors.js";
import { spawn } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { excludedProjectPath, projectFiles, regularProjectFile } from "../contracts/source-files.js";
import { decodeContractText, MAX_DOCUMENT_BYTES, MAX_TREE_BYTES, MODULE_DIRECTORY, MODULE_TREE_FILE, readContractStorageFile } from "../contracts/module-tree.js";
import { isSource, snapshotModules, type WorkingLayout } from "./module-layout.js";
import { repositoryDirectoryOwnership } from "../project/workspace.js";
import { digest as contentDigest } from "../serialization/digest.js";
import { readSnapshotRoot } from "../project/identity.js";

function isContractStorage(file: string) {
  return file === MODULE_TREE_FILE || path.posix.dirname(file) === MODULE_DIRECTORY && file.endsWith(".yaml");
}

/** Относительные пути снимков используют единые разделители на всех платформах. */
function portable(value: string) {
  return value.split(path.sep).join("/");
}

/** Запускает только Git без оболочки, ограничивая время и объём ответа. */
export async function git(root: string, args: string[], input: string | Buffer = "", maxBytes = 16 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: root, windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let diagnostic = "";
    let failure: (Error & {exitCode?: number | null}) | undefined;
    const timer = setTimeout(() => {
      failure = new Error("Git operation timed out");
      child.kill();
    }, 30000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        failure = new Error("Git response exceeds the size limit");
        child.kill();
      } else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      diagnostic = (diagnostic + chunk.toString()).slice(-4096);
    });
    child.stdin.on("error", () => {});
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failure || code !== 0) {
        const error: Error & {exitCode?: number | null} = failure ?? new Error(diagnostic.trim() || "Git exited with code " + code);
        error.exitCode = code;
        reject(error);
      }
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
}

/** Git expects C-quoted paths, separated by newlines, for --stdin-paths. */
export async function gitFileHashes(root: string, paths: string[]) {
  const quoted = paths.map(name => '"' + [...Buffer.from(name)].map(byte =>
    byte < 32 || byte > 126 || byte === 34 || byte === 92
      ? "\\" + byte.toString(8).padStart(3, "0") : String.fromCharCode(byte)).join("") + '"');
  const hashes = (await git(root, ["hash-object", "--stdin-paths"], quoted.join("\n") + "\n")).toString().trim().split("\n");
  if (hashes.length !== paths.length) throw new Error("Incomplete Git file hashes");
  return hashes;
}

/** Определяет физический корень рабочего дерева Git. */
async function gitInfo(root: string) {
  let repository;
  try {
    repository = (await git(root, ["rev-parse", "--show-toplevel"])).toString().trim();
  } catch (errorCause) { const error = errorDetails(errorCause);
    if (error.code === "ENOENT" || error.message.includes("not a git repository")) return null;
    throw error;
  }
  return { repository: await realpath(repository) };
}

/** Hash the same bytes used as evidence, applying this path's Git filters. */
async function capturedText(root: string, file: string, bytes: Buffer, decoded: string): Promise<FileRecord> {
  const hash = (await git(root, ["hash-object", "--stdin", "--path", file], bytes)).toString().trim();
  return { path: file, hash, text: decoded.replace(/\r\n?/g, "\n") };
}

/**
 * Строит модули по каталогам исходников и контрактов, включая предков.
 * Вспомогательные файлы принадлежат ближайшему модулю; они тоже влияют на статус.
 */
async function assemble(root: string, records: FileRecord[], metadata: {kind:string;label:string;revision?:string}, diagnostics: string[], working?: WorkingLayout): Promise<Snapshot> {
  const data = await snapshotModules(records, diagnostics, working);
  const facts: Fact[] = [];
  const evidenceLimitations = [];
  let remaining = 16 * 1024 * 1024;
  for (const record of records) {
    // The map determines the directory of each module and has no module owner of its own.
    if (record.path === MODULE_TREE_FILE) continue;
    if (record.text === undefined || Buffer.byteLength(record.text) > remaining) {
      evidenceLimitations.push(record.path + ": текст недоступен или превышен лимит доказательств");
      continue;
    }
    remaining -= Buffer.byteLength(record.text);
    const fact = { kind: "file", path: record.path, start_line: 1,
      end_line: record.text.split("\n").length, text: record.text };
    facts.push({ id: contentDigest(fact), ...fact });
  }
  for (const module of data) {
    const fact = { kind: "module", path: module.directory, text: JSON.stringify({
      contract: module.document.state, format: module.document.format,
      sources: module.files.filter((f) => isSource(f.path)).map((f) => f.path) }) };
    facts.push({ id: contentDigest(fact), ...fact });
  }
  const fingerprint = structureHash(JSON.stringify({ root, modules: data }));
  const snapshot = { id: "", digest: "", schema_version: 2, root, capturedAt: new Date().toISOString(),
    ...metadata, fingerprint, complete: diagnostics.length === 0,
    diagnostics, modules: data, facts, evidenceLimitations };
  snapshot.digest = snapshotDigest(snapshot);
  return snapshot;
}

/**
 * Снимает рабочее дерево. В Git отпечатки учитывают атрибуты и нормализацию
 * строк через hash-object, чтобы CRLF не выглядел как изменение всего проекта.
 */
export async function captureWorkingTree(projectRoot: string, options: SnapshotOptions = {}) {
  const root = await realpath(projectRoot);
  const info = await gitInfo(root);
  if (!info) throw new Error("Для ArchiView требуется рабочее дерево Git");
  const working = { root, ownsDirectory: repositoryDirectoryOwnership(root) };
  const listed = await projectFiles(root, options.maxFiles ?? 50000, working.ownsDirectory);
  const diagnostics = [...listed.diagnostics];
  const files = [];
  for (const file of listed.files) {
    try {
      if (await regularProjectFile(root, file)) files.push(portable(file));
    } catch (errorCause) { const error = errorDetails(errorCause); diagnostics.push(file + ": " + error.message); }
  }
  // Capture only the registry and contract documents from the reserved metadata directory.
  // They belong to the source project even when report storage is configured elsewhere.
  const maxFiles = options.maxFiles ?? 50000;
  const contractPaths = (await git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--",
    MODULE_TREE_FILE, MODULE_DIRECTORY])).toString().split("\0");
  const contracts = [...new Set(contractPaths)].filter(isContractStorage);
  const room = Math.max(0, maxFiles - files.length);
  const documents = contracts.filter(file => file !== MODULE_TREE_FILE);
  if (documents.length > room) diagnostics.push("File limit reached: " + maxFiles);
  if (contracts.includes(MODULE_TREE_FILE)) files.push(MODULE_TREE_FILE);
  files.push(...documents.slice(0, room));
  files.sort();
  const records: FileRecord[] = [];
  const hashOnly: FileRecord[] = [];
  let evidenceBudget = 16 * 1024 * 1024;
  for (let offset = 0; offset < files.length; offset += 16) {
    const batch = await Promise.all(files.slice(offset, offset + 16).map(async (file): Promise<FileRecord | null> => {
      try {
        if (isContractStorage(file)) {
          const text = await readContractStorageFile(root, file);
          if (text === null) return null;
          const bytes = Buffer.from(text);
          if (file !== MODULE_TREE_FILE) {
            if (bytes.length > evidenceBudget) throw new Error("Contract evidence budget exceeded");
            evidenceBudget -= bytes.length;
          }
          return await capturedText(root, file, bytes, text);
        }
        const fullPath = path.join(root, file);
        const size = (await lstat(fullPath)).size;
        if (size <= 256 * 1024 && size <= evidenceBudget) {
          evidenceBudget -= size;
          const bytes = await readFile(fullPath);
          if (bytes.length !== size) throw new Error("File changed while being captured");
          const decoded = bytes.toString("utf8");
          if (!bytes.includes(0) && Buffer.from(decoded).equals(bytes)) {
            return await capturedText(root, file, bytes, decoded);
          }
        }
        const record = { path: file, hash: null };
        hashOnly.push(record);
        return record;
      } catch (errorCause) { const error = errorDetails(errorCause);
        diagnostics.push(file + ": " + error.message);
        return { path: file, hash: null, error: error.message };
      }
    }));
    records.push(...batch.filter((record) => record !== null));
  }
  if (hashOnly.length) {
    const hashes = await gitFileHashes(root, hashOnly.map(record => record.path));
    hashOnly.forEach((record, i) => { record.hash = hashes[i]; });
  }
  const snapshotRoot = options.snapshotRoot ?? await readSnapshotRoot(root) ?? root;
  const snapshot = await assemble(snapshotRoot, records, { kind: "working", label: "Рабочее дерево" },
    diagnostics, working);
  snapshot.id = "working-" + snapshot.digest.slice(7);
  return snapshot;
}

/** Читает только идентичность HEAD; повторная проверка не загружает исходники коммита. */
export async function readGitHeadRevision(projectRoot: string) {
  try { return (await git(projectRoot, ["rev-parse", "--verify", "--quiet", "HEAD"])).toString().trim(); }
  catch (errorCause) { const error = errorDetails(errorCause);
    if (error.code === "ENOENT" || error.exitCode === 1 || error.message.includes("not a git repository")) return null;
    throw error;
  }
}

/** Читает структуру HEAD и документы из Git, сохраняя удалённые рабочие файлы. */
export async function captureGitHead(projectRoot: string, options: SnapshotOptions = {}) {
  const root = await realpath(projectRoot);
  const info = await gitInfo(root);
  if (!info) return null;
  let revision = options.revision;
  if (revision && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) throw new Error("Selected Git revision must be a full object hash");
  try {
    if (!revision)
    revision = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"])).toString().trim();
  } catch (errorCause) { const error = errorDetails(errorCause);
    if (error.exitCode === 1 || error.message.includes("Needed a single revision") ||
        error.message.includes("unknown revision")) return null;
    throw error;
  }
  const prefix = portable(path.relative(info.repository, root));
  const output = await git(info.repository, ["ls-tree", "-r", "-z", "--full-tree", revision]);
  let records: FileRecord[] = [];
  const diagnostics: string[] = [];
  for (const entry of output.toString().split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode, type, hash] = entry.slice(0, tab).split(" ");
    const fullPath = entry.slice(tab + 1);
    if (prefix && !fullPath.startsWith(prefix + "/")) continue;
    const file = prefix ? fullPath.slice(prefix.length + 1) : fullPath;
    if (type !== "blob" || !["100644", "100755"].includes(mode)) {
      if (isContractStorage(file) || file === MODULE_DIRECTORY || file === ".archiview")
        diagnostics.push("Expected regular contract storage: " + file);
      continue;
    }
    if (!excludedProjectPath(file) || isContractStorage(file)) records.push({ path: file, hash, ...(mode === "100755" ? { mode } : {}) });
  }
  const maxFiles = options.maxFiles ?? 50000;
  // The registry is required to interpret the captured files and does not consume a file slot.
  const registry = records.find((record) => record.path === MODULE_TREE_FILE);
  if (records.length - Number(Boolean(registry)) > maxFiles) {
    let kept = 0;
    records = records.filter((record) => record === registry || kept++ < maxFiles);
    diagnostics.push("File limit reached: " + maxFiles);
  }
  for (let index = 0; index < records.length; index += 16) {
    await Promise.all(records.slice(index, index + 16).map(async (record) => {
      try {
        const bytes = await git(info.repository,
          ["cat-file", "blob", record.hash!], "", record.path === MODULE_TREE_FILE ? MAX_TREE_BYTES :
            isContractStorage(record.path) ? MAX_DOCUMENT_BYTES : 256 * 1024);
        if (isContractStorage(record.path))
          record.text = decodeContractText(bytes, record.path).replace(/\r\n?/g, "\n");
        else if (!bytes.includes(0) && Buffer.from(bytes.toString("utf8")).equals(bytes))
          record.text = bytes.toString("utf8").replace(/\r\n?/g, "\n");
      } catch (errorCause) { const error = errorDetails(errorCause);
        if (isContractStorage(record.path)) {
          record.error = error.message;
          diagnostics.push(record.path + ": " + error.message);
        }
      }
    }));
  }
  const snapshotRoot = options.snapshotRoot ?? await readSnapshotRoot(root) ?? root;
  const snapshot = await assemble(snapshotRoot, records,
    { kind: "git", revision, label: "HEAD · " + revision.slice(0, 7) }, diagnostics);
  snapshot.id = "git-" + revision;
  return snapshot;
}

/**
 * Ленивая первая родительская линия текущей ветки: метаданные не загружают исходники
 * всех коммитов. Страница идёт от старого к новому, before исключает сам курсор.
 */
export async function listGitRevisions(projectRoot: string, { limit = 50, before = null }: {limit?:number;before?:string|null} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error("Revision page limit must be between 1 and 500");
  if (before !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(before)) throw new Error("Invalid Git revision cursor");
  const root = await realpath(projectRoot);
  const info = await gitInfo(root);
  const empty = { revisions: [], hasMore: false, nextBefore: null, headRevision: null };
  if (!info) return empty;
  let head;
  try { head = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"])).toString().trim(); }
  catch (errorCause) { const error = errorDetails(errorCause); if (error.exitCode === 1) return empty; throw error; }
  let start = head;
  if (before) {
    const distance = (await git(root, ["rev-list", "--first-parent", "--count", before + ".." + head])).toString().trim();
    let ancestor;
    try { ancestor = (await git(root, ["rev-parse", "--verify", head + "~" + distance])).toString().trim(); }
    catch { throw new Error("Git revision cursor is outside the current first-parent history"); }
    if (ancestor !== before) throw new Error("Git revision cursor is outside the current first-parent history");
    // Только хеш проходит в Git, поэтому курсор не может подменить его параметры.
    const parents = (await git(root, ["show", "-s", "--format=%P", before, "--"])).toString().trim().split(/\s+/).filter(Boolean);
    if (!parents.length) return { ...empty, headRevision: head };
    start = parents[0];
  }
  const output = await git(root, ["log", "--first-parent", "-z", "--format=%H%x00%ct%x00%s%x00%P", "--max-count=" + (limit + 1), start, "--"]);
  const fields = output.toString("utf8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (fields.length % 4 !== 0) throw new Error("Invalid Git revision metadata");
  const records: GitRevision[] = [];
  for (let index = 0; index < fields.length; index += 4) {
    const [revision, timestamp, subject, parents] = fields.slice(index, index + 4);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision) || !/^-?\d+$/.test(timestamp)) throw new Error("Invalid Git revision metadata");
    const date = new Date(Number(timestamp) * 1000).toISOString();
    records.push({ id: "git-" + revision, revision, parentRevision: parents.split(" ")[0] || null, isHead: revision === head,
      kind: "git", capturedAt: date, date, subject,
      label: "Revision " + revision.slice(0, 7) + (subject ? " · " + subject : "") });
  }
  const hasMore = records.length > limit;
  const page = records.slice(0, limit).reverse();
  return { revisions: page, hasMore, nextBefore: hasMore ? page[0].revision : null, headRevision: head };
}

/** Снимает подготовленный индекс Git, включая ещё не закоммиченные добавления и удаления. */
export async function captureGitIndex(projectRoot: string, options: SnapshotOptions = {}) {
  const root = await realpath(projectRoot);
  if (!await gitInfo(root)) throw new Error("Index verification requires a Git repository");
  // write-tree фиксирует точные staged blobs; рабочие файлы и HEAD не заменяют индекс.
  const revision = (await git(root, ["write-tree"])).toString().trim();
  return captureGitHead(root, { ...options, revision });
}
