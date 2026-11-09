/** Переносимость, неизменность реальных попыток и восстановление публикаций v2. */
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { stringify } from "yaml";
import { digest } from "../src/formats.mjs";
import { captureWorkingTree, compareSnapshots } from "../src/snapshots.mjs";
import { SnapshotStore } from "../src/snapshot-store.mjs";
import { ReviewStore } from "../src/review-store.mjs";
import { createStructuralReview } from "../src/reviews.mjs";
import { createReviewInput, createReviewEntry, validateReviewEntry } from "../src/report-model.mjs";
import { ReportStore, moduleReportName, parseReportYaml, readPublishedSnapshots } from "../src/report-store.mjs";

const stored = (value) => JSON.parse(JSON.stringify(value));

/** Каждый тест владеет своими исходниками, состоянием и копиями проекта. */
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "archiview-report-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "source");
  await mkdir(path.join(root, "child"), { recursive: true });
  const contract = (id) => ({ schema_version: 1, id, title: id, kind: "module", purpose: "Читать собственные записи.",
    responsibilities: { R1: "Возвращать записи." }, boundaries: { B1: "Не обращаться к сети." }, invariants: {} });
  await writeFile(path.join(root, "arch.yaml"), stringify(contract("root")));
  await writeFile(path.join(root, "child/arch.yaml"), stringify(contract("child")));
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
function nativeReview(snapshotStore, baseline, current, id = "attempt-1", moduleId = "child", summary) {
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
function legacyReview(baseline, current, module, id) {
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

test("retains a selected legacy v1 snapshot without rewriting its original identity", async (t) => {
  const { store, baseline, current } = await fixture(t);
  const legacy = stored(baseline);
  legacy.schema_version = 1;
  legacy.id = "old-saved-snapshot";
  delete legacy.digest;
  delete legacy.facts;
  delete legacy.evidenceLimitations;
  await store.rebuild(legacy, current, compareSnapshots(legacy, current).modules);
  const restored = await store.selectedBaseline();
  assert.equal(restored.schema_version, 1);
  assert.equal(restored.id, "old-saved-snapshot");
  assert.equal(restored.digest, undefined);
  assert.deepEqual(restored.modules, legacy.modules);
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
  const bundle = legacyReview(baseline, current, child, "legacy-llm");
  await legacy.save(bundle);
  const structural = createStructuralReview(baseline, current, child);
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
  const bundle = legacyReview(baseline, current, comparison.modules.find((module) => module.moduleId === "child"), "migrated-before-check-manifest");
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
  const report = parseReportYaml(await readFile(file, "utf8"));
  report.current.self.own_files = [];
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
  assert.equal(text.match(/BEGIN ArchiView managed/g).length, 1);
  assert.ok(text.includes("/snapshots/\n"));
  assert.equal(text.includes("/work/"), false);
  for (const source of ["a: 1\na: 2\n", "a: &x [1]\nb: *x\n", "a: !test value\n", "1: value\n", "a: .inf\n", "a: 1\n---\nb: 2\n"]) assert.throws(() => parseReportYaml(source));
});
