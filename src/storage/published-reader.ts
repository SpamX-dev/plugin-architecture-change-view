import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readSnapshotRoot } from "../project/identity.js";
import { assertStateLocation, projectStateDirectory } from "../project/paths.js";
import { digest } from "../serialization/digest.js";
import { validateReviewRelations } from "../reports/review-identity.js";
import type { ReviewHistory, TechnicalReport } from "../reports/types.js";
import { errorDetails } from "../runtime/errors.js";
import { moduleReportName, readYaml, validateHistoryFile } from "./report-store.js";
import { reconstruct, validateStoredReport } from "./publication.js";

export class PublicationChanged extends Error {
  constructor() { super("Публикация изменилась. Откройте сохранённое состояние ещё раз."); }
}

async function stamp(file: string, directory = false) {
  try {
    const info = await lstat(file, { bigint: true });
    if (directory ? !info.isDirectory() : !info.isFile()) throw new Error("Invalid published " + (directory ? "directory" : "file") + ": " + file);
    return [info.dev, info.ino, info.size, info.ctimeNs, info.mtimeNs].join("/");
  } catch (cause) {
    if (errorDetails(cause).code === "ENOENT") return null;
    throw cause;
  }
}

/** Readers do not open the mutable stores. An atomic swap also changes this ticket
 * on a review-only publication, for which the snapshot comparison key is unchanged. */
export async function readPublishedTree(root: string, stateDirectory?: string) {
  const directory = projectStateDirectory(root, stateDirectory);
  const work = path.join(directory, "work");
  for (let attempt = 0; ; attempt++) {
    try { return await readGeneration(root, directory, work); }
    catch (cause) {
      if (!(cause instanceof PublicationChanged) && errorDetails(cause).code !== "ENOENT") throw cause;
      if (attempt < 3) { await delay(25 * (attempt + 1)); continue; }
      // An interrupted swap has no readable work. Its journal belongs to the
      // normal live writer, which can finish recovery under the publication lock.
      await assertStateLocation(root, directory, work);
      if (!await stamp(work, true)) return null;
      throw cause;
    }
  }
}

async function readGeneration(root: string, directory: string, work: string) {
  await assertStateLocation(root, directory, work);
  const version = await stamp(work, true);
  if (!version) {
    const journal = path.join(directory, "snapshots", ".publication.yaml");
    await assertStateLocation(root, directory, journal);
    if (await stamp(journal) || await stamp(work, true)) throw new PublicationChanged();
    return null;
  }
  const origin = await readSnapshotRoot(root, directory) ?? root;
  const projectId = digest(origin);
  const files = (await readdir(work)).filter(name => /\.(archi|review)\.yaml$/.test(name)).sort();
  const versions = new Map<string, string>();
  const reports: TechnicalReport[] = [];
  for (const name of files) {
    const file = path.join(work, name);
    const fileVersion = await stamp(file);
    if (!fileVersion) throw new PublicationChanged();
    versions.set(name, fileVersion);
    if (!name.endsWith(".archi.yaml")) continue;
    await assertStateLocation(root, directory, file);
    const report = validateStoredReport(await readYaml(file));
    if (!report.publication || report.project_id !== projectId || name !== moduleReportName(report.module_id) + ".archi.yaml")
      throw new Error("Invalid published technical report: " + name);
    if (await stamp(file) !== fileVersion) throw new PublicationChanged();
    reports.push(report);
  }
  async function checkDirectory() {
    await assertStateLocation(root, directory, work);
    if (await stamp(work, true) !== version) throw new PublicationChanged();
  }
  await checkDirectory();
  const pair = reconstruct(reports);
  if (!pair) return null;
  if (pair.current.root !== origin || pair.baseline && pair.baseline.root !== origin) throw new Error("Foreign published snapshot");
  const generation = Math.max(...reports.map(report => report.publication!.generation));
  const selected = reports.filter(report => report.publication!.generation === generation);
  const reviewIds = new Map(selected.map(report => {
    const status = report.review_status;
    const ids = status ? [status.self.current, status.self.change, status.explicit_subtree.current, status.explicit_subtree.change]
      .flatMap(side => side.review_ids ?? []) : [];
    if (ids.length && !versions.has(moduleReportName(report.module_id) + ".review.yaml"))
      throw new Error("Missing published review history: " + report.module_id);
    return [report.module_id, new Set(ids)] as const;
  }));
  async function readReviews(moduleId: string) {
    await checkDirectory();
    const name = moduleReportName(moduleId) + ".review.yaml";
    const file = path.join(work, name);
    await assertStateLocation(root, directory, file);
    const expected = versions.get(name) ?? null;
    if (await stamp(file) !== expected) throw new PublicationChanged();
    if (!expected) return [];
    const entries = validateHistoryFile(await readYaml<ReviewHistory>(file), name, origin);
    validateReviewRelations(entries);
    const saved = new Set(entries.map(entry => entry.review_id));
    for (const id of reviewIds.get(moduleId) ?? []) if (!saved.has(id))
      throw new Error("Missing published review: " + id);
    if (await stamp(file) !== expected) throw new PublicationChanged();
    await checkDirectory();
    return entries.sort((a, b) => (b.registration_order ?? 0) - (a.registration_order ?? 0));
  }
  return { pair, reports: selected, work, readReviews,
    hasReviews: (id: string) => versions.has(moduleReportName(id) + ".review.yaml"),
    id: "published-" + digest([root, work, version, [...versions], generation, selected[0].publication!.comparison_key]).slice(7, 31) };
}
