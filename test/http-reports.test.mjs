/** Проверяет автоматическое построение отчёта через настоящий локальный HTTP-сервер. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify, parse } from "yaml";
import { createArchiView } from "../src/archiview/http.mjs";
import { createArchiViewSession } from "../src/application/session.mjs";
import { digest } from "../src/formats.mjs";
import { createReviewInput } from "../src/report-model.mjs";
import { captureWorkingTree } from "../src/snapshots.mjs";

/** Контракт и дерево принадлежат только этому тесту и удаляются после остановки сервера. */
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "archiview-auto-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contract = (id) => ({ schema_version: 1, id, title: id, kind: "module", purpose: "Предоставлять данные.",
    responsibilities: { R1: "Возвращать значение." }, boundaries: {}, invariants: {} });
  await mkdir(path.join(root, "child"));
  await writeFile(path.join(root, "arch.yaml"), stringify(contract("root")));
  await writeFile(path.join(root, "child/arch.yaml"), stringify(contract("child")));
  await writeFile(path.join(root, "child/code.js"), "export const value = 1;\n");
  return root;
}

/** Запускает отдельный порт; обработчики очистки закрывают только этот экземпляр. */
async function serve(t, root) {
  const app = await createArchiView({ root });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(() => new Promise((resolve) => { app.server.closeAllConnections(); app.server.close(resolve); }));
  return { ...app, url: "http://127.0.0.1:" + app.server.address().port };
}

/** Сравнивает реальные опубликованные байты, исключая порядок перечисления каталога. */
async function published(root) {
  const directory = path.join(root, ".archiview/work");
  const files = (await readdir(directory)).filter((file) => file.endsWith(".yaml")).sort();
  return Object.fromEntries(await Promise.all(files.map(async (file) => [file, await readFile(path.join(directory, file), "utf8")])));
}

/** Искусственная содержательная оценка проверяет доставку входов и статусов, а не смысл тестового кода. */
function fixtureReview(app, current, id, verdict = "consistent", dependencies = [], options = {}) {
  const input = createReviewInput(digest(app.store.snapshotRoot), null, current, id,
    { dependencies, dependencyCoverage: options.dependencyCoverage ?? { status: "complete", potential_influence: [] } });
  input.report.analysis.model = { provider: "test", id: "fixture" };
  input.report.analysis.prompt_digest = digest("Fixture review");
  input.manifest.model = input.report.analysis.model;
  input.manifest.prompt_digest = input.report.analysis.prompt_digest;
  input.report.analysis.input_digest = digest(input.manifest);
  input.report.analysis.coverage = options.coverage ?? { status: "complete", limitations: [] };
  input.report.assessment.current = { verdict, summary: "Fixture assessment: " + verdict };
  for (const check of input.report.checks) {
    check.verdict = verdict;
    check.evidence = [{ snapshot: check.subject, fact_id: input[check.subject].facts[0].id }];
  }
  return input;
}

test("startup and comparison compact structure without creating an LLM review", async (t) => {
  const root = await fixture(t);
  const app = await serve(t, root);
  const initialFiles = await published(root);
  assert.equal(Object.keys(initialFiles).filter((file) => file.endsWith(".archi.yaml")).length, 2);
  const firstResponse = await fetch(app.url + "/api/comparison");
  assert.equal(firstResponse.status, 200);
  const first = await firstResponse.json();
  const rootModule = first.modules.find((module) => module.moduleId === "root");
  assert.equal(rootModule.reviewStatus.self.current.status, "not_reviewed");
  assert.equal(rootModule.reviewStatus.subtree.current.status, "not_reviewed");
  assert.equal(rootModule.structure.automatic, true);
  assert.equal(rootModule.review, null);
  const before = await published(root);
  await fetch(app.url + "/api/comparison");
  assert.deepEqual(await published(root), before);
  const legacyAction = await fetch(app.url + "/api/reviews", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ view: first.id, path: "child" }) });
  assert.equal(legacyAction.status, 200);
  assert.equal((await app.reports.list()).entries.length, 0);
  await writeFile(path.join(root, "child/code.js"), "export const value = 2;\n");
  const changed = await (await fetch(app.url + "/api/comparison")).json();
  assert.equal(changed.before.id, first.before.id);
  const parent = changed.modules.find((module) => module.moduleId === "root");
  assert.equal(parent.status, "unchanged");
  assert.equal(parent.descendantChanges, 1);
  assert.equal(parent.reviewStatus.self.current.status, "not_reviewed");
  assert.notDeepEqual(await published(root), before);
  const detail = await (await fetch(app.url + "/api/module?" + new URLSearchParams({ view: changed.id, path: "child" }))).json();
  assert.equal(detail.structure.automatic, true);
  assert.deepEqual(detail.reviews, []);
});

test("a cached current view cannot republish its older snapshot over the work publication", async (t) => {
  const root = await fixture(t);
  const app = await serve(t, root);
  const first = await (await fetch(app.url + "/api/comparison")).json();
  await writeFile(path.join(root, "child/code.js"), "export const value = 2;\n");
  const latest = await (await fetch(app.url + "/api/comparison")).json();
  const before = await published(root);
  // Пересборка по устаревшему представлению отклоняется, и work сохраняет последнее состояние.
  const staleResponse = await fetch(app.url + "/api/reviews", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ view: first.id, path: "child" }) });
  const stale = await staleResponse.json();
  assert.equal(staleResponse.status, 409);
  assert.equal(stale.code, "STALE_VIEW");
  assert.deepEqual(await published(root), before);
  // Актуальное представление пересобирается идемпотентно: публикация не меняется.
  const freshResponse = await fetch(app.url + "/api/reviews", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ view: latest.id, path: "child" }) });
  assert.equal(freshResponse.status, 200);
  assert.deepEqual(await published(root), before);
});

test("missing contracts remain visible in automatic structure details", async (t) => {
  const root = await fixture(t);
  await rm(path.join(root, "child/arch.yaml"));
  const app = await serve(t, root);
  const response = await fetch(app.url + "/api/comparison?baseline=initial");
  assert.equal(response.status, 200);
  const view = await response.json();
  const detail = await (await fetch(app.url + "/api/module?" + new URLSearchParams({ view: view.id, path: "child" }))).json();
  assert.equal(detail.documentState, "missing");
  assert.equal(detail.structure.automatic, true);
  assert.equal(detail.after.document.state, "missing");
  assert.deepEqual(detail.reviews, []);
});

test("duplicate contract ids are structural diagnostics rather than a startup failure", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, "child/arch.yaml"), await readFile(path.join(root, "arch.yaml")));
  const app = await serve(t, root);
  const response = await fetch(app.url + "/api/comparison?baseline=initial");
  assert.equal(response.status, 200);
  const view = await response.json();
  assert.equal(view.modules.length, 2);
  assert.ok(view.modules.every((module) => module.documentState === "invalid"));
  const detail = await (await fetch(app.url + "/api/module?" + new URLSearchParams({ view: view.id, path: "child" }))).json();
  assert.ok(detail.after.document.errors.some((message) => message.includes("id")));
  assert.equal(detail.reviewStatus.self.current.status, "not_reviewed");
});

test("HTTP keeps parent self fresh while changed child invalidates subtree and preserves evidence", async (t) => {
  const root = await fixture(t);
  const app = await serve(t, root);
  const current = await captureWorkingTree(root);
  for (const id of ["root", "child"]) {
    await app.reports.saveReview(fixtureReview(app, current, id, "consistent",
      id === "root" ? [{ kind: "contract", module_id: "child" }] : []));
  }
  const read = async () => (await fetch(app.url + "/api/comparison?baseline=initial")).json();
  const checked = await read();
  assert.equal(checked.modules.find((module) => module.moduleId === "root").reviewStatus.subtree.current.status, "fresh");
  await writeFile(path.join(root, "child/code.js"), "export const value = 2;\n");
  const changed = await read();
  const parent = changed.modules.find((module) => module.moduleId === "root");
  const child = changed.modules.find((module) => module.moduleId === "child");
  assert.equal(parent.reviewStatus.self.current.status, "fresh");
  assert.equal(parent.reviewStatus.subtree.current.status, "stale");
  assert.equal(child.reviewStatus.self.current.status, "stale");
  const parentDetail = await (await fetch(app.url + "/api/module?" + new URLSearchParams({ view: changed.id, path: "." }))).json();
  assert.equal(parentDetail.reviews[0].dependencies[0].contractOnly, true);
  assert.equal(parentDetail.reviews[0].dependencies[0].providerStatus.status, "stale");
  const detail = await (await fetch(app.url + "/api/module?" + new URLSearchParams({ view: changed.id, path: "child" }))).json();
  assert.equal(detail.reviews[0].freshness.current.status, "stale");
  assert.ok(detail.reviews[0].facts.current.every((fact) => !fact.text.includes("value = 2")));
  const sameCodeNewBase = await (await fetch(app.url + "/api/comparison?" + new URLSearchParams({ baseline: checked.baselines.find((base) => base.kind === "change").id }))).json();
  const rootReview = sameCodeNewBase.modules.find((module) => module.moduleId === "root").reviewStatus.self;
  assert.equal(rootReview.current.status, "fresh");
  assert.equal(rootReview.change.status, "stale");
});

test("HTTP exposes matching inputs and dependency coverage independently without rewriting the review", async (t) => {
  const root = await fixture(t);
  const app = await serve(t, root);
  const current = await captureWorkingTree(root);
  const review = fixtureReview(app, current, "child", "violation", [], {
    dependencyCoverage: { status: "unknown", potential_influence: [{ scope: "project" }] },
    coverage: { status: "partial", limitations: ["Частичная проверка фикстуры."] },
  });
  await app.reports.saveReview(review);
  const response = await fetch(app.url + "/api/comparison?baseline=initial");
  const view = await response.json();
  const child = view.modules.find((module) => module.moduleId === "child");
  assert.equal(child.review.stale, false);
  assert.equal(child.review.activeFindings, 1, "a legacy violation remains an explicit open remark");
  assert.equal(child.reviewStatus.self.current.status, "fresh");
  assert.equal(child.reviewStatus.self.current.coverage.status, "partial");
  assert.equal(child.reviewStatus.self.current.current_violation, true);
  const detail = await (await fetch(app.url + "/api/module?" + new URLSearchParams({ view: view.id, path: "child" }))).json();
  assert.equal(detail.reviews[0].freshness.current.status, "fresh");
  assert.ok(detail.reviews[0].freshness.current.coverage.reasons.some((reason) => reason.code === "dependency_coverage_unknown"));
  assert.deepEqual(detail.reviews[0].report, review.report);
  await writeFile(path.join(root, "child/code.js"), "export const value = 2;\n");
  const changed = await (await fetch(app.url + "/api/comparison?baseline=initial")).json();
  const changedChild = changed.modules.find((module) => module.moduleId === "child");
  assert.equal(changedChild.reviewStatus.self.current.status, "stale");
  assert.equal(changedChild.reviewStatus.self.current.coverage.status, "partial");
});

test("HTTP separates open findings from resolved findings without changing the saved report", async (t) => {
  const root = await fixture(t);
  const app = await serve(t, root);
  const current = await captureWorkingTree(root);
  for (const [id, lifecycles] of [["root", ["resolved"]], ["child", ["introduced", "persisting", "resolved"]]]) {
    const review = fixtureReview(app, current, id);
    review.report.findings = lifecycles.map((lifecycle, index) => ({ id: "finding-" + index,
      kind: "responsibility_gap", severity: "warning", certainty: "confirmed", lifecycle,
      summary: "Замечание фикстуры.", clauses: [review.report.checks[0].contract], evidence: review.report.checks[0].evidence }));
    await app.reports.saveReview(review);
  }
  const view = await (await fetch(app.url + "/api/comparison?baseline=initial")).json();
  const parent = view.modules.find((module) => module.moduleId === "root");
  const child = view.modules.find((module) => module.moduleId === "child");
  assert.equal(parent.review.findings, 1);
  assert.equal(parent.review.activeFindings, 0);
  assert.equal(child.review.findings, 3);
  assert.equal(child.review.activeFindings, 2);
  const detail = await (await fetch(app.url + "/api/module?" + new URLSearchParams({ view: view.id, path: "child" }))).json();
  assert.deepEqual(detail.reviews[0].report.findings.map((finding) => finding.lifecycle), ["introduced", "persisting", "resolved"]);
  const saved = parse(await readFile(path.resolve(root, detail.reviews[0].reviewFile), "utf8"));
  assert.match(detail.reviews[0].reviewFile, /^\.archiview\/work\/[a-f0-9]{64}\.review\.yaml$/);
  assert.deepEqual(saved.entries.find((entry) => entry.review_id === detail.reviews[0].report.id).report,
    detail.reviews[0].report);
});

test("HTTP excludes legacy contract changes from remark counts while preserving saved history", async (t) => {
  const root = await fixture(t);
  const app = await serve(t, root);
  const current = await captureWorkingTree(root);
  const originals = new Map();
  for (const id of ["root", "child"]) {
    const review = fixtureReview(app, current, id);
    const legacy = { id: "contract-change", kind: "contract_change", certainty: "confirmed", severity: "info",
      lifecycle: "introduced", summary: "Изменился принятый контракт модуля.", clauses: [],
      evidence: review.report.checks[0].evidence };
    review.report.findings = [legacy];
    if (id === "child") review.report.findings.push({ ...legacy, id: "real-gap", kind: "responsibility_gap",
      severity: "warning", clauses: [review.report.checks[0].contract] });
    originals.set(id, structuredClone(review.report));
    await app.reports.saveReview(review);
  }
  const view = await (await fetch(app.url + "/api/comparison?baseline=initial")).json();
  for (const [id, count] of [["root", 0], ["child", 1]]) {
    const module = view.modules.find((item) => item.moduleId === id);
    assert.equal(module.review.findings, count);
    assert.equal(module.review.activeFindings, count);
    const detail = await (await fetch(app.url + "/api/module?" + new URLSearchParams({ view: view.id, path: module.directory }))).json();
    assert.deepEqual(detail.reviews[0].report, originals.get(id));
    const saved = parse(await readFile(path.resolve(root, detail.reviews[0].reviewFile), "utf8"));
    assert.deepEqual(saved.entries.find((entry) => entry.review_id === detail.review.id).report, originals.get(id));
  }
});

test("HTTP preserves conflicting attempts and reports both conflict and subtree coverage", async (t) => {
  const root = await fixture(t);
  const app = await serve(t, root);
  const current = await captureWorkingTree(root);
  const first = fixtureReview(app, current, "root");
  const second = fixtureReview(app, current, "root", "violation");
  await app.reports.saveReview(first);
  await app.reports.saveReview(second);
  const view = await (await fetch(app.url + "/api/comparison?baseline=initial")).json();
  const parent = view.modules.find((module) => module.moduleId === "root");
  assert.equal(parent.reviewStatus.self.current.conflict, true);
  assert.equal(parent.reviewStatus.self.current.verdict, "inconclusive");
  assert.equal(parent.reviewStatus.subtree.current.current_violation, true);
  assert.equal(parent.reviewStatus.subtree.current.status, "not_reviewed");
  const detail = await (await fetch(app.url + "/api/module?" + new URLSearchParams({ view: view.id, path: "." }))).json();
  assert.deepEqual(detail.reviews.map((entry) => entry.report.id), [second.report.id, first.report.id]);
  assert.equal(detail.reviews[0].reviewFile, detail.reviews[1].reviewFile);
  assert.equal(detail.review.id, second.report.id);
  assert.equal(detail.reviewStatus.self.conflict, true);
});

test("module detail points to the actual review file in an explicitly selected external store", async (t) => {
  const root = await fixture(t);
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "archiview-review-location-"));
  t.after(() => rm(stateDirectory, { recursive: true, force: true }));
  const session = await createArchiViewSession({ root, stateDirectory });
  const review = fixtureReview(session, await captureWorkingTree(root), "child");
  await session.reports.saveReview(review);
  const view = await session.getComparison({ baseline: "initial" });
  const detail = await session.getModule({ view: view.id, path: "child" });
  const file = path.resolve(root, detail.reviews[0].reviewFile);
  assert.equal(path.dirname(file), path.join(stateDirectory, "work"));
  assert.ok(!detail.reviews[0].reviewFile.includes("\\"));
  const saved = parse(await readFile(file, "utf8"));
  assert.deepEqual(saved.entries.find((entry) => entry.review_id === review.report.id).report, review.report);
});
