/** Реальные файловые и Git-сценарии переносимой истории, миграции и исключения данных из анализа. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { createArchiView } from "../src/archiview/http.mjs";
import { moduleInventory } from "../src/inventory.mjs";
import { readSnapshotRoot } from "../src/project-state.mjs";
import { readReviewBundle, ReviewStore } from "../src/review-store.mjs";
import { createStructuralReview, reviewIsStale } from "../src/reviews.mjs";
import { defaultSnapshotDirectory, SnapshotStore } from "../src/snapshot-store.mjs";
import { captureGitHead, captureWorkingTree, compareSnapshots } from "../src/snapshots.mjs";

/** Минимальный контракт фиксирует обязанности явно, независимо от расположения тестовой папки. */
const contract = (id) => ({ schema_version: 1, id, title: id, kind: "module", purpose: "Читать данные.",
  responsibilities: { R1: "Предоставлять значение." }, boundaries: {}, invariants: {} });

/** Создаёт отдельный проект; все пути и процессы сценария принадлежат временному каталогу. */
async function fixture(t) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "archiview-portable-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "original");
  await mkdir(path.join(root, "child"), { recursive: true });
  await writeFile(path.join(root, "arch.yaml"), stringify(contract("root")));
  await writeFile(path.join(root, "child/arch.yaml"), stringify(contract("child")));
  await writeFile(path.join(root, "child/code.js"), "export const read = () => 1;\n");
  return { root, temporary };
}

/** Запускает настоящий Git без оболочки; локальная тестовая identity не меняет настройки пользователя. */
function git(root, args) {
  return execFileSync("git", args, { cwd: root, windowsHide: true, encoding: "utf8" }).trim();
}
function initGit(root) {
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "archiview-test@example.invalid"]);
  git(root, ["config", "user.name", "ArchiView Test"]);
  git(root, ["config", "core.autocrlf", "false"]);
}

/** Поднимает проверяемый HTTP-сервер на отдельном порту и закрывает только его соединения. */
async function serve(t, root) {
  const app = await createArchiView({ root });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  t.after(() => new Promise((resolve) => { app.server.closeAllConnections(); app.server.close(resolve); }));
  return { ...app, url: "http://127.0.0.1:" + app.server.address().port };
}

for (const useGit of [false, true]) test(`local state is excluded from discovery and digests (${useGit ? "Git" : "filesystem"})`, async (t) => {
  const { root } = await fixture(t);
  if (useGit) initGit(root);
  const before = await captureWorkingTree(root);
  const store = new SnapshotStore(root);
  assert.equal(store.directory, path.join(root, ".archiview"));
  assert.equal(defaultSnapshotDirectory(root), store.directory);
  await store.save(before);
  const review = createStructuralReview(null, before, compareSnapshots(null, before).modules[0]);
  await new ReviewStore(store).save(review);
  await writeFile(path.join(store.directory, "not-a-source.js"), "throw new Error('must not be analyzed');");
  if (useGit) { git(root, ["add", "."]); git(root, ["commit", "-qm", "Include portable history"]); }
  const inventory = await moduleInventory(root, { maxFiles: 3 });
  assert.equal(inventory.complete, true, JSON.stringify(inventory.diagnostics));
  assert.equal(inventory.modules.length, 2);
  assert.ok(inventory.modules.every((module) => !module.directory.includes(".archiview")));
  const after = await captureWorkingTree(root, { maxFiles: 3 });
  assert.equal(after.digest, before.digest);
  if (useGit) assert.equal((await captureGitHead(root)).digest, before.digest);
  assert.equal(await readSnapshotRoot(root), root);
  assert.equal((await new ReviewStore(store).list()).bundles.length, 1);
});

test("Git clone retains report bytes, evidence, identity and freshness after the original path disappears", async (t) => {
  const { root, temporary } = await fixture(t);
  initGit(root); git(root, ["add", "."]); git(root, ["commit", "-qm", "First source version"]);
  const store = new SnapshotStore(root);
  const baseline = await store.save(await captureWorkingTree(root), "Original baseline");
  await writeFile(path.join(root, "child/code.js"), "export const read = () => 2;\n");
  const current = await captureWorkingTree(root);
  const module = compareSnapshots(baseline, current).modules.find((item) => item.moduleId === "child");
  const bundle = createStructuralReview(baseline, current, module);
  const reviews = new ReviewStore(store);
  await reviews.save(bundle);
  const originalYaml = await readFile(path.join(reviews.pathFor(bundle.report.id), "review.yaml"));
  git(root, ["add", "."]); git(root, ["commit", "-qm", "Source and portable history"]);
  const clone = path.join(temporary, "relocated");
  git(temporary, ["-c", "core.autocrlf=false", "clone", "-q", root, clone]);
  await rm(root, { recursive: true, force: true });
  const app = await serve(t, clone);
  assert.equal(app.store.root, clone);
  assert.equal(app.store.snapshotRoot, root);
  assert.equal((await captureWorkingTree(clone)).digest, current.digest);
  const loadedYaml = await readFile(path.join(app.reviews.pathFor(bundle.report.id), "review.yaml"));
  assert.deepEqual(loadedYaml, originalYaml);
  const loaded = await readReviewBundle(app.reviews.pathFor(bundle.report.id));
  assert.equal(loaded.report.id, bundle.report.id);
  assert.equal(reviewIsStale(loaded, (await app.store.list()).find((item) => item.id === baseline.id), await captureWorkingTree(clone)), false);
  const view = await (await fetch(app.url + "/api/comparison?baseline=" + baseline.id)).json();
  assert.equal(view.root, clone);
  assert.equal(view.modules.find((item) => item.directory === ".").name, "relocated");
  assert.equal(view.modules.find((item) => item.moduleId === "child").reviewStatus.self.current.status, "not_reviewed");
  assert.deepEqual(view.reviewDiagnostics, []);
  const detail = await (await fetch(app.url + "/api/module?" + new URLSearchParams({ view: view.id, path: "child" }))).json();
  assert.equal(detail.reviews.length, 0);
  assert.ok(loaded.current.facts.some((fact) => fact.text.includes("() => 2")));
  await assert.rejects(app.reviews.save(loaded));
  await writeFile(path.join(clone, "child/code.js"), "export const read = () => 3;\n");
  const changed = await captureWorkingTree(clone);
  assert.equal(reviewIsStale(loaded, loaded.baseline, changed), true);
  const next = createStructuralReview(loaded.baseline, changed, compareSnapshots(loaded.baseline, changed).modules.find((item) => item.moduleId === "child"));
  await app.reviews.save(next);
  assert.equal((await app.reviews.list()).bundles.length, 2);
  assert.deepEqual(await readFile(path.join(app.reviews.pathFor(bundle.report.id), "review.yaml")), originalYaml);
  const broken = structuredClone(loaded.current);
  broken.facts[0].text += "tampered";
  await writeFile(path.join(app.reviews.pathFor(bundle.report.id), "current.json"), JSON.stringify(broken));
  assert.equal((await app.reviews.list()).diagnostics.length, 1);
});

test("legacy migration copies complete immutable bundles and keeps the old storage intact", async (t) => {
  const { root, temporary } = await fixture(t);
  const legacy = new SnapshotStore(root, path.join(temporary, "legacy"));
  const snapshot = await legacy.save(await captureWorkingTree(root), "Legacy baseline");
  const bundle = createStructuralReview(null, snapshot, compareSnapshots(null, snapshot).modules[0]);
  const oldReviews = new ReviewStore(legacy);
  await oldReviews.save(bundle);
  // Старое размещение не содержало манифеста происхождения.
  await rm(path.join(legacy.directory, "project.json"));
  const oldFiles = ["review.yaml", "input.json", "current.json"];
  const bytes = await Promise.all(oldFiles.map((file) => readFile(path.join(oldReviews.pathFor(bundle.report.id), file))));
  const local = new SnapshotStore(root, undefined, { legacyDirectory: legacy.directory });
  await local.open();
  assert.deepEqual(local.migration, { from: legacy.directory, snapshots: 1, reviews: 1 });
  assert.equal((await local.list())[0].digest, snapshot.digest);
  const imported = new ReviewStore(local);
  assert.equal((await imported.list()).bundles[0].report.id, bundle.report.id);
  for (let i = 0; i < oldFiles.length; i++) {
    assert.deepEqual(await readFile(path.join(imported.pathFor(bundle.report.id), oldFiles[i])), bytes[i]);
    assert.deepEqual(await readFile(path.join(oldReviews.pathFor(bundle.report.id), oldFiles[i])), bytes[i]);
  }
  assert.equal(await readSnapshotRoot(root), root);
  const again = new SnapshotStore(root, undefined, { legacyDirectory: legacy.directory });
  await again.open(); assert.equal(again.migration, null);
});

test("concurrent local reviews publish one complete project identity", async (t) => {
  const { root } = await fixture(t);
  const snapshot = await captureWorkingTree(root);
  const module = compareSnapshots(null, snapshot).modules[0];
  await Promise.all(Array.from({ length: 6 }, () => {
    const store = new ReviewStore(new SnapshotStore(root));
    return store.save(createStructuralReview(null, snapshot, module));
  }));
  assert.equal(await readSnapshotRoot(root), root);
  const history = await new ReviewStore(new SnapshotStore(root)).list();
  assert.equal(history.bundles.length, 6);
  assert.deepEqual(history.diagnostics, []);
});

test("relative state paths resolve under root and arbitrary source storage remains forbidden", async (t) => {
  const { root } = await fixture(t);
  const store = new SnapshotStore(root, ".archiview/history");
  assert.equal(store.directory, path.join(root, ".archiview", "history"));
  await store.save(await captureWorkingTree(root));
  assert.equal((await store.list()).length, 1);
  assert.throws(() => new SnapshotStore(root, "child/reports"), /under .archiview/);
  assert.throws(() => new SnapshotStore(root, root), /under .archiview/);
});

for (const target of ["source", "external"]) test(`local state rejects a directory link to ${target}`, async (t) => {
  const { root, temporary } = await fixture(t);
  const snapshot = await captureWorkingTree(root);
  const destination = target === "source" ? path.join(root, "child") : path.join(temporary, "external");
  await mkdir(destination, { recursive: true });
  await symlink(destination, path.join(root, ".archiview"), process.platform === "win32" ? "junction" : "dir");
  const store = new SnapshotStore(root);
  await assert.rejects(store.list(), /directory links/);
  await assert.rejects(store.save(snapshot), /directory links/);
  await assert.rejects(new ReviewStore(store).list(), /directory links/);
});
