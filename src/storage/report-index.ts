import type { Snapshot } from "../snapshots/types.js";
import type { ReviewEntry, ReviewHistory } from "../reports/types.js";
/**
 * Проверяет опубликованные отчёты именно из индекса Git. Временная копия содержит
 * только staged-данные ArchiView; рабочее дерево и индекс пользователя не меняются.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SnapshotStore } from "./snapshot-store.js";
import { captureGitIndex } from "../snapshots/capture.js";
import { ReportStore } from "./report-store.js";
import { validateStoredReport } from "./publication.js";
import { buildModuleStates } from "../reports/module-state.js";
import { validateReviewEntry } from "../reports/review-validation.js";
import { validateReviewRelations } from "../reports/review-identity.js";
import { REPORT_SCHEMA_VERSION } from "../reports/types.js";
import { digest } from "../serialization/digest.js";
import { parseYaml } from "../serialization/yaml.js";

const execute = promisify(execFile);
/** Выполняет Git с аргументами без shell и без изменения staged-набора. */
async function git(root: string, args: string[]) {
  return (await execute("git", args, { cwd: root, windowsHide: true, maxBuffer: 128 * 1024 * 1024 })).stdout;
}

/** Проверяет цельность work и соответствие его текущего состояния staged-исходникам. */
export async function checkPreparedIndex(root: string) {
  root = path.resolve(root);
  const listed = (await git(root, ["ls-files", "--stage", "-z"])).split("\0").filter(Boolean);
  const entries = listed.map((line) => {
    const tab = line.indexOf("\t");
    const [mode, hash, stage] = line.slice(0, tab).split(" ");
    return { mode, hash, stage, file: line.slice(tab + 1) };
  }).filter((item) => item.file.startsWith(".archiview/"));
  if (entries.some((entry) => entry.stage !== "0")) throw new Error("Unresolved Git index conflicts in ArchiView data");
  const raw = entries.filter((entry) => /^\.archiview\/(snapshots|reviews)\//.test(entry.file) || /^\.archiview\/saved-.*\.json$/.test(entry.file));
  if (raw.length) throw new Error("Raw ArchiView history is tracked in the index: " + raw.map((item) => item.file).join(", "));
  const published = entries.filter((entry) => [".archiview/project.json", ".archiview/.gitignore"].includes(entry.file) || /^\.archiview\/work\/[^/]+\.(archi|review)\.yaml$/.test(entry.file));
  if (![".archiview/project.json", ".archiview/.gitignore"].every((file) => published.some((entry) => entry.file === file)))
    throw new Error("Prepared ArchiView data requires project.json and .gitignore");
  if (!published.some((entry) => entry.file.endsWith(".archi.yaml"))) throw new Error("No prepared ArchiView reports in the Git index");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "archiview-index-"));
  try {
    for (const entry of published) {
      if (!["100644", "100755"].includes(entry.mode)) throw new Error("Report must be a regular staged file: " + entry.file);
      const target = path.join(temporary, ...entry.file.split("/"));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, await git(root, ["cat-file", "blob", entry.hash]));
    }
    const store = new SnapshotStore(root, path.join(temporary, ".archiview"));
    await store.open();
    const comparison = await new ReportStore(store).publishedComparison();
    const actual = await captureGitIndex(root, { snapshotRoot: store.snapshotRoot });
    if (!actual || !actual.complete) throw new Error("Incomplete staged source capture");
    const technical = [];
    const attempts: ReviewEntry[] = [];
    for (const entry of published) {
      if (entry.file.endsWith(".archi.yaml")) technical.push(parseYaml(await readFile(path.join(temporary, entry.file), "utf8"), validateStoredReport));
      if (entry.file.endsWith(".review.yaml")) {
        const history = parseYaml(await readFile(path.join(temporary, entry.file), "utf8"), (value) => value as ReviewHistory);
        if (history.schema_version !== REPORT_SCHEMA_VERSION || history.kind !== "review_history" || !Array.isArray(history.entries)) throw new Error("Invalid staged review history");
        for (const review of history.entries) attempts.push(validateReviewEntry(review));
      }
    }
    validateReviewRelations(attempts);
    // Сравниваем состояния модулей, а не время захвата, тип снимка или абсолютный корень.
    const stateDigest = (snapshot: Snapshot) => digest([...buildModuleStates(snapshot)].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
    const actualDigest = stateDigest(actual);
    if (!comparison?.current || stateDigest(comparison.current) !== actualDigest)
      throw new Error("Prepared source code and ArchiView reports describe different states");
    return { modules: actual.modules.length, reviews: attempts.length, reports: technical.length };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
