/** Проверяет границы формата, идентичность, реальные доказательства и историю отчётов. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { digest, parseYaml, validateArch, validateReview } from "../src/formats.mjs";
import { moduleContext, moduleInventory } from "../src/inventory.mjs";
import { captureWorkingTree, compareSnapshots } from "../src/snapshots.mjs";
import { createStructuralReview, reviewIsStale, validateReviewBundle } from "../src/reviews.mjs";
import { SnapshotStore } from "../src/snapshot-store.mjs";
import { ReviewStore, readReviewBundle } from "../src/review-store.mjs";
import { createArchiView } from "../src/archiview/http.mjs";

/** Фикстура задаёт проверяемые обязанности явно, не выводя их из имени каталога. */
const contract = (id) => ({ schema_version: 1, id, title: "Контракт " + id, kind: "module",
  purpose: "Предоставлять данные выбранного модуля.", responsibilities: { R1: "Читать записи." },
  boundaries: { B1: "Не выполнять сетевые запросы." }, invariants: { I1: "Не изменять входные данные." } });

/** Каждый сценарий владеет временным проектом и внешним каталогом результатов. */
async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "archiview-v1-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "source");
  await mkdir(path.join(root, "child"), { recursive: true });
  await writeFile(path.join(root, "arch.yaml"), stringify(contract("root")));
  await writeFile(path.join(root, "child/arch.yaml"), stringify(contract("child")));
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

test("inventory requires migration, analyzes missing contracts, and detects duplicate ids", async (t) => {
  const { root } = await fixture(t);
  await mkdir(path.join(root, "legacy"));
  await writeFile(path.join(root, "legacy/module.md"), "# Назначение\nЧитать историю.");
  await mkdir(path.join(root, "missing"));
  await writeFile(path.join(root, "missing/code.js"), "export const value = 1;");
  let inventory = await moduleInventory(root);
  assert.equal(inventory.modules.find((m) => m.directory === "legacy").status, "migration_required");
  assert.equal(inventory.modules.find((m) => m.directory === "missing").preparation, "analyze_and_write");
  assert.deepEqual(inventory.modules.find((m) => m.directory === "missing").files, ["missing/code.js"]);
  await writeFile(path.join(root, "child/arch.yaml"), stringify(contract("root")));
  inventory = await moduleInventory(root);
  assert.equal(inventory.modules.filter((m) => m.status === "invalid").length, 2);
  await writeFile(path.join(root, "child/module.md"), "Do not fall back to this text");
  await writeFile(path.join(root, "child/arch.yaml"), "invalid: true");
  const context = await moduleContext(root, "child");
  assert.equal(context.contracts.at(-1).status, "invalid");
  assert.equal(context.contracts[0].contract.id, "root");
});

test("stable ids preserve module identity across moves and initial analysis has no baseline", async (t) => {
  const { root } = await fixture(t);
  const before = await captureWorkingTree(root);
  await rename(path.join(root, "child"), path.join(root, "moved"));
  const after = await captureWorkingTree(root);
  const view = compareSnapshots(before, after);
  const moved = view.modules.find((m) => m.moduleId === "child");
  assert.equal(moved.moved, true);
  assert.equal(moved.baselinePath, "child");
  assert.equal(moved.currentPath, "moved");
  assert.equal(view.modules.filter((m) => m.moduleId === "child").length, 1);
  assert.equal(createStructuralReview(before, after, moved).report.module.id, "child");
  const initial = compareSnapshots(null, after);
  assert.ok(initial.modules.every((m) => m.status === "initial"));
  const bundle = createStructuralReview(null, after, initial.modules[0]);
  assert.equal(bundle.report.comparison.baseline, null);
  assert.equal(bundle.report.assessment.change.verdict, "not_applicable");
});

test("reviews retain old evidence, inherit constraints, remain immutable and become stale", async (t) => {
  const { root, state } = await fixture(t);
  const before = await captureWorkingTree(root);
  await writeFile(path.join(root, "child/arch.yaml"), stringify({ ...contract("child"), boundaries: { B1: "Не выполнять запись." } }));
  const after = await captureWorkingTree(root);
  const module = compareSnapshots(before, after).modules.find((m) => m.moduleId === "child");
  const bundle = createStructuralReview(before, after, module);
  assert.equal(bundle.report.assessment.change.verdict, "needs_review");
  assert.ok(bundle.report.checks.some((c) => c.contract.module_id === "root" && c.contract.section === "boundaries"));
  assert.ok(!bundle.report.checks.some((c) => c.contract.module_id === "root" && c.contract.section === "responsibilities"));
  assert.ok(bundle.report.checks.every((c) => c.verdict === "not_checked"));
  const store = new ReviewStore(new SnapshotStore(root, state));
  await store.save(bundle);
  await assert.rejects(store.save(bundle));
  const loaded = await readReviewBundle(store.pathFor(bundle.report.id));
  assert.equal(reviewIsStale(loaded, before, after), false);
  await writeFile(path.join(root, "child/code.js"), "export const read = () => 2;\n");
  assert.equal(reviewIsStale(loaded, before, await captureWorkingTree(root)), true);
  assert.ok(loaded.current.facts.some((f) => f.text.includes("() => 1")));
  const broken = structuredClone(loaded);
  broken.report.findings[0].evidence[0].fact_id = "missing";
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
  const yaml = await readFile(path.join(store.pathFor(bundle.report.id), "review.yaml"), "utf8");
  assert.ok(!yaml.includes("stale:"));
});

test("HTTP creates, displays and reloads a review with retained evidence and stale state", async (t) => {
  const { root, state } = await fixture(t);
  const { server } = await createArchiView({ root, stateDirectory: state });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));
  const url = "http://127.0.0.1:" + server.address().port;
  assert.equal((await fetch(url + "/review.mjs")).status, 200);
  const view = await (await fetch(url + "/api/comparison?baseline=initial")).json();
  const result = await fetch(url + "/api/reviews", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ view: view.id, path: "child" }) });
  assert.equal(result.status, 201, JSON.stringify(await result.json()));
  let refreshed = await (await fetch(url + "/api/comparison?baseline=initial")).json();
  assert.equal(refreshed.modules.find((m) => m.directory === "child").review.stale, false);
  const detail = await (await fetch(url + "/api/module?" + new URLSearchParams({ view: refreshed.id, path: "child" }))).json();
  assert.deepEqual(detail.reviews[0].facts.current, []);
  assert.equal(detail.after.document.contract.id, "child");
  await writeFile(path.join(root, "child/code.js"), "changed");
  refreshed = await (await fetch(url + "/api/comparison?baseline=initial")).json();
  assert.equal(refreshed.modules.find((m) => m.directory === "child").review.stale, true);
});

test("replacing an id at the same path yields distinct new and removed modules", async (t) => {
  const { root } = await fixture(t);
  const before = await captureWorkingTree(root);
  await writeFile(path.join(root, "child/arch.yaml"), stringify(contract("replacement")));
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
  await assert.rejects(new ReviewStore(store).list(), /inside source/);
});
