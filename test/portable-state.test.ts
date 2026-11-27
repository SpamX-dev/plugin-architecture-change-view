import { initTestRepository } from "./support.js";
import { writeModuleTree } from "./support.js";
import type { ComparisonResponse, ModuleResponse } from "./support.js";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
/** Реальные файловые и Git-сценарии переносимой истории, миграции и исключения данных из анализа. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { createArchiView } from "../web/web-backend/web-service/http.js";
import { moduleInventory } from "../analyse/project-sources/inventory.js";
import { readSnapshotRoot } from "../storage/identity.js";
import { ReportStore } from "../analyse/module-review/report-store.js";
import { openProjectHistory } from "../analyse/module-review/legacy-history.js";
import { defaultSnapshotDirectory, SnapshotStore } from "../analyse/git-changes/snapshot-store.js";
import { captureGitHead, captureWorkingTree } from "../analyse/git-changes/capture.js";

/** Минимальный контракт фиксирует обязанности явно, независимо от расположения тестовой папки. */
const contract = (id: string) => ({ schema_version: 1, id, title: id, kind: "module",
  purpose: "Предоставлять значение.", boundaries: {}, invariants: {} });

/** Создаёт отдельный проект; все пути и процессы сценария принадлежат временному каталогу. */
async function fixture(t: TestContext) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "archiview-portable-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "original");
  await mkdir(path.join(root, "child"), { recursive: true });
  initTestRepository(root);
  await writeModuleTree(root, { root: ".", child: "child" });
  await writeFile(path.join(root, ".archiview/modules/root.yaml"), stringify(contract("root")));
  await writeFile(path.join(root, ".archiview/modules/child.yaml"), stringify(contract("child")));
  await writeFile(path.join(root, "child/code.js"), "export const read = () => 1;\n");
  return { root, temporary };
}

/** Запускает настоящий Git без оболочки; локальная тестовая identity не меняет настройки пользователя. */
function git(root: string, args: string[]) {
  return execFileSync("git", args, { cwd: root, windowsHide: true, encoding: "utf8" }).trim();
}
function initGit(root: string) {
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "archiview-test@example.invalid"]);
  git(root, ["config", "user.name", "ArchiView Test"]);
  git(root, ["config", "core.autocrlf", "false"]);
}

/** Поднимает проверяемый HTTP-сервер на отдельном порту и закрывает только его соединения. */
async function serve(t: TestContext, root: string) {
  const app = await createArchiView({ root });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  t.after(() => new Promise<void>((resolve) => { app.server.closeAllConnections(); app.server.close(() => resolve()); }));
  return { ...app, url: "http://127.0.0.1:" + (app.server.address() as AddressInfo).port };
}

for (const useGit of [false, true]) test(`local state is excluded from discovery and digests (${useGit ? "Git" : "filesystem"})`, async (t) => {
  const { root } = await fixture(t);
  if (useGit) initGit(root);
  const before = await captureWorkingTree(root);
  const store = new SnapshotStore(root);
  assert.equal(store.directory, path.join(root, ".archiview"));
  assert.equal(defaultSnapshotDirectory(root), store.directory);
  await store.save(before);
  await new ReportStore(store).rebuild(null, before);
  await writeFile(path.join(store.directory, "not-a-source.js"), "throw new Error('must not be analyzed');");
  if (useGit) { git(root, ["add", "."]); git(root, ["commit", "-qm", "Include portable history"]); }
  const inventory = await moduleInventory(root, { maxFiles: 3 });
  assert.equal(inventory.complete, true, JSON.stringify(inventory.diagnostics));
  assert.equal(inventory.modules.length, 2);
  assert.ok(inventory.modules.every((module) => !module.directory.includes(".archiview")));
  const after = await captureWorkingTree(root, { maxFiles: 3 });
  assert.equal(after.digest, before.digest);
  if (useGit) assert.equal((await captureGitHead(root))!.digest, before.digest);
  assert.equal(await readSnapshotRoot(root), root);
  assert.equal((await new ReportStore(store).publishedComparison())?.current.digest, before.digest);
});

test("Git clone retains both published snapshots, evidence and identity after the original path disappears", async (t) => {
  const { root, temporary } = await fixture(t);
  initGit(root); git(root, ["add", "."]); git(root, ["commit", "-qm", "First source version"]);
  const store = new SnapshotStore(root);
  const baseline = await store.save(await captureWorkingTree(root), "Original baseline");
  await writeFile(path.join(root, "child/code.js"), "export const read = () => 2;\n");
  const current = await captureWorkingTree(root);
  const reports = new ReportStore(store);
  await reports.rebuild(baseline, current);
  const originalPublication = await reports.publishedComparison();
  git(root, ["add", "."]); git(root, ["commit", "-qm", "Source and portable history"]);
  const clone = path.join(temporary, "relocated");
  git(temporary, ["-c", "core.autocrlf=false", "clone", "-q", root, clone]);
  await rm(root, { recursive: true, force: true });
  const app = await serve(t, clone);
  assert.equal(app.store.root, clone);
  assert.equal(app.store.snapshotRoot, root);
  assert.equal((await captureWorkingTree(clone)).digest, current.digest);
  const loaded = await app.reports.publishedComparison();
  assert.deepEqual(loaded, originalPublication);
  assert.equal(loaded?.current.digest, current.digest);
  assert.equal(loaded?.baseline?.digest, baseline.digest);
  const view = await ((await fetch(app.url + "/api/comparison?baseline=initial")).json() as Promise<ComparisonResponse>);
  assert.equal(view.root, clone);
  assert.equal(view.modules.find((item) => item.directory === ".")!.name, "relocated");
  assert.equal(view.modules.find((item) => item.moduleId === "child")!.reviewStatus!.self.current.status, "not_reviewed");
  assert.deepEqual(view.reviewDiagnostics, []);
  const detail = await ((await fetch(app.url + "/api/module?" + new URLSearchParams({ view: view.id, path: "child" }))).json() as Promise<ModuleResponse>);
  assert.equal(detail.reviews.length, 0);
  assert.ok(loaded!.current.facts.some(fact => fact.text.includes("() => 2")));
});

test("opening a previous state copies saved project snapshots and ignores old review packages", async t => {
  const { root, temporary } = await fixture(t);
  const legacy = new SnapshotStore(root, path.join(temporary, "previous"));
  const snapshot = await legacy.save(await captureWorkingTree(root), "Saved baseline");
  const oldReview = path.join(legacy.directory, "reviews", "unused");
  await mkdir(oldReview, {recursive:true});
  await writeFile(path.join(oldReview, "review.yaml"), "invalid old review");
  const {store, migration} = await openProjectHistory(root, undefined, legacy.directory);
  assert.ok(migration?.snapshots);
  assert.deepEqual((await store.list()).map(item => item.digest), [snapshot.digest]);
  await assert.rejects(readFile(path.join(store.directory, "reviews", "unused", "review.yaml")), {code:"ENOENT"});
  assert.deepEqual(await new ReportStore(store).readReviews(), []);
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
  await rename(path.join(root, ".archiview"), path.join(temporary, "original-metadata"));
  await symlink(destination, path.join(root, ".archiview"), process.platform === "win32" ? "junction" : "dir");
  const store = new SnapshotStore(root);
  await assert.rejects(store.list(), /directory links/);
  await assert.rejects(store.save(snapshot), /directory links/);
  await assert.rejects(new ReportStore(store).list(), /directory links/);
});

test("external state resolves nested pending paths against the selected physical directory", async (t) => {
  const { root, temporary } = await fixture(t);
  const state = path.join(temporary, "state"), sibling = path.join(temporary, "sibling");
  await mkdir(state); await mkdir(sibling);
  const alias = path.join(temporary, "state-alias");
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await symlink(state, alias, linkType);
  const store = new SnapshotStore(root, alias);
  await store.assertLocation(path.join(alias, "pending", "file"));
  await symlink(sibling, path.join(state, "redirected"), linkType);
  await assert.rejects(store.assertLocation(path.join(alias, "redirected", "pending", "file")), /outside external state storage/);
});
