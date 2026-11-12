import { writeModuleTree } from "./support.js";
import type { Snapshot, ComparisonModule } from "../src/snapshots/types.js";
import type { TechnicalReport, ReviewHistory } from "../src/reports/types.js";
import type { TestContext } from "node:test";
/** Переносимость, неизменность реальных попыток и восстановление публикаций v2. */
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { stringify } from "yaml";
import { digest } from "../src/serialization/digest.js";
import { captureWorkingTree } from "../src/snapshots/capture.js";
import { compareSnapshots } from "../src/snapshots/comparison.js";
import { SnapshotStore } from "../src/storage/snapshot-store.js";
import { ReviewStore } from "../src/storage/review-store.js";
import { ANALYZER, createStructuralReview } from "../src/reviews/bundle.js";
import { createCodexPanel } from "../src/codex/panel.js";
import { createReviewInput } from "../src/reports/review-input.js";
import { createReviewEntry } from "../src/reports/review-entry.js";
import { validateReviewEntry } from "../src/reports/review-validation.js";
import { ReportStore, moduleReportName, readPublishedSnapshots } from "../src/storage/report-store.js";
import { validateArchiReport } from "../src/reports/technical-report.js";
import { parseReportYaml } from "../src/serialization/yaml.js";
import { createPublishedView } from "../src/application/published-view.js";
import { createArchiViewSession } from "../src/application/session.js";

const stored = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Каждый тест владеет своими исходниками, состоянием и копиями проекта. */
async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "archiview-report-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "source");
  await mkdir(path.join(root, "child"), { recursive: true });
  const contract = (id: string) => ({ schema_version: 1, id, title: id, kind: "module", purpose: "Читать собственные записи.",
    responsibilities: { R1: "Возвращать записи." }, boundaries: { B1: "Не обращаться к сети." }, invariants: {} });
  await writeModuleTree(root, { root: ".", child: "child" });
  await writeFile(path.join(root, ".archiview/modules/root.yaml"), stringify(contract("root")));
  await writeFile(path.join(root, ".archiview/modules/child.yaml"), stringify(contract("child")));
  await writeFile(path.join(root, "child/code.js"), "export const read = () => 1;\n");
  const snapshotStore = new SnapshotStore(root);
  const store = new ReportStore(snapshotStore);
  const baseline = await captureWorkingTree(root);
  await writeFile(path.join(root, "child/code.js"), "export const read = () => 2;\n");
  const current = await captureWorkingTree(root);
  const comparison = compareSnapshots(baseline, current);
  return { directory, root, store, snapshotStore, baseline, current, comparison };
}

/** Готовит настоящий импорт с явными LLM-метаданными, не объявляя код проверенным. */
function nativeReview(snapshotStore: SnapshotStore, baseline: Snapshot | null, current: Snapshot, id = "attempt-1", moduleId = "child", summary?: string) {
  const input = createReviewInput(digest(snapshotStore.snapshotRoot), baseline, current, moduleId,
    { reviewId: id, dependencyCoverage: { status: "complete", potential_influence: [] } });
  input.report.analysis.created_at = "2026-11-09T10:00:00.000Z";
  input.report.analysis.model = { provider: "test", id: "fixture-model" };
  input.report.analysis.prompt_digest = digest("fixture-prompt");
  input.manifest.model = input.report.analysis.model;
  input.manifest.prompt_digest = input.report.analysis.prompt_digest;
  input.report.analysis.input_digest = digest(input.manifest);
  if (summary) input.report.assessment.current.summary = summary;
  return createReviewEntry(input);
}

/** Прежний формат остаётся валидным пакетом со всеми исходными доказательствами. */
function legacyReview(baseline: Snapshot | null, current: Snapshot, module: ComparisonModule, id: string) {
  const bundle = createStructuralReview(baseline, current, module);
  bundle.report.id = id;
  bundle.report.analysis.analyzer = { name: "fixture-agent", version: "1", config_digest: digest({}) };
  bundle.manifest.analyzer = bundle.report.analysis.analyzer;
  bundle.report.analysis.input_digest = digest(bundle.manifest);
  return bundle;
}

test("publishes exact baseline/current snapshots and technical reports without LLM attempts", async (t) => {
  const { store, snapshotStore, baseline, current, comparison } = await fixture(t);
  const result = await store.rebuild(baseline, current, comparison.modules);
  assert.equal(result.reports.length, 2);
  assert.equal(result.entries.length, 0);
  const snapshots = await readPublishedSnapshots(snapshotStore);
  assert.deepEqual(snapshots, stored([baseline, current]));
  assert.deepEqual(await store.selectedBaseline(), stored(baseline));
  const published = await readFile(path.join(store.work, moduleReportName("child") + ".archi.yaml"), "utf8");
  await store.rebuild(baseline, await captureWorkingTree(snapshotStore.root), comparison.modules);
  assert.equal(await readFile(path.join(store.work, moduleReportName("child") + ".archi.yaml"), "utf8"), published);
  const raw = await readdir(store.raw);
  assert.equal(raw.length, 2);
  assert.ok(raw.every((name) => /^[a-f0-9]{64}$/.test(name)));
  assert.equal((await store.list()).entries.length, 0);
});

/** Меняет только версию и её хеш в тестовой публикации, сохраняя снимки и историю. */
async function publicationVersion(store: ReportStore, version: string) {
  const files = [];
  for (const name of (await readdir(store.work)).filter((name) => name.endsWith(".archi.yaml"))) {
    const file = path.join(store.work, name);
    const report = parseReportYaml<TechnicalReport>(await readFile(file, "utf8"));
    report.input_manifest.analyzer.version = version;
    report.check_hash = digest(report.input_manifest).slice(7);
    const text = stringify(report, { aliasDuplicateObjects: false });
    await writeFile(file, text);
    files.push([file, text]);
  }
  return files;
}

test("published tree reads only work, loads one module's exact reviews, and detects a review-only publication", async (t) => {
  const { root, snapshotStore, store, baseline, current, comparison } = await fixture(t);
  assert.equal(await createPublishedView({ root }), null);
  await store.rebuild(baseline, current, comparison.modules);
  await store.saveReview(nativeReview(snapshotStore, baseline, current));
  const workFiles = async () => (await readdir(store.work)).sort();
  const before = await workFiles();
  await writeFile(path.join(root, "child/code.js"), "unpublished changes");
  const saved = await createPublishedView({ root });
  assert.ok(saved);
  assert.equal(saved.comparison.published, true);
  assert.equal(saved.comparison.after.digest, current.digest);
  const args = { view: saved.comparison.id, path: "child" };
  const detail = await saved.getModule(args);
  assert.equal(detail.review?.id, "attempt-1");
  assert.equal(detail.reviews[0].report.id, detail.review.id);
  assert.equal(detail.reviews[0].reviewFile, ".archiview/work/" + moduleReportName("child") + ".review.yaml");
  assert.deepEqual(detail.after, stored(current.modules.find(module => module.directory === "child")));
  assert.deepEqual(await workFiles(), before);
  await store.saveReview(nativeReview(snapshotStore, baseline, current, "next-attempt"));
  await assert.rejects(saved.getModule(args), { code: "STALE_VIEW" });
  const next = await createPublishedView({ root });
  assert.ok(next);
  assert.notEqual(next.comparison.id, args.view);
  assert.equal((await next.getModule({ ...args, view: next.comparison.id })).review?.id, "next-attempt");

  // A checkout without raw history can still show all of work. Reading the root
  // neither parses a sibling's damaged review nor masks its failure on selection.
  const clone = path.join(path.dirname(root), "copied");
  await mkdir(path.join(clone, ".archiview"), { recursive: true });
  await cp(store.work, path.join(clone, ".archiview/work"), { recursive: true });
  await cp(path.join(store.directory, "project.json"), path.join(clone, ".archiview/project.json"));
  await writeFile(path.join(clone, detail.reviews[0].reviewFile), "broken: true");
  const copy = await createPublishedView({ root: clone });
  assert.ok(copy);
  assert.deepEqual((await copy.getModule({ view: copy.comparison.id, path: "." })).reviews, []);
  await assert.rejects(copy.getModule({ view: copy.comparison.id, path: "child" }), /Invalid review history schema/);
  assert.deepEqual((await readdir(path.join(clone, ".archiview"))).sort(), ["project.json", "work"]);
});

test("deferred first comparison selects the ordinary baseline and publishes the working snapshot only once", async (t) => {
  const { root } = await fixture(t);
  const session = await createArchiViewSession({ root, deferPublication: true });
  assert.equal(await createPublishedView({ root }), null);
  const result = await session.getComparison();
  const saved = await createPublishedView({ root });
  assert.ok(saved);
  assert.equal(saved.comparison.after.id, result.after.id);
  assert.equal(saved.comparison.before.id, result.before.id);
  const history = await session.reports.list();
  assert.equal(history.comparison?.current.kind, "working");
  assert.equal(history.comparison?.baseline?.kind, "launch");
  assert.ok(history.reports.every(report => report.publication?.generation === 1));
});

test("supported analyzer versions retain exact snapshots and review history across an upgrade", async (t) => {
  const { store, snapshotStore, baseline, current, comparison } = await fixture(t);
  await store.rebuild(baseline, current, comparison.modules);
  await store.saveReview(nativeReview(snapshotStore, baseline, current, "before-upgrade"));
  const reviewFile = path.join(store.work, moduleReportName("child") + ".review.yaml");
  const reviewBytes = await readFile(reviewFile, "utf8");
  const files = await publicationVersion(store, "1.0.1");
  assert.deepEqual(await store.publishedComparison(), stored({ baseline, current }));
  assert.deepEqual(await readPublishedSnapshots(snapshotStore), stored([baseline, current]));
  assert.deepEqual((await store.list()).diagnostics, []);
  for (const [file, text] of files) assert.equal(await readFile(file, "utf8"), text);
  const updated = await store.rebuild(baseline, current, comparison.modules);
  assert.ok(updated.reports.every((report) => report.input_manifest.analyzer.version === ANALYZER.version));
  assert.deepEqual(updated.comparison, stored({ baseline, current }));
  assert.deepEqual(updated.entries.map((entry) => entry.review_id), ["before-upgrade"]);
  assert.equal(await readFile(reviewFile, "utf8"), reviewBytes);
});

test("unsupported analyzer versions reach the panel as a clear error and cannot replace history", async (t) => {
  const { root, store, baseline, current, comparison } = await fixture(t);
  await store.rebuild(baseline, current, comparison.modules);
  const files = await publicationVersion(store, "9.0.0");
  const message = "Версия анализатора технического отчёта «9.0.0» не поддерживается. Поддерживаемые версии: 1.0.1, 1.0.2.";
  await assert.rejects(store.publishedComparison(), (error: unknown) => error instanceof Error && error.message.includes(message));
  const panel = createCodexPanel(root);
  t.after(() => panel.close());
  const result = await panel.callUi("archiview_ui_get_comparison", {});
  assert.ok("isError" in result && result.isError);
  assert.deepEqual(result.content, []);
  assert.equal("structuredContent" in result ? result.structuredContent : undefined, undefined);
  assert.ok(result._meta.error.message.includes(message));
  await assert.rejects(store.rebuild(baseline, current, comparison.modules), /refusing to replace/);
  for (const [file, text] of files) assert.equal(await readFile(file, "utf8"), text);
});

test("a supported earlier version keeps checksum, analyzer identity and snapshot validation strict", async (t) => {
  const { store, baseline, current, comparison } = await fixture(t);
  await store.rebuild(baseline, current, comparison.modules);
  await publicationVersion(store, "1.0.1");
  const file = path.join(store.work, moduleReportName("child") + ".archi.yaml");
  const original = parseReportYaml<TechnicalReport>(await readFile(file, "utf8"));
  const wrongHash = stored(original);
  wrongHash.input_manifest.analyzer.version = "1.0.2";
  assert.throws(() => validateArchiReport(wrongHash), /Technical check hash mismatch/);
  for (const mutate of [
    (report: TechnicalReport) => { report.change.own_code = !report.change.own_code; },
    (report: TechnicalReport) => { report.input_manifest.analyzer.name = "another-analyzer"; },
    (report: TechnicalReport) => { report.input_manifest.analyzer.config_digest = digest("other configuration"); },
  ]) {
    const report = stored(original);
    mutate(report);
    report.check_hash = digest(report.input_manifest).slice(7);
    const damaged = stringify(report, { aliasDuplicateObjects: false });
    await writeFile(file, damaged);
    await assert.rejects(store.publishedComparison(), /Published technical state differs from saved snapshot: child/);
    await assert.rejects(store.rebuild(baseline, current, comparison.modules), /refusing to replace/);
    assert.equal(await readFile(file, "utf8"), damaged);
  }
});

test("unchanged rebuild preserves the publication files and still detects external raw reviews", async (t) => {
  const { store, snapshotStore, baseline, current, comparison } = await fixture(t);
  const first = await store.rebuild(baseline, current, comparison.modules);
  const file = path.join(store.work, moduleReportName("child") + ".archi.yaml");
  const original = await readFile(file, "utf8");
  const oldTime = new Date("2020-01-01T00:00:00.000Z");
  await utimes(file, oldTime, oldTime);
  const before = await stat(file);
  const unchanged = await store.rebuild(baseline, await captureWorkingTree(snapshotStore.root), comparison.modules);
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  assert.equal(await readFile(file, "utf8"), original);
  assert.deepEqual(unchanged.comparison, stored({ baseline, current }));
  assert.deepEqual(new Map(unchanged.reports.map((report) => [report.module_id, report])),
    new Map(first.reports.map((report) => [report.module_id, report])));

  // Raw может содержать завершённый импорт другого процесса до его публикации work.
  const entry = nativeReview(snapshotStore, baseline, current, "external-raw-attempt");
  const raw = path.join(store.raw, entry.check_hash);
  await mkdir(raw, { recursive: true });
  await writeFile(path.join(raw, moduleReportName("child") + ".review.yaml"), stringify({
    schema_version: 2, kind: "review_history", module_id: "child", entries: [entry],
  }, { aliasDuplicateObjects: false }));
  const updated = await store.rebuild(baseline, current, comparison.modules);
  assert.deepEqual(updated.entries.map((item) => item.review_id), ["external-raw-attempt"]);
  const published = parseReportYaml<ReviewHistory>(await readFile(path.join(store.work, moduleReportName("child") + ".review.yaml"), "utf8"));
  assert.equal(published.entries[0].review_id, "external-raw-attempt");
});

test("unchanged rebuild detects damage to its raw report and published baselines remain independent of raw", async (t) => {
  const { store, baseline, current, comparison } = await fixture(t);
  const first = await store.rebuild(baseline, current, comparison.modules);
  const report = first.reports.find((item) => item.module_id === "child");
  const raw = path.join(store.raw, report!.check_hash, moduleReportName("child") + ".archi.yaml");
  await writeFile(raw, "schema_version: 999\nkind: archi\nmodule_id: child\n");
  assert.deepEqual(await store.publishedComparison(), stored({ baseline, current }));
  assert.match((await store.list()).diagnostics.join("\n"), /Invalid archi report schema/);
  await assert.rejects(store.rebuild(baseline, current, comparison.modules), /Invalid archi report schema/);
});

test("retains a selected legacy v1 snapshot without rewriting its original identity", async (t) => {
  const { store, baseline, current } = await fixture(t);
  const legacy = stored(baseline);
  legacy.schema_version = 1;
  legacy.id = "old-saved-snapshot";
  delete (legacy as Partial<Snapshot>).digest;
  delete (legacy as Partial<Snapshot>).facts;
  delete (legacy as Partial<Snapshot>).evidenceLimitations;
  await store.rebuild(legacy, current, compareSnapshots(legacy, current).modules);
  const restored = await store.selectedBaseline();
  assert.equal(restored!.schema_version, 1);
  assert.equal(restored!.id, "old-saved-snapshot");
  assert.equal(restored!.digest, undefined);
  assert.deepEqual(restored!.modules, legacy.modules);
});

test("incomplete inputs cannot replace the last complete publication or its raw record", async (t) => {
  const { store, baseline, current, comparison } = await fixture(t);
  await store.rebuild(baseline, current, comparison.modules);
  const file = path.join(store.work, moduleReportName("child") + ".archi.yaml");
  const published = await readFile(file, "utf8");
  const rawBefore = await readdir(store.raw);
  const incomplete = { ...current, complete: false, diagnostics: ["Traversal stopped before the end."] };
  await assert.rejects(store.rebuild(baseline, incomplete, comparison.modules), /Cannot publish incomplete snapshot/);
  await assert.rejects(store.rebuild({ ...baseline, complete: false }, current, comparison.modules), /Cannot publish incomplete snapshot/);
  assert.equal(await readFile(file, "utf8"), published);
  assert.deepEqual(await readdir(store.raw), rawBefore);
});

test("keeps every real native attempt, stable order and import idempotence", async (t) => {
  const { store, snapshotStore, baseline, current, comparison } = await fixture(t);
  await store.rebuild(baseline, current, comparison.modules);
  const first = nativeReview(snapshotStore, baseline, current);
  const second = nativeReview(snapshotStore, baseline, current, "attempt-2");
  assert.equal(await store.saveReview(first), "attempt-1");
  assert.equal(await store.saveReview(second), "attempt-2");
  await store.saveReview(first);
  let history = await store.list();
  assert.deepEqual(history.entries.map((entry) => [entry.review_id, entry.registration_order]), [["attempt-1", 1], ["attempt-2", 2]]);
  for (const entry of history.entries) validateReviewEntry(entry);
  assert.equal(history.entries[0].current.scoped, true);
  assert.equal(history.entries[0].current.modules.some((module) => module.directory === "." && module.files.some((file) => file.path.endsWith("code.js"))), false);
  const changed = nativeReview(snapshotStore, baseline, current, "attempt-1", "child", "A different result with the same id.");
  await assert.rejects(store.saveReview(changed), /Review ID collision/);
  await store.rebuild(baseline, current, comparison.modules);
  history = await store.list();
  assert.deepEqual(history.entries.map((entry) => entry.review_id), ["attempt-1", "attempt-2"]);
  assert.deepEqual(history.diagnostics, []);
});

test("clone needs only project.json and work to retain proof and selected baseline", async (t) => {
  const { directory, root, store, snapshotStore, baseline, current, comparison } = await fixture(t);
  await store.rebuild(baseline, current, comparison.modules);
  await store.saveReview(nativeReview(snapshotStore, baseline, current));
  const cloneRoot = path.join(directory, "clone");
  await cp(root, cloneRoot, { recursive: true });
  await rm(path.join(cloneRoot, ".archiview/snapshots"), { recursive: true });
  const clonedSnapshots = new SnapshotStore(cloneRoot);
  const clonedStore = new ReportStore(clonedSnapshots);
  assert.deepEqual(await readPublishedSnapshots(clonedSnapshots), stored([baseline, current]));
  const actual = await captureWorkingTree(cloneRoot);
  assert.equal(actual.root, baseline.root);
  assert.equal(actual.digest, current.digest);
  await clonedStore.rebuild(await clonedStore.selectedBaseline(), actual, compareSnapshots(baseline, actual).modules);
  const history = await clonedStore.list();
  assert.deepEqual(history.entries.map((entry) => entry.review_id), ["attempt-1"]);
  validateReviewEntry(history.entries[0]);
  assert.deepEqual(history.diagnostics, []);
});

test("A to B to A keeps all attempts and deleted modules keep their complete history", async (t) => {
  const { root, store, snapshotStore, baseline, current, comparison } = await fixture(t);
  await store.rebuild(baseline, current, comparison.modules);
  await store.saveReview(nativeReview(snapshotStore, baseline, current, "at-A-first"));
  await writeFile(path.join(root, "child/code.js"), "export const read = () => 3;\n");
  const middle = await captureWorkingTree(root);
  await store.rebuild(baseline, middle, compareSnapshots(baseline, middle).modules);
  await store.saveReview(nativeReview(snapshotStore, baseline, middle, "at-B"));
  await writeFile(path.join(root, "child/code.js"), "export const read = () => 2;\n");
  const returned = await captureWorkingTree(root);
  await store.rebuild(baseline, returned, compareSnapshots(baseline, returned).modules);
  await store.saveReview(nativeReview(snapshotStore, baseline, returned, "at-A-again"));
  assert.deepEqual((await store.list()).entries.map((entry) => entry.review_id), ["at-A-first", "at-B", "at-A-again"]);
  await rm(path.join(root, "child"), { recursive: true });
  await writeModuleTree(root, { root: "." });
  await rm(path.join(root, ".archiview/modules/child.yaml"));
  const removed = await captureWorkingTree(root);
  await store.rebuild(baseline, removed, compareSnapshots(baseline, removed).modules);
  await store.rebuild(removed, removed, compareSnapshots(removed, removed).modules);
  assert.equal((await store.list()).entries.length, 3);
  assert.deepEqual(await store.selectedBaseline(), stored(removed));
  assert.deepEqual(await readPublishedSnapshots(snapshotStore), stored([removed, removed]));
});

test("migrates legacy LLM bundles once, preserves originals and excludes structure", async (t) => {
  const { store, snapshotStore, baseline, current, comparison } = await fixture(t);
  const legacy = new ReviewStore(snapshotStore);
  const child = comparison.modules.find((module) => module.moduleId === "child");
  const bundle = legacyReview(baseline, current, child!, "legacy-llm");
  await legacy.save(bundle);
  const structural = createStructuralReview(baseline, current, child!);
  await legacy.save(structural);
  const original = await readFile(path.join(legacy.pathFor(bundle.report.id), "review.yaml"), "utf8");
  await store.migrate();
  await store.migrate();
  const history = await store.list();
  assert.deepEqual(history.entries.map((entry) => entry.review_id), ["legacy-llm"]);
  assert.deepEqual(history.bundles[0], stored(bundle));
  assert.equal(await readFile(path.join(legacy.pathFor(bundle.report.id), "review.yaml"), "utf8"), original);
  await assert.rejects(store.saveReview(structural), /not an LLM review/);
});

test("migration compares the original v1 bundle when derived metadata changes between versions", async (t) => {
  const { store, snapshotStore, baseline, current, comparison } = await fixture(t);
  const bundle = legacyReview(baseline, current, comparison.modules.find((module) => module.moduleId === "child")!, "migrated-before-check-manifest");
  const oldEntry = createReviewEntry(bundle, { projectId: digest(snapshotStore.snapshotRoot) });
  delete oldEntry.check_manifest;
  oldEntry.project_id = null; // Прежний перенос ещё не вычислял идентичность проекта.
  const { content_digest, ...oldContent } = oldEntry;
  oldEntry.content_digest = digest(oldContent);
  validateReviewEntry(oldEntry);
  assert.notDeepEqual(oldEntry, createReviewEntry(bundle, { projectId: digest(snapshotStore.snapshotRoot) }));
  await store.saveReview(oldEntry);
  const originalEntry = (await store.list()).entries[0];
  await new ReviewStore(snapshotStore).save(bundle);
  await store.migrate();
  await store.rebuild(baseline, current, comparison.modules);
  await store.saveReview(bundle);
  assert.deepEqual((await store.list()).entries, [originalEntry]);
  const changed = stored(bundle);
  changed.report.assessment.current.summary = "A different original result.";
  await assert.rejects(store.saveReview(changed), /Review ID collision/);
});

test("serializes simultaneous writers and retains stable registration for tied timestamps", async (t) => {
  const { store, snapshotStore, baseline, current, comparison } = await fixture(t);
  await store.rebuild(baseline, current, comparison.modules);
  const other = new ReportStore(new SnapshotStore(snapshotStore.root));
  await Promise.all([store.saveReview(nativeReview(snapshotStore, baseline, current, "parallel-a")),
    other.saveReview(nativeReview(snapshotStore, baseline, current, "parallel-b"))]);
  const first = (await store.list()).entries.map((entry) => [entry.review_id, entry.registration_order]);
  assert.equal(first.length, 2);
  assert.deepEqual(new Set(first.map(([, order]) => order)), new Set([1, 2]));
  assert.deepEqual((await other.list()).entries.map((entry) => [entry.review_id, entry.registration_order]), first);
});

test("does not replace damaged published history and reports the exact failure", async (t) => {
  const { store, baseline, current, comparison } = await fixture(t);
  await store.rebuild(baseline, current, comparison.modules);
  const file = path.join(store.work, moduleReportName("child") + ".review.yaml");
  await writeFile(file, "schema_version: 999\nkind: review_history\nmodule_id: child\nentries: []\n");
  const before = await readFile(file, "utf8");
  assert.match((await store.list()).diagnostics.join("\n"), /Invalid review history schema/);
  await assert.rejects(store.rebuild(baseline, current, comparison.modules), /refusing to replace/);
  assert.equal(await readFile(file, "utf8"), before);
});

test("detects technical-state tampering and persists incomplete legacy-migration diagnostics", async (t) => {
  const { store, snapshotStore, baseline, current, comparison } = await fixture(t);
  await mkdir(path.join(snapshotStore.directory, "reviews/broken"), { recursive: true });
  await writeFile(path.join(snapshotStore.directory, "reviews/broken/review.yaml"), "broken: true\n");
  const result = await store.rebuild(baseline, current, comparison.modules);
  assert.match(result.diagnostics.join("\n"), /reviews\/broken/);
  await rm(path.join(snapshotStore.directory, "reviews"), { recursive: true });
  assert.match((await store.list()).diagnostics.join("\n"), /reviews\/broken/);
  const file = path.join(store.work, moduleReportName("child") + ".archi.yaml");
  const report = parseReportYaml<TechnicalReport>(await readFile(file, "utf8"));
  report.current!.self.own_files = [];
  await writeFile(file, stringify(report));
  assert.match((await store.list()).diagnostics.join("\n"), /Technical state digest mismatch/);
  await assert.rejects(store.rebuild(baseline, current, comparison.modules), /refusing to replace/);
});

test("recovers a committed directory replacement and an abandoned dead-process lock", async (t) => {
  const { store, baseline, current, comparison } = await fixture(t);
  await store.rebuild(baseline, current, comparison.modules);
  const id = randomUUID();
  const pending = ".publication-" + id, backup = ".previous-" + id;
  await cp(store.work, path.join(store.control, pending), { recursive: true });
  await rename(store.work, path.join(store.control, backup));
  await writeFile(path.join(store.control, ".publication.yaml"), stringify({ schema_version: 1, pending, backup }));
  await writeFile(path.join(store.control, ".report-store.lock"), JSON.stringify({ pid: 2147483647, token: "dead-owner" }));
  assert.equal(await createPublishedView({ root: store.root }), null);
  assert.ok((await readdir(store.control)).includes(".publication.yaml"));
  const result = await store.list();
  assert.equal(result.reports.length, 2);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(await store.selectedBaseline(), stored(baseline));
  assert.equal((await readdir(store.control)).some((name) => name === pending || name === backup || name === ".publication.yaml" || name === ".report-store.lock"), false);
});

test("an incomplete recovery staging never replaces the last valid work", async (t) => {
  const { store, baseline, current, comparison } = await fixture(t);
  await store.rebuild(baseline, current, comparison.modules);
  const fileName = moduleReportName("child") + ".archi.yaml";
  const original = await readFile(path.join(store.work, fileName), "utf8");
  const id = randomUUID(), pending = ".publication-" + id, backup = ".previous-" + id;
  await cp(store.work, path.join(store.control, pending), { recursive: true });
  await writeFile(path.join(store.control, pending, fileName), "partial: [\n");
  await rename(store.work, path.join(store.control, backup));
  await writeFile(path.join(store.control, ".publication.yaml"), stringify({ schema_version: 1, pending, backup }));
  await assert.rejects(store.list(), /refusing to replace/);
  assert.equal(await readFile(path.join(store.work, fileName), "utf8"), original);
});

test("managed ignore preserves user rules and strict YAML rejects ambiguous input", async (t) => {
  const { store, snapshotStore, baseline, current, comparison } = await fixture(t);
  await snapshotStore.ensureIdentity();
  const file = path.join(snapshotStore.directory, ".gitignore");
  await writeFile(file, "# My custom files\nlocal-secret.txt\n");
  await store.rebuild(baseline, current, comparison.modules);
  await store.rebuild(baseline, current, comparison.modules);
  const text = await readFile(file, "utf8");
  assert.ok(text.startsWith("# My custom files\nlocal-secret.txt\n"));
  assert.equal(text.match(/BEGIN ArchiView managed/g)!.length, 1);
  assert.ok(text.includes("/snapshots/\n"));
  assert.equal(text.includes("/work/"), false);
  for (const source of ["a: 1\na: 2\n", "a: &x [1]\nb: *x\n", "a: !test value\n", "1: value\n", "a: .inf\n", "a: 1\n---\nb: 2\n"]) assert.throws(() => parseReportYaml(source));
});
