/**
 * Общая модель ArchiView: снимки каталогов, документов и отпечатков файлов.
 * Сравнивает собственные файлы модуля; изменения потомков учитывает отдельно.
 * Исторические снимки содержат текст module.md, поэтому удалённые модули читаемы.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { SOURCE_EXTENSIONS, excludedProjectPath, projectFiles,
  regularProjectFile } from "./inventory.mjs";
import { contractDocument, digest as contentDigest } from "./formats.mjs";

/** Контракты читаются в обоих форматах; новый формат имеет безусловный приоритет. */
const isContract = (file) => ["arch.yaml", "module.md"].includes(path.posix.basename(file));
const isSource = (file) => SOURCE_EXTENSIONS.has(path.posix.extname(file).toLowerCase());

/** Стабильная контрольная сумма структуры, не зависящая от времени индексации. */
function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** Относительные пути снимков используют единые разделители на всех платформах. */
function portable(value) {
  return value.split(path.sep).join("/");
}

/** Запускает только Git без оболочки, ограничивая время и объём ответа. */
async function git(root, args, input = "", maxBytes = 16 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd: root, windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    let bytes = 0;
    let diagnostic = "";
    let failure;
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
        const error = failure ?? new Error(diagnostic.trim() || "Git exited with code " + code);
        error.exitCode = code;
        reject(error);
      }
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(input);
  });
}

/** Определяет корень и алгоритм Git; отсутствие Git допускает файловые снимки. */
async function gitInfo(root) {
  let repository;
  try {
    repository = (await git(root, ["rev-parse", "--show-toplevel"])).toString().trim();
  } catch (error) {
    if (error.code === "ENOENT" || error.message.includes("not a git repository")) return null;
    throw error;
  }
  const algorithm = (await git(root, ["rev-parse", "--show-object-format"]))
    .toString().trim();
  return { repository: await realpath(repository), algorithm };
}

/** Вычисляет blob-отпечаток вне Git, не загружая крупные исходники в память. */
async function fileHash(file) {
  const before = await lstat(file);
  const hash = createHash("sha1").update("blob " + before.size + "\0");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  const after = await lstat(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
    throw new Error("File changed while being captured");
  }
  return hash.digest("hex");
}

/**
 * Строит модули по каталогам исходников и module.md, включая предков.
 * Вспомогательные файлы принадлежат ближайшему модулю; они тоже влияют на статус.
 */
function assemble(root, records, metadata, diagnostics) {
  const directories = new Set(["."]);
  const recordPaths = new Set(records.map((r) => r.path));
  for (const record of records) {
    if (!isSource(record.path) && !isContract(record.path)) continue;
    let directory = path.posix.dirname(record.path);
    while (true) {
      directories.add(directory);
      if (directory === ".") break;
      directory = path.posix.dirname(directory);
    }
  }
  const modules = new Map([...directories].sort().map((directory) => [directory, {
    directory, documentPath: path.posix.join(directory,
      recordPaths.has(path.posix.join(directory, "arch.yaml")) ? "arch.yaml" :
        recordPaths.has(path.posix.join(directory, "module.md")) ? "module.md" : "arch.yaml"),
    document: { state: "missing", text: null }, files: [], sourceFiles: 0,
  }]));
  for (const record of records) {
    let owner = path.posix.dirname(record.path);
    while (!modules.has(owner)) owner = path.posix.dirname(owner);
    const module = modules.get(owner);
    module.files.push({ path: record.path, hash: record.hash, error: record.error });
    if (SOURCE_EXTENSIONS.has(path.posix.extname(record.path).toLowerCase())) {
      module.sourceFiles += 1;
    }
    if (record.path === module.documentPath) {
      module.document = record.error ? { state: "unreadable", text: null, errors: [record.error] } :
        contractDocument(record.text, path.posix.basename(record.path));
    }
  }
  for (const module of modules.values()) {
    if (module.document.format === "arch.yaml" && module.files.some((f) => f.path === path.posix.join(module.directory, "module.md"))) {
      if (module.document.state === "documented") module.document.state = "migration_required";
      module.document.action = "Сверьте оба описания, перенесите ограничения в arch.yaml и удалите module.md после проверки.";
    }
    module.files.sort((a, b) => a.path.localeCompare(b.path));
    module.fingerprint = digest(JSON.stringify(module.files));
  }
  const data = [...modules.values()];
  const ids = new Map();
  for (const module of data) if (module.document.contract) {
    const id = module.document.contract.id;
    if (!ids.has(id)) ids.set(id, []);
    ids.get(id).push(module);
  }
  for (const [id, entries] of ids) if (entries.length > 1) for (const module of entries) {
    module.document.state = "invalid";
    module.document.errors = ["Повторяющийся id модуля: " + id];
  }
  const facts = [];
  const evidenceLimitations = [];
  let remaining = 16 * 1024 * 1024;
  for (const record of records) {
    if (!isSource(record.path) && !isContract(record.path)) continue;
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
  const fingerprint = digest(JSON.stringify({ root, modules: data }));
  const snapshot = { schema_version: 2, root, capturedAt: new Date().toISOString(),
    ...metadata, fingerprint, complete: diagnostics.length === 0,
    diagnostics, modules: data, facts, evidenceLimitations };
  snapshot.digest = snapshotDigest(snapshot);
  return snapshot;
}

/** Метки и время не меняют содержание снимка; факты и неполнота входят в отпечаток. */
export function snapshotDigest(snapshot) {
  return contentDigest({ root: snapshot.root, modules: snapshot.modules,
    facts: snapshot.facts ?? [], complete: snapshot.complete,
    diagnostics: snapshot.diagnostics, evidenceLimitations: snapshot.evidenceLimitations ?? [] });
}

/**
 * Снимает рабочее дерево. В Git отпечатки учитывают атрибуты и нормализацию
 * строк через hash-object, чтобы CRLF не выглядел как изменение всего проекта.
 */
export async function captureWorkingTree(projectRoot, options = {}) {
  const root = await realpath(projectRoot);
  const info = await gitInfo(root);
  const listed = await projectFiles(root, options.maxFiles ?? 50000);
  const diagnostics = [...listed.diagnostics];
  const files = [];
  for (const file of listed.files) {
    try {
      if (await regularProjectFile(root, file)) files.push(portable(file));
    } catch (error) { diagnostics.push(file + ": " + error.message); }
  }
  files.sort();
  let hashes;
  if (info && files.length) {
    hashes = (await git(root, ["hash-object", "--stdin-paths"],
      files.map((file) => JSON.stringify(file)).join("\n") + "\n"))
      .toString().trim().split("\n");
    if (hashes.length !== files.length) throw new Error("Incomplete Git file hashes");
  }
  const records = [];
  let evidenceBudget = 16 * 1024 * 1024;
  for (let offset = 0; offset < files.length; offset += 16) {
    const batch = await Promise.all(files.slice(offset, offset + 16).map(async (file, index) => {
      try {
        const fullPath = path.join(root, file);
        const hash = hashes?.[offset + index] ?? await fileHash(fullPath);
        let text;
        if (isContract(file) || isSource(file)) {
          const size = (await lstat(fullPath)).size;
          if (isContract(file) && size > 128 * 1024) throw new Error("Contract exceeds 128 KiB");
          if (size <= 256 * 1024 && size <= evidenceBudget) {
            evidenceBudget -= size;
            text = (await readFile(fullPath, "utf8")).replace(/\r\n/g, "\n");
          } else if (isContract(file)) throw new Error("Contract evidence budget exceeded");
        }
        return { path: file, hash, text };
      } catch (error) {
        diagnostics.push(file + ": " + error.message);
        return { path: file, hash: null, error: error.message };
      }
    }));
    records.push(...batch);
  }
  const snapshot = assemble(root, records, { kind: "working", label: "Рабочее дерево" },
    diagnostics);
  snapshot.id = "working-" + snapshot.digest.slice(7);
  return snapshot;
}

/** Читает структуру HEAD и документы из Git, сохраняя удалённые рабочие файлы. */
export async function captureGitHead(projectRoot, options = {}) {
  const root = await realpath(projectRoot);
  const info = await gitInfo(root);
  if (!info) return null;
  let revision;
  try {
    revision = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"])).toString().trim();
  } catch (error) {
    if (error.exitCode === 1 || error.message.includes("Needed a single revision") ||
        error.message.includes("unknown revision")) return null;
    throw error;
  }
  const prefix = portable(path.relative(info.repository, root));
  const output = await git(info.repository, ["ls-tree", "-r", "-z", "--full-tree", revision]);
  const records = [];
  for (const entry of output.toString().split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    const [mode, type, hash] = entry.slice(0, tab).split(" ");
    const fullPath = entry.slice(tab + 1);
    if (type !== "blob" || !["100644", "100755"].includes(mode)) continue;
    if (prefix && !fullPath.startsWith(prefix + "/")) continue;
    const file = prefix ? fullPath.slice(prefix.length + 1) : fullPath;
    if (!excludedProjectPath(file)) records.push({ path: file, hash });
  }
  const diagnostics = [];
  const maxFiles = options.maxFiles ?? 50000;
  if (records.length > maxFiles) {
    records.length = maxFiles;
    diagnostics.push("File limit reached: " + maxFiles);
  }
  for (let index = 0; index < records.length; index += 16) {
    await Promise.all(records.slice(index, index + 16).map(async (record) => {
      if (!isContract(record.path) && !isSource(record.path)) return;
      try {
        record.text = (await git(info.repository,
          ["cat-file", "blob", record.hash], "", isContract(record.path) ? 128 * 1024 : 256 * 1024)).toString()
          .replace(/\r\n/g, "\n");
      } catch (error) {
        if (isContract(record.path)) {
          record.error = error.message;
          diagnostics.push(record.path + ": " + error.message);
        }
      }
    }));
  }
  const snapshot = assemble(root, records,
    { kind: "git", revision, label: "HEAD · " + revision.slice(0, 7) }, diagnostics);
  snapshot.id = "git-" + revision;
  return snapshot;
}

/** Вычисляет изменения собственных файлов модуля, включая конфигурацию и документы. */
function changedFiles(before, after) {
  const oldFiles = new Map((before?.files ?? []).map((file) => [file.path, file]));
  const newFiles = new Map((after?.files ?? []).map((file) => [file.path, file]));
  return [...new Set([...oldFiles.keys(), ...newFiles.keys()])].sort().flatMap((file) => {
    const previous = oldFiles.get(file);
    const current = newFiles.get(file);
    if (previous && current && previous.hash === current.hash) return [];
    return [{ path: file, status: !previous ? "new" : !current ? "removed" : "changed" }];
  });
}

/**
 * Сравнивает объединение модулей двух снимков. Родитель сохраняет собственный
 * статус, а число изменённых потомков передаётся отдельным полем.
 */
export function compareSnapshots(before, after) {
  if (before && before.root !== after.root) throw new Error("Snapshots belong to different projects");
  const previous = new Map((before?.modules ?? []).map((module) => [module.directory, module]));
  const current = new Map(after.modules.map((module) => [module.directory, module]));
  const identity = (m) => m?.document.state === "documented" ? m.document.contract?.id : null;
  const oldIds = new Map([...previous.values()].filter(identity).map((m) => [identity(m), m]));
  const currentIds = new Set([...current.values()].map(identity).filter(Boolean));
  const matched = new Set();
  const pairs = [...current.values()].map((m) => {
    const byId = identity(m) ? oldIds.get(identity(m)) : null;
    const byPath = previous.get(m.directory);
    const prior = byId ?? (identity(m) && identity(byPath) && identity(m) !== identity(byPath) ? null :
      byPath && !matched.has(byPath.directory) && (!identity(byPath) || !currentIds.has(identity(byPath))) ? byPath : null);
    if (prior) matched.add(prior.directory);
    return [prior, m];
  });
  for (const m of previous.values()) if (!matched.has(m.directory)) pairs.push([m, null]);
  const modules = pairs.map(([oldModule, newModule]) => {
    const directory = newModule?.directory ?? oldModule.directory;
    const files = changedFiles(oldModule, newModule);
    return { directory, name: directory === "." ? path.basename(after.root) :
      path.posix.basename(directory),
      moduleId: identity(newModule ?? oldModule),
      title: (newModule ?? oldModule).document.contract?.title,
      baselinePath: oldModule?.directory ?? null, currentPath: newModule?.directory ?? null,
      moved: Boolean(oldModule && newModule && oldModule.directory !== newModule.directory),
      status: !before ? "initial" : !oldModule ? "new" : !newModule ? "removed" : files.length ? "changed" : "unchanged",
      documentState: (newModule ?? oldModule).document.state,
      documentChanged: JSON.stringify(oldModule?.document ?? { state: "missing", text: null }) !==
        JSON.stringify(newModule?.document ?? { state: "missing", text: null }),
      sourceFiles: (newModule ?? oldModule).sourceFiles,
      filesChanged: files.length, descendantChanges: 0, files,
      before: oldModule ?? null, after: newModule ?? null };
  }).sort((a, b) => a.directory.localeCompare(b.directory) || a.status.localeCompare(b.status));
  const pathCounts = new Map();
  for (const module of modules) pathCounts.set(module.directory, (pathCounts.get(module.directory) ?? 0) + 1);
  for (const module of modules) module.key = module.directory + (pathCounts.get(module.directory) > 1 ? "::" + module.status : "");
  const indexed = new Map(modules.map((module) => [module.directory, module]));
  for (const module of modules) {
    if (["unchanged", "initial"].includes(module.status) || module.directory === ".") continue;
    let parent = path.posix.dirname(module.directory);
    while (true) {
      if (indexed.has(parent)) indexed.get(parent).descendantChanges += 1;
      if (parent === ".") break;
      parent = path.posix.dirname(parent);
    }
  }
  return { schema_version: 2, id: digest((before?.id ?? "initial") + after.digest).slice(0, 24),
    root: after.root, before: before ? { id: before.id, label: before.label, kind: before.kind,
      digest: before.digest ?? snapshotDigest(before), capturedAt: before.capturedAt } :
      { id: "initial", label: "Первый анализ", kind: "initial" },
    after: { id: after.id, digest: after.digest, capturedAt: after.capturedAt },
    complete: (before?.complete ?? true) && after.complete,
    diagnostics: [...before?.diagnostics ?? [], ...after.diagnostics],
    counts: Object.fromEntries(["initial", "new", "changed", "removed", "unchanged"].map((status) =>
      [status, modules.filter((module) => module.status === status).length])),
    modules };
}
