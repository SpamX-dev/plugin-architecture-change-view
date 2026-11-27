import { initTestRepository } from "./support.js";
import { writeModuleTree } from "./support.js";
import type { ComparisonResponse, ModuleResponse } from "./support.js";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
/** Проверяет границы формата, идентичность, реальные доказательства и историю отчётов. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { digest } from "../framework/serialization/digest.js";
import { parseYaml } from "../framework/serialization/yaml.js";
import { contractDocument, currentContractYaml, validateArch } from "../framework/contracts/document.js";
import { validateReview } from "../framework/ai-report/schema.js";
import { moduleContext, moduleInventory } from "../analyse/project-sources/inventory.js";
import { captureWorkingTree } from "../analyse/git-changes/capture.js";
import { compareSnapshots } from "../analyse/git-changes/comparison.js";
import { createStructuralReview, validateReviewBundle } from "../analyse/module-review/bundle.js";
import { reviewIsStale } from "../analyse/module-review/freshness.js";
import { SnapshotStore } from "../analyse/git-changes/snapshot-store.js";
import { ReportStore } from "../analyse/module-review/report-store.js";
import { createArchiView } from "../web/web-backend/web-service/http.js";

/** Фикстура задаёт проверяемые обязанности явно, не выводя их из имени каталога. */
const contract = (id: string) => ({ schema_version: 1, id, title: "Контракт " + id, kind: "module",
  purpose: "Читать записи.",
  boundaries: { B1: "Не выполнять сетевые запросы." }, invariants: { I1: "Не изменять входные данные." } });

test("legacy R clauses are retained in sealed proofs and omitted from a current contract with purpose", () => {
  const current = contract("root");
  const original = { ...current, responsibilities: { R1: "Первая обязанность" } };
  const text = stringify(original).replaceAll("\n", "\r\n");
  assert.deepEqual(contractDocument(text).contract, current);
  assert.equal(contractDocument(text).text, text);
  assert.throws(() => parseYaml(text, validateArch), /responsibilities/);
  assert.deepEqual(contractDocument(text, "yaml", "legacy").contract, original);
  const { purpose, ...withoutPurpose } = original;
  assert.deepEqual(contractDocument(text, "yaml", "legacy-r").contract, withoutPurpose);
  const draft = currentContractYaml(stringify(withoutPurpose));
  assert.throws(() => parseYaml(draft, validateArch), /purpose/);
  const yaml = currentContractYaml(text);
  assert.deepEqual(parseYaml(yaml, validateArch), current);
  assert.ok(yaml.includes("\r\n"));
  assert.equal(currentContractYaml(yaml), yaml);
});

/** Каждый сценарий владеет временным проектом и внешним каталогом результатов. */
async function fixture(t: TestContext) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "archiview-v1-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "source");
  await mkdir(path.join(root, "child"), { recursive: true });
  initTestRepository(root);
  await writeModuleTree(root, { root: ".", child: "child" });
  await writeFile(path.join(root, ".archiview/modules/root.yaml"), stringify(contract("root")));
  await writeFile(path.join(root, ".archiview/modules/child.yaml"), stringify(contract("child")));
  await writeFile(path.join(root, "child/code.js"), "export const read = () => 1;\n");
  return { root, state: path.join(temporary, "state") };
}

test("rejects unknown fields, duplicate YAML keys, tags, aliases and invalid clause types", () => {
  assert.deepEqual(parseYaml(stringify(contract("root")), validateArch), contract("root"));
  for (const changed of [{ ...contract("root"), path: "." }, { ...contract("root"), responsibilities: {} },
    { ...contract("root"), boundaries: { B1: 12 } }, { ...contract("root"), owners: null },
    { ...contract("root"), extensions: { invalid: true } }]) assert.throws(() => validateArch(changed));
  assert.throws(() => parseYaml(stringify(contract("root")) + "id: duplicate\n", validateArch));
  assert.throws(() => parseYaml("x: &ref { a: 1 }\ny: *ref", validateArch));
  assert.throws(() => parseYaml("id: !custom root", validateArch));
  assert.equal(digest({ b: 1, a: 2, empty: undefined }), digest({ a: 2, b: 1 }));
});

test("inventory identifies missing contracts and diagnoses a contract id that differs from its mapped id", async (t) => {
  const { root } = await fixture(t);
  await mkdir(path.join(root, "legacy"));
  await writeFile(path.join(root, "legacy/module.md"), "# Назначение\nЧитать историю.");
  await mkdir(path.join(root, "missing"));
  await writeFile(path.join(root, "missing/code.js"), "export const value = 1;");
  let inventory = await moduleInventory(root);
  assert.ok(!inventory.modules.some((m) => m.directory === "legacy"));
  assert.equal(inventory.modules.find((m) => m.directory === "missing")!.preparation, "analyze_and_write");
  assert.deepEqual(inventory.modules.find((m) => m.directory === "missing")!.files, ["missing/code.js"]);
  await writeFile(path.join(root, ".archiview/modules/child.yaml"), stringify(contract("root")));
  inventory = await moduleInventory(root);
  assert.equal(inventory.modules.find((m) => m.directory === "child")?.status, "invalid");
  await writeFile(path.join(root, "child/module.md"), "Do not fall back to this text");
  await writeFile(path.join(root, ".archiview/modules/child.yaml"), "invalid: true");
  const context = await moduleContext(root, "child");
  assert.equal(context.contracts.at(-1)!.status, "invalid");
  assert.equal(context.contracts[0].contract!.id, "root");
});

test("stable ids preserve module identity across moves and initial analysis has no baseline", async (t) => {
  const { root } = await fixture(t);
  const before = await captureWorkingTree(root);
  await rename(path.join(root, "child"), path.join(root, "moved"));
  await writeModuleTree(root, { root: ".", child: "moved" });
  const after = await captureWorkingTree(root);
  const view = compareSnapshots(before, after);
  const moved = view.modules.find((m) => m.moduleId === "child");
  assert.equal(moved!.moved, true);
  assert.equal(moved!.baselinePath, "child");
  assert.equal(moved!.currentPath, "moved");
  assert.equal(view.modules.filter((m) => m.moduleId === "child").length, 1);
  assert.equal(createStructuralReview(before, after, moved!).report.module.id, "child");
  const initial = compareSnapshots(null, after);
  assert.ok(initial.modules.every((m) => m.status === "initial"));
  const bundle = createStructuralReview(null, after, initial.modules[0]);
  assert.equal(bundle.report.comparison.baseline, null);
  assert.equal(bundle.report.assessment.change.verdict, "not_applicable");
});

test("review schema requires string SHA-256 digests", async (t) => {
  const { root } = await fixture(t);
  const snapshot = await captureWorkingTree(root);
  const module = compareSnapshots(null, snapshot).modules[0];
  const { report } = createStructuralReview(null, snapshot, module);
  const { analysis } = report;
  assert.equal(validateReview(report), report);
  assert.throws(() => validateReview({ ...report, analysis: { ...analysis, input_digest: [analysis.input_digest] } }),
    /review\.analysis\.input_digest: ожидается sha256/);
  assert.throws(() => validateReview({ ...report, analysis: { ...analysis,
    analyzer: { ...analysis.analyzer, config_digest: [analysis.analyzer.config_digest] } } }),
    /review\.analysis\.analyzer\.config_digest: ожидается sha256/);
});

test("review evidence, checks and findings can only reference sides present in the comparison", async t => {
  const { root } = await fixture(t);
  const current = await captureWorkingTree(root);
  const { report } = createStructuralReview(null, current, compareSnapshots(null, current).modules[0]);
  const check = report.checks[0];
  const fact = { snapshot: "baseline" as const, fact_id: current.facts[0].id };
  const reject = (candidate: unknown) => assert.throws(() => validateReview(candidate), /отсутствующий базовый снимок/);
  reject({ ...report, checks: [{ ...check, verdict: "consistent", evidence: [fact] }] });
  reject({ ...report, checks: [{ ...check, subject: "baseline" }] });
  reject({ ...report, checks: [{ ...check, contract: { ...check.contract, snapshot: "baseline" } }] });
  reject({ ...report, observed: { ...report.observed, current: { summary: "Observation",
    responsibilities: [{ text: "Responsibility", evidence: [fact] }] } } });
  const finding = { id: "gap", kind: "responsibility_gap", certainty: "confirmed", severity: "warning",
    lifecycle: "unknown", summary: "Gap", clauses: [check.contract], evidence: [fact] };
  reject({ ...report, findings: [finding] });
  reject({ ...report, findings: [{ ...finding, evidence: [{ ...fact, snapshot: "current" }],
    clauses: [{ ...check.contract, snapshot: "baseline" }] }] });
  assert.equal(validateReview(report), report);
});

test("structural checks retain their own clauses and captured evidence", async (t) => {
  const { root } = await fixture(t);
  const before = await captureWorkingTree(root);
  await writeFile(path.join(root, ".archiview/modules/child.yaml"), stringify({ ...contract("child"), boundaries: { B1: "Не выполнять запись." } }));
  const after = await captureWorkingTree(root);
  const module = compareSnapshots(before, after).modules.find((m) => m.moduleId === "child");
  const bundle = createStructuralReview(before, after, module!);
  assert.equal(bundle.report.assessment.change.verdict, "inconclusive");
  assert.deepEqual(bundle.report.findings, [], "a contract diff does not create a finding");
  assert.equal(module!.documentChanged, true);
  assert.equal(bundle.manifest.contract_scope, "own");
  assert.ok(bundle.report.checks.length);
  assert.ok(bundle.report.checks.every((c) => c.contract.module_id === bundle.report.module.id));
  assert.ok(bundle.report.checks.every((c) => c.verdict === "not_checked"));
  const loaded = validateReviewBundle(bundle);
  assert.equal(reviewIsStale(loaded, before, after), false);
  await writeFile(path.join(root, "child/code.js"), "export const read = () => 2;\n");
  assert.equal(reviewIsStale(loaded, before, await captureWorkingTree(root)), true);
  assert.ok(loaded.current.facts.some((f) => f.text.includes("() => 1")));
  const broken = structuredClone(loaded);
  broken.report.checks[0].evidence = [{ snapshot: "current", fact_id: "missing" }];
  assert.throws(() => validateReviewBundle(broken), /Unresolved evidence/);
  const missingCheck = structuredClone(loaded);
  missingCheck.report.checks.pop();
  assert.throws(() => validateReviewBundle(missingCheck), /Missing explicit clause/);
  const unsupported = structuredClone(loaded.report);
  unsupported.checks[0].verdict = "consistent";
  assert.throws(() => validateReview(unsupported), /доказательства/);
  const tampered = structuredClone(loaded);
  tampered.current.facts[0].text += "tampered";
  assert.throws(() => validateReviewBundle(tampered), /digest mismatch/);
  const yaml = stringify(loaded.report);
  assert.ok(!yaml.includes("stale:"));
});

test("HTTP automatically checks structure without inventing a semantic review", async (t) => {
  const { root, state } = await fixture(t);
  const { server } = await createArchiView({ root, stateDirectory: state });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  assert.equal((await fetch(url + "/review.mjs")).status, 200);
  const view = await ((await fetch(url + "/api/comparison?baseline=initial")).json() as Promise<ComparisonResponse>);
  const result = await fetch(url + "/api/reviews", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ view: view.id, path: "child" }) });
  assert.equal(result.status, 200, JSON.stringify(await result.json()));
  let refreshed = await ((await fetch(url + "/api/comparison?baseline=initial")).json() as Promise<ComparisonResponse>);
  assert.equal(refreshed.modules.find((m) => m.directory === "child")!.structure!.automatic, true);
  assert.equal(refreshed.modules.find((m) => m.directory === "child")!.reviewStatus!.self.current.status, "not_reviewed");
  const detail = await ((await fetch(url + "/api/module?" + new URLSearchParams({ view: refreshed.id, path: "child" }))).json() as Promise<ModuleResponse>);
  assert.deepEqual(detail.reviews, []);
  assert.equal(detail.after!.document.contract!.id, "child");
  await writeFile(path.join(root, "child/code.js"), "changed");
  refreshed = await (await fetch(url + "/api/comparison?baseline=initial")).json();
  assert.equal(refreshed.modules.find((m) => m.directory === "child")!.reviewStatus!.self.current.status, "not_reviewed");
});

test("replacing an id at the same path yields distinct new and removed modules", async (t) => {
  const { root } = await fixture(t);
  const before = await captureWorkingTree(root);
  await rm(path.join(root, ".archiview/modules/child.yaml"));
  await writeModuleTree(root, { root: ".", replacement: "child" });
  await writeFile(path.join(root, ".archiview/modules/replacement.yaml"), stringify(contract("replacement")));
  const after = await captureWorkingTree(root);
  const replacements = compareSnapshots(before, after).modules.filter((m) => m.directory === "child");
  assert.deepEqual(replacements.map((m) => m.status).sort(), ["new", "removed"]);
  assert.equal(new Set(replacements.map((m) => m.key)).size, 2);
  for (const module of replacements) assert.ok(createStructuralReview(before, after, module));
});

test("external storage cannot resolve into project through a directory link", async (t) => {
  const { root, state } = await fixture(t);
  await symlink(root, state, process.platform === "win32" ? "junction" : "dir");
  const store = new SnapshotStore(root, state);
  await assert.rejects(store.list(), /inside source/);
  await assert.rejects(store.save(await captureWorkingTree(root)), /inside source/);
  await assert.rejects(new ReportStore(store).list(), /inside source/);
});
