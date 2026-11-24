import { isUtf8 } from "node:buffer";
import { open } from "node:fs/promises";
import path from "node:path";
import { structuredPatch } from "diff";
import { regularProjectFile } from "../analyse/project/source-files.js";
import { repositoryDirectoryOwnership } from "../analyse/project/workspace.js";
import { errorDetails } from "../node-errors.js";
import { git } from "../analyse/git-changes/capture.js";
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
      // Hash exactly the bytes being displayed with the same path filters used by the tree.
      const actual = await git(root, ["hash-object", "--stdin", "--path", file], bytes);
      if (actual.toString().trim() !== hash) throw stale();
      return decode(bytes);
    } finally { await handle.close(); }
  } catch (cause) {
    if (errorDetails(cause).code === "ENOENT") throw stale();
    throw cause;
  }
}

async function content(snapshot: Snapshot | null, module: SnapshotModule | null, file: string, gitRoot?: string): Promise<Content> {
  const record = module?.files.find(entry => entry.path === file);
  if (!record) return { text: "" };
  if (file === module?.documentPath && module.document.text != null) return { text: module.document.text };
  if (!gitRoot) {
    const fact = snapshot?.facts.find(entry => entry.kind === "file" && entry.path === file);
    if (!fact) return { message: unavailable };
    return Buffer.byteLength(fact.text) <= maxBytes ? { text: fact.text } : { message: tooLarge };
  }
  if (!record.hash) return { message: unavailable };
  if (!snapshot?.revision) return workingContent(gitRoot, file, record.hash);
  const size = await git(gitRoot, ["cat-file", "-s", record.hash]);
  if (Number(size) > maxBytes) return { message: tooLarge };
  return decode(await git(gitRoot, ["cat-file", "blob", record.hash], "", maxBytes));
}

/** Only the fast Git view needs to resolve content. Published and saved comparisons use their own evidence. */
export async function fileDiff(module: ComparisonModule, baseline: Snapshot | null, current: Snapshot, file: string, gitRoot?: string): Promise<FileDiff> {
  const change = module.files.find(entry => entry.path === file);
  const before = module.before?.files.find(entry => entry.path === file);
  const after = module.after?.files.find(entry => entry.path === file);
  if (!before && !after) throw new ApplicationError("NOT_FOUND", "Файл отсутствует в выбранном модуле.");
  if (!change) {
    // An unchanged working file already has an immutable copy in the selected Git baseline.
    const source = gitRoot && !current.revision && baseline?.revision
      ? await content(baseline, module.before, file, gitRoot) : await content(current, module.after, file, gitRoot);
    return "message" in source ? { hunks: [], message: source.message } : { hunks: [], unchangedText: source.text };
  }
  const mode = before && after && before.mode !== after.mode
    ? "Режим файла изменился с " + (before.mode ?? "100644") + " на " + (after.mode ?? "100644") + "." : undefined;
  if (mode && before?.hash && before.hash === after?.hash) return { hunks: [], message: mode };
  const [oldContent, newContent] = await Promise.all([
    content(baseline, module.before, file, gitRoot), content(current, module.after, file, gitRoot),
  ]);
  if ("message" in oldContent) return { hunks: [], message: oldContent.message };
  if ("message" in newContent) return { hunks: [], message: newContent.message };
  const patch = structuredPatch(file, file, oldContent.text, newContent.text, undefined, undefined, { context: 3, timeout: 500 });
  if (!patch) return { hunks: [], message: "Слишком много различий для построчного сравнения." };
  if (patch.hunks.length || mode) return { hunks: patch.hunks, message: mode };
  const message = change.status === "new" ? "Добавлен пустой файл." : change.status === "removed" ? "Удалён пустой файл." : "Текстовые строки совпадают.";
  return { hunks: [], message };
}
