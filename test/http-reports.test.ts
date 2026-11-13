import { initTestRepository, commitTestFiles } from "./support.js";
import { writeModuleTree } from "./support.js";
import type { ComparisonResponse, ModuleResponse } from "./support.js";
import type { Snapshot } from "../src/snapshots/types.js";
import type { ReviewOptions } from "../src/reports/types.js";
import type { Coverage } from "../src/reviews/types.js";
import type { SnapshotStore } from "../src/storage/snapshot-store.js";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
/** Проверяет автоматическое построение отчёта через настоящий локальный HTTP-сервер. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify, parse } from "yaml";
import { createArchiView } from "../src/archiview/http.js";
import { createArchiViewSession } from "../src/application/session.js";
import { digest } from "../src/serialization/digest.js";
import { createReviewInput } from "../src/reports/review-input.js";
import { captureWorkingTree } from "../src/snapshots/capture.js";
import { savedClauseText, savedClauseMatchesContract } from "../web/archiview/contract.js";

/** Контракт и дерево принадлежат только этому тесту и удаляются после остановки сервера. */
async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "archiview-auto-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contract = (id: string) => ({ schema_version: 1, id, title: id, kind: "module", purpose: "Предоставлять данные.",
    responsibilities: { R1: "Возвращать значение." }, boundaries: {}, invariants: {} });
  await mkdir(path.join(root, "child"));
  initTestRepository(root);
  await writeModuleTree(root, { root: ".", child: "child" });
  await writeFile(path.join(root, ".archiview/modules/root.yaml"), stringify(contract("root")));
  await writeFile(path.join(root, ".archiview/modules/child.yaml"), stringify(contract("child")));
  await writeFile(path.join(root, "child/code.js"), "export const value = 1;\n");
  commitTestFiles(root);
  return root;
}

/** Запускает отдельный порт; обработчики очистки закрывают только этот экземпляр. */
async function serve(t: TestContext, root: string) {
  const app = await createArchiView({ root, publishOnOpen: true });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(() => new Promise<void>((resolve) => { app.server.closeAllConnections(); app.server.close(() => resolve()); }));
  return { ...app, url: "http://127.0.0.1:" + (app.server.address() as AddressInfo).port };
}

/** Сравнивает реальные опубликованные байты, исключая порядок перечисления каталога. */
async function published(root: string) {
  const directory = path.join(root, ".archiview/work");
  const files = (await readdir(directory)).filter((file) => file.endsWith(".yaml")).sort();
  return Object.fromEntries(await Promise.all(files.map(async (file) => [file, await readFile(path.join(directory, file), "utf8")])));
}

/** Искусственная содержательная оценка проверяет доставку входов и статусов, а не смысл тестового кода. */
function fixtureReview(app: { store: SnapshotStore }, current: Snapshot, id: string, verdict = "consistent", dependencies: NonNullable<ReviewOptions["dependencies"]> = [], options: ReviewOptions & { coverage?: Coverage } = {}) {
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
    check.evidence = [{ snapshot: check.subject, fact_id: input[check.subject]!.facts[0].id }];
  }
  return input;
}

test("own review exposes referenced ancestor clauses from their saved sides without extending its checklist", async (t) => {
  const root = await fixture(t);
  const file = path.join(root, ".archiview/modules/root.yaml");
  const previousContract = { ...parse(await readFile(file, "utf8")),
    boundaries: { B1: "Сохранённая прежняя граница." }, invariants: { I1: "Прежний инвариант." } };
  await writeFile(file, stringify(previousContract));
  const app = await serve(t, root);
  const baseline = await captureWorkingTree(root);
  const currentContract = { ...previousContract, boundaries: { B1: "Сохранённая проверенная граница.", B2: "Неиспользованная граница." },
    invariants: { I1: "Проверенный инвариант." } };
  await writeFile(file, stringify(currentContract));
  const current = await captureWorkingTree(root);
  const input = createReviewInput(digest(app.store.snapshotRoot), baseline, current, "child");
  input.report.analysis.model = input.manifest.model = { provider: "test", id: "ancestor-navigation-fixture" };
  input.report.analysis.prompt_digest = input.manifest.prompt_digest = digest("Native own ancestor clause projection fixture");
  input.report.analysis.input_digest = digest(input.manifest);
  const oldBoundary = { snapshot: "baseline", module_id: "root", section: "boundaries", id: "B1" } as const;
  const boundary = { ...oldBoundary, snapshot: "current" } as const;
  const invariant = { ...boundary, section: "invariants", id: "I1" } as const;
  input.report.findings = [{ id: "ancestor-boundary", kind: "boundary_violation", severity: "warning",
    certainty: "confirmed", lifecycle: "unknown", summary: "Fixture ancestor finding",
    clauses: [oldBoundary, boundary, invariant, boundary],
    evidence: [{ snapshot: "current", fact_id: input.current.facts[0].id }] }];
  const originalReport = structuredClone(input.report);
  const originalContracts = structuredClone(input.manifest.contracts);
  await app.reports.saveReview(input);

  async function detail() {
    const view = await ((await fetch(app.url + "/api/comparison")).json() as Promise<ComparisonResponse>);
    return (await fetch(app.url + "/api/module?" + new URLSearchParams({ view: view.id, path: "child" }))).json() as Promise<ModuleResponse>;
  }
  const review = (await detail()).reviews.find(review => review.report.id === input.review_id)!;
  assert.deepEqual(review.contracts, originalContracts);
  assert.ok(review.report.checks.every(check => check.contract.module_id === "child"));
  assert.deepEqual(review.referencedContracts, {
    baseline: [{ reference: oldBoundary, text: previousContract.boundaries.B1 }],
    current: [{ reference: boundary, text: currentContract.boundaries.B1 }, { reference: invariant, text: currentContract.invariants.I1 }],
  });
  assert.equal(savedClauseText(review, oldBoundary), previousContract.boundaries.B1);
  assert.equal(savedClauseText(review, boundary), currentContract.boundaries.B1);
  assert.equal(savedClauseText(review, invariant), currentContract.invariants.I1);
  assert.equal(savedClauseMatchesContract(review, boundary, currentContract), true);
  assert.equal(savedClauseMatchesContract(review, oldBoundary, currentContract), false);
  assert.equal(savedClauseText(review, { ...boundary, id: "B2" }), null);
  assert.equal(savedClauseText(review, { ...boundary, module_id: "child" }), null);
  assert.equal(savedClauseText(review, { ...boundary, section: "invariants" }), null);

  await writeFile(file, stringify({ ...currentContract, boundaries: { B1: "Позднейший изменяемый текст." } }));
  const historical = (await detail()).reviews.find(review => review.report.id === input.review_id)!;
  assert.deepEqual(historical.referencedContracts, review.referencedContracts);
  const stored = (await app.reports.list()).entries.find(entry => entry.review_id === input.review_id)!;
  assert.deepEqual(stored.report, originalReport);
  assert.deepEqual(stored.manifest.contracts, originalContracts);
});

test("the current tree is available independently of analysis and technical publication", async t => {
  const root = await fixture(t);
  const app = await serve(t, root);
  const original = await published(root);
  await writeFile(path.join(root, "child/code.js"), "export const value = 2;");
  const view = await app.getComparison();
  assert.equal(view.modules.find(m => m.moduleId === "child")?.status,"changed");
  assert.equal(view.modules.find(m => m.moduleId === "root")?.descendantChanges,1);
  assert.ok(view.modules.every(m => !m.reviewStatus));
  const result = await app.getReviewStatuses({view:view.id});
  assert.ok(result.modules.every(m => m.reviewStatus?.self.current.status === "not_reviewed"));
  assert.deepEqual(await published(root), original);
});

test("a cached current view cannot republish its older snapshot over the work publication", async (t) => {
  const root = await fixture(t);
  const app = await serve(t, root);
  const first = await ((await fetch(app.url + "/api/comparison")).json() as Promise<ComparisonResponse>);
  await writeFile(path.join(root, "child/code.js"), "export const value = 2;\n");
  const latest = await ((await fetch(app.url + "/api/comparison")).json() as Promise<ComparisonResponse>);
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
  assert.notDeepEqual(await published(root), before);
});

test("missing contracts remain visible in automatic structure details", async (t) => {
  const root = await fixture(t);
  await writeModuleTree(root, { root: "." });
  await rm(path.join(root, ".archiview/modules/child.yaml"));
  const app = await serve(t, root);
  const response = await fetch(app.url + "/api/comparison?baseline=initial");
  assert.equal(response.status, 200);
  const view = await (response.json() as Promise<ComparisonResponse>);
  const detail = await ((await fetch(app.url + "/api/module?" + new URLSearchParams({ view: view.id, path: "child" }))).json() as Promise<ModuleResponse>);
  assert.equal(detail.documentState, "missing");
  assert.equal(detail.structure!.automatic, true);
  assert.equal(detail.after!.document.state, "missing");
  assert.deepEqual(detail.reviews, []);
});

test("a contract whose id conflicts with its map entry has a structural diagnostic", async (t) => {
  const root = await fixture(t);
  await writeFile(path.join(root, ".archiview/modules/child.yaml"), await readFile(path.join(root, ".archiview/modules/root.yaml")));
  const app = await serve(t, root);
  const response = await fetch(app.url + "/api/comparison?baseline=initial");
  assert.equal(response.status, 200);
  const view = await (response.json() as Promise<ComparisonResponse>);
  assert.equal(view.modules.length, 2);
  assert.equal(view.modules.find((module) => module.directory === "child")?.documentState, "invalid");
  const detail = await ((await fetch(app.url + "/api/module?" + new URLSearchParams({ view: view.id, path: "child" }))).json() as Promise<ModuleResponse>);
  assert.ok(detail.after!.document.errors!.some((message) => message.includes("id")));
  assert.equal(detail.reviewStatus!.self.current.status, "not_reviewed");
});

test("HTTP keeps parent self fresh while changed child invalidates subtree and preserves evidence", async (t) => {
  const root = await fixture(t);
  const app = await serve(t, root);
  const current = (await app.reports.publishedComparison())!.current;
  for (const id of ["root", "child"]) {
    await app.reports.saveReview(fixtureReview(app, current, id, "consistent",
      id === "root" ? [{ kind: "contract", module_id: "child" }] : []));
  }
  const read = async () => ((await fetch(app.url + "/api/comparison?baseline=initial")).json() as Promise<ComparisonResponse>);
  const checked = await read();
  assert.equal(checked.modules.find((module) => module.moduleId === "root")!.reviewStatus!.subtree.current.status, "fresh");
  await writeFile(path.join(root, "child/code.js"), "export const value = 2;\n");
  const changed = await read();
  const parent = changed.modules.find((module) => module.moduleId === "root");
  const child = changed.modules.find((module) => module.moduleId === "child");
  assert.equal(parent!.reviewStatus!.self.current.status, "fresh");
  assert.equal(parent!.reviewStatus!.subtree.current.status, "stale");
  assert.equal(child!.reviewStatus!.self.current.status, "stale");
  const parentDetail = await ((await fetch(app.url + "/api/module?" + new URLSearchParams({ view: changed.id, path: "." }))).json() as Promise<ModuleResponse>);
  assert.deepEqual(parentDetail.reviews[0].dependencies, []);
  const detail = await ((await fetch(app.url + "/api/module?" + new URLSearchParams({ view: changed.id, path: "child" }))).json() as Promise<ModuleResponse>);
  assert.equal(detail.reviews[0].freshness.current.status, "stale");
  assert.ok(detail.reviews[0].facts.current.every((fact) => !fact.text.includes("value = 2")));
  const sameCodeNewBase = await ((await fetch(app.url + "/api/comparison?" + new URLSearchParams({ baseline: checked.baselines.find((base) => base.kind === "git")!.id }))).json() as Promise<ComparisonResponse>);
  const rootReview = sameCodeNewBase.modules.find((module) => module.moduleId === "root")!.reviewStatus!.self;
  assert.equal(rootReview.current.status, "fresh");
  assert.equal(rootReview.change.status, "stale");
});

test("HTTP exposes matching inputs and dependency coverage independently without rewriting the review", async (t) => {
  const root = await fixture(t);
  const app = await serve(t, root);
  const current = (await app.reports.publishedComparison())!.current;
  const review = fixtureReview(app, current, "child", "violation", [], {
    dependencyCoverage: { status: "unknown", potential_influence: [{ scope: "project" }] },
    coverage: { status: "partial", limitations: ["Частичная проверка фикстуры."] },
  });
  await app.reports.saveReview(review);
  const response = await fetch(app.url + "/api/comparison?baseline=initial");
  const view = await (response.json() as Promise<ComparisonResponse>);
  const child = view.modules.find((module) => module.moduleId === "child");
  assert.equal(child!.review!.stale, false);
  assert.equal(child!.review!.activeFindings, 1, "a legacy violation remains an explicit open remark");
  assert.equal(child!.reviewStatus!.self.current.status, "fresh");
  assert.equal(child!.reviewStatus!.self.current.coverage.status, "partial");
  assert.equal(child!.reviewStatus!.self.current.current_violation, true);
  const detail = await ((await fetch(app.url + "/api/module?" + new URLSearchParams({ view: view.id, path: "child" }))).json() as Promise<ModuleResponse>);
  assert.equal(detail.reviews[0].freshness.current.status, "fresh");
  assert.ok(detail.reviews[0].freshness.current.coverage.reasons!.some((reason) => reason.code === "dependency_tracking_disabled"));
  assert.deepEqual(detail.reviews[0].report, review.report);
  await writeFile(path.join(root, "child/code.js"), "export const value = 2;\n");
  const changed = await ((await fetch(app.url + "/api/comparison?baseline=initial")).json() as Promise<ComparisonResponse>);
  const changedChild = changed.modules.find((module) => module.moduleId === "child");
  assert.equal(changedChild!.reviewStatus!.self.current.status, "stale");
  assert.equal(changedChild!.reviewStatus!.self.current.coverage.status, "partial");
});

test("HTTP separates open findings from resolved findings without changing the saved report", async (t) => {
  const root = await fixture(t);
  const app = await serve(t, root);
  const current = (await app.reports.publishedComparison())!.current;
  for (const [id, lifecycles] of [["root", ["resolved"]], ["child", ["introduced", "persisting", "resolved"]]] as [string, string[]][]) {
    const review = fixtureReview(app, current, id);
    review.report.findings = lifecycles.map((lifecycle, index) => ({ id: "finding-" + index,
      kind: "responsibility_gap", severity: "warning", certainty: "confirmed", lifecycle,
      summary: "Замечание фикстуры.", clauses: [review.report.checks[0].contract], evidence: review.report.checks[0].evidence }));
    await app.reports.saveReview(review);
  }
  const view = await ((await fetch(app.url + "/api/comparison?baseline=initial")).json() as Promise<ComparisonResponse>);
  const parent = view.modules.find((module) => module.moduleId === "root");
  const child = view.modules.find((module) => module.moduleId === "child");
  assert.equal(parent!.review!.findings, 1);
  assert.equal(parent!.review!.activeFindings, 0);
  assert.equal(child!.review!.findings, 3);
  assert.equal(child!.review!.activeFindings, 2);
  const detail = await ((await fetch(app.url + "/api/module?" + new URLSearchParams({ view: view.id, path: "child" }))).json() as Promise<ModuleResponse>);
  assert.deepEqual(detail.reviews[0].report.findings.map((finding) => finding.lifecycle), ["introduced", "persisting", "resolved"]);
  const saved = parse(await readFile(path.resolve(root, detail.reviews[0].reviewFile), "utf8"));
  assert.match(detail.reviews[0].reviewFile, /^\.archiview\/work\/[a-f0-9]{64}\.review\.yaml$/);
  assert.deepEqual(saved.entries.find((entry: {review_id:string;report:unknown}) => entry.review_id === detail.reviews[0].report.id).report,
    detail.reviews[0].report);
});

test("HTTP excludes legacy contract changes from remark counts while preserving saved history", async (t) => {
  const root = await fixture(t);
  const app = await serve(t, root);
  const current = (await app.reports.publishedComparison())!.current;
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
  const view = await ((await fetch(app.url + "/api/comparison?baseline=initial")).json() as Promise<ComparisonResponse>);
  for (const [id, count] of [["root", 0], ["child", 1]]) {
    const module = view.modules.find((item) => item.moduleId === id);
    assert.equal(module!.review!.findings, count);
    assert.equal(module!.review!.activeFindings, count);
    const detail = await ((await fetch(app.url + "/api/module?" + new URLSearchParams({ view: view.id, path: module!.directory }))).json() as Promise<ModuleResponse>);
    assert.deepEqual(detail.reviews[0].report, originals.get(id));
    const saved = parse(await readFile(path.resolve(root, detail.reviews[0].reviewFile), "utf8"));
    assert.deepEqual(saved.entries.find((entry: { review_id: string; report: unknown }) => entry.review_id === detail.review!.id).report, originals.get(id));
  }
});

test("HTTP preserves conflicting attempts and reports both conflict and subtree coverage", async (t) => {
  const root = await fixture(t);
  const app = await serve(t, root);
  const current = (await app.reports.publishedComparison())!.current;
  const first = fixtureReview(app, current, "root");
  const second = fixtureReview(app, current, "root", "violation");
  await app.reports.saveReview(first);
  await app.reports.saveReview(second);
  const view = await ((await fetch(app.url + "/api/comparison?baseline=initial")).json() as Promise<ComparisonResponse>);
  const parent = view.modules.find((module) => module.moduleId === "root");
  assert.equal(parent!.reviewStatus!.self.current.conflict, true);
  assert.equal(parent!.reviewStatus!.self.current.verdict, "inconclusive");
  assert.equal(parent!.reviewStatus!.subtree.current.current_violation, true);
  assert.equal(parent!.reviewStatus!.subtree.current.status, "not_reviewed");
  const detail = await ((await fetch(app.url + "/api/module?" + new URLSearchParams({ view: view.id, path: "." }))).json() as Promise<ModuleResponse>);
  assert.deepEqual(detail.reviews.map((entry) => entry.report.id), [second.report.id, first.report.id]);
  assert.equal(detail.reviews[0].reviewFile, detail.reviews[1].reviewFile);
  assert.equal(detail.review!.id, second.report.id);
  assert.equal(detail.reviewStatus!.self.conflict, true);
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
  assert.deepEqual(saved.entries.find((entry: { review_id: string; report: unknown }) => entry.review_id === review.report.id).report, review.report);
});
