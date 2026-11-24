import { isUtf8 } from "node:buffer";
import { open } from "node:fs/promises";
import path from "node:path";
import { structuredPatch } from "diff";
import { regularProjectFile } from "../analyse/project/source-files.js";
import { repositoryDirectoryOwnership } from "../analyse/project/workspace.js";
import { errorDetails } from "../node-errors.js";
import { git } from "../analyse/git-changes/capture.js";
import { MODULE_TREE_FILE, readContractStorageFile } from "../analyse/project/module-tree.js";
import type { ComparisonModule, Snapshot, SnapshotModule } from "../framework/snapshots/types.js";
import type { FileDiff } from "./api.js";
import { ApplicationError } from "./errors.js";

const maxBytes = 1024 * 1024;
const tooLarge = "Файл превышает 1 МиБ. Построчный diff недоступен.";
const unavailable = "В выбранном снимке отсутствует текст файла.";
const stale = () => new ApplicationError("STALE_VIEW", "Файл изменился после загрузки. Обновите сравнение.");
type Content = { text: string } | { message: string };

function decode(bytes: Buffer): Content {
  if (bytes.includes(0) || !isUtf8(bytes)) return { message: "Двоичный файл или кодировка, отличная от UTF-8. Построчный diff недоступен." };
  return { text: bytes.toString("utf8").replace(/\r\n/g, "\n") };
}

async function workingContent(root: string, file: string, hash: string): Promise<Content> {
  if (file === MODULE_TREE_FILE) {
    const text = await readContractStorageFile(root, file);
    if (text === null) throw stale();
    const bytes = Buffer.from(text);
    if (bytes.length > maxBytes) return { message: tooLarge };
    return verifiedWorkingText(root, file, hash, bytes);
  }
  if (!await regularProjectFile(root, file) || !await repositoryDirectoryOwnership(root)(path.posix.dirname(file))) throw stale();
  try {
    const handle = await open(path.join(root, file), "r");
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw stale();
      if (info.size > maxBytes) return { message: tooLarge };
      const bytes = Buffer.alloc(info.size);
      const { bytesRead } = await handle.read(bytes);
      if (bytesRead !== info.size || (await handle.stat()).size !== info.size) throw stale();
      return verifiedWorkingText(root, file, hash, bytes);
    } finally { await handle.close(); }
  } catch (cause) {
    if (errorDetails(cause).code === "ENOENT") throw stale();
    throw cause;
  }
}

/** Verify the displayed bytes with the same path filters used when the view was captured. */
async function verifiedWorkingText(root: string, file: string, hash: string, bytes: Buffer) {
  const actual = await git(root, ["hash-object", "--stdin", "--path", file], bytes);
  if (actual.toString().trim() !== hash) throw stale();
  return decode(bytes);
}

async function blobContent(root: string, hash: string): Promise<Content> {
  const size = await git(root, ["cat-file", "-s", hash]);
  if (Number(size) > maxBytes) return { message: tooLarge };
  return decode(await git(root, ["cat-file", "blob", hash], "", maxBytes));
}

interface DiffSources { liveRoot?: string; repository?: string }

async function content(snapshot: Snapshot | null, module: SnapshotModule | null, file: string, sources: DiffSources): Promise<Content> {
  const record = module?.files.find(entry => entry.path === file);
  if (!record) return { text: "" };
  if (file === module?.documentPath && module.document.text != null) return { text: module.document.text };
  if (!sources.liveRoot) {
    const fact = snapshot?.facts.find(entry => entry.kind === "file" && entry.path === file);
    if (fact) return Buffer.byteLength(fact.text) <= maxBytes ? { text: fact.text } : { message: tooLarge };
    // A historical map recovered from its exact Git tree has a blob identity but no archived text.
    if (file === MODULE_TREE_FILE && sources.repository && snapshot?.revision && record.hash && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(record.hash)) {
      try { return await blobContent(sources.repository, record.hash); } catch { /* object unavailable after transfer */ }
    }
    return { message: unavailable };
  }
  if (!record.hash) return { message: unavailable };
  if (!snapshot?.revision) return workingContent(sources.liveRoot, file, record.hash);
  return blobContent(sources.liveRoot, record.hash);
}

/** Published and saved comparisons read archived evidence. Only the live Git view can read working files. */
export async function fileDiff(module: ComparisonModule, baseline: Snapshot | null, current: Snapshot, file: string, location?: string | DiffSources): Promise<FileDiff> {
  const sources = typeof location === "string" ? { liveRoot: location } : location ?? {};
  const change = module.files.find(entry => entry.path === file);
  const before = module.before?.files.find(entry => entry.path === file);
  const after = module.after?.files.find(entry => entry.path === file);
  if (!before && !after) throw new ApplicationError("NOT_FOUND", "Файл отсутствует в выбранном модуле.");
  if (!change) {
    // An unchanged working file already has an immutable copy in the selected Git baseline.
    const source = sources.liveRoot && !current.revision && baseline?.revision
      ? await content(baseline, module.before, file, sources) : await content(current, module.after, file, sources);
    return "message" in source ? { hunks: [], message: source.message } : { hunks: [], unchangedText: source.text };
  }
  const mode = before && after && before.mode !== after.mode
    ? "Режим файла изменился с " + (before.mode ?? "100644") + " на " + (after.mode ?? "100644") + "." : undefined;
  if (mode && before?.hash && before.hash === after?.hash) return { hunks: [], message: mode };
  const [oldContent, newContent] = await Promise.all([
    content(baseline, module.before, file, sources), content(current, module.after, file, sources),
  ]);
  if ("message" in oldContent) return { hunks: [], message: oldContent.message };
  if ("message" in newContent) return { hunks: [], message: newContent.message };
  const patch = structuredPatch(file, file, oldContent.text, newContent.text, undefined, undefined, { context: 3, timeout: 500 });
  if (!patch) return { hunks: [], message: "Слишком много различий для построчного сравнения." };
  if (patch.hunks.length || mode) return { hunks: patch.hunks, message: mode };
  const message = change.status === "new" ? "Добавлен пустой файл." : change.status === "removed" ? "Удалён пустой файл." : "Текстовые строки совпадают.";
  return { hunks: [], message };
}
