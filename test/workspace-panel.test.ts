import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { ComparisonView, ModuleDetail, PreparedAnalysis, TimelineEntry } from "../src/application/api.js";
import { createArchiViewSession } from "../src/application/session.js";
import { createWorkspaceSession } from "../src/application/workspace-session.js";
import { createArchiViewHttpServer } from "../src/archiview/http.js";
import { createCodexPanel } from "../src/codex/panel.js";
import { createRouteTable } from "../src/dsh/routes.js";
import { contractYaml, uiData, writeModuleTree } from "./support.js";

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, windowsHide: true, stdio: "pipe" });
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "archiview-workspace-panel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const a = path.join(root, "a"), b = path.join(root, "b");
  await writeModuleTree(a, { shared: "." });
  await writeFile(path.join(a, ".archiview/modules/shared.yaml"), contractYaml("shared"));
  await writeFile(path.join(a, ".archiview/project.json"), JSON.stringify({ schema_version: 1, snapshot_root: a }));
  await writeFile(path.join(a, "index.js"), "export const v = 1;\n");
  git(a, "init", "-q");
  git(a, "add", ".");
  git(a, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Initial");
  git(root, "clone", "-q", a, b);
  return { root, a, b };
}

test("Codex can open checkout B's published tree and card while checkout A is refreshing", { timeout: 15000 }, async (t) => {
  const { root } = await fixture(t);
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { entered = resolve; });
  let readStarted = false;
  const panel = createCodexPanel({ root, async select(_requested, metadata) {
    if (metadata?.refreshing) { entered(); await blocked; }
    if (metadata?.reading) readStarted = true;
    return root;
  } });
  t.after(() => panel.close());
  const call = (name: string, args: Record<string, unknown>, metadata?: Record<string, unknown>) =>
    panel.callUi("archiview_ui_" + name, args, metadata);
  uiData(await call("get_comparison", { repository: "b" }));
  const refresh = call("get_comparison", { repository: "a" }, { refreshing: true });
  try {
    await started;
    const published = call("get_comparison", { repository: "b", published: true }, { reading: true });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(readStarted, true, "the published comparison must pass the pending refresh");
    const view = uiData<ComparisonView>(await published);
    assert.equal(view.published, true);
    assert.equal(view.workspace?.repository, "b");
    readStarted = false;
    const detail = call("get_module", { repository: "b", view: view.id, path: "." }, { reading: true });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(readStarted, true, "the module must pass the pending refresh");
    assert.equal(uiData<ModuleDetail>(await detail).moduleId, "shared");
  } finally { release(); await refresh; }
});

async function listen(t: TestContext, server: Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  return "http://127.0.0.1:" + (server.address() as AddressInfo).port;
}

async function json<T>(url: string, expectedStatus = 200, body?: Record<string, unknown>): Promise<T> {
  const response = await fetch(url, body && { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const value = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(value));
  return value as T;
}

test("opening a checkout serves its published tree and card even when its raw archives are unavailable", async (t) => {
  const { root, a, b } = await fixture(t);
  const publisher = await createWorkspaceSession({ root });
  for (const repository of ["a", "b"]) {
    const first = await publisher.getComparison({ repository, published: true, baseline: "auto" });
    assert.equal(first.published, undefined, "a checkout without work must serve a live result");
    const work = path.join(root, repository, ".archiview", "work");
    const technical = (await readdir(work)).find(name => name.endsWith(".archi.yaml"))!;
    assert.match(await readFile(path.join(work, technical), "utf8"), /generation: 1\b/);
  }
  const work = path.join(a, ".archiview", "work");
  const files = await readdir(work);
  const publicationTimes = () => Promise.all(files.map(async file => (await stat(path.join(work, file))).mtimeMs));
  const before = await publicationTimes();
  // The checkout has moved on since publication and the raw archives cannot be traversed.
  await writeFile(path.join(a, ".archiview/modules/shared.yaml"), contractYaml("shared", "New local purpose."));
  await writeFile(path.join(b, ".archiview/modules/shared.yaml"), contractYaml("shared", "Other local purpose."));
  for (const name of ["changes", "modules"]) {
    const archive = path.join(a, ".archiview", "snapshots", name);
    await rename(archive, archive + ".saved");
    await writeFile(archive, "unavailable");
  }
  const viewer = await createWorkspaceSession({ root });
  const left = await viewer.getComparison({ published: true, repository: "a", baseline: "auto" });
  const right = await viewer.getComparison({ published: true, repository: "b", baseline: "auto" });
  assert.equal(left.published, true);
  assert.equal(right.published, true);
  assert.notEqual(left.id, right.id);
  const module = await viewer.getModule({ repository: "a", view: left.id, path: "." });
  assert.equal(module.after?.document.contract?.purpose, "Read project data.");
  await assert.rejects(viewer.getModule({ repository: "b", view: left.id, path: "." }), { code: "STALE_VIEW" });
  await assert.rejects(viewer.buildReview({ repository: "a", view: left.id, path: "." }), { code: "STALE_VIEW" });
  assert.deepEqual(await publicationTimes(), before);
  const live = await viewer.getComparison({ repository: "b", baseline: "auto" });
  assert.equal(live.published, undefined);
  assert.equal((await viewer.getModule({ repository: "b", view: live.id, path: "." })).after?.document.contract?.purpose, "Other local purpose.");
});

test("standalone and DSH isolate concurrent comparisons, snapshots and analyses for clones with identical module IDs", async (t) => {
  const { root, a, b } = await fixture(t);
  const workspace = await createWorkspaceSession({ root });
  const panel = await listen(t, createArchiViewHttpServer(workspace)) + "/api";
  const route = createRouteTable({ guard: () => false, getSession: () => workspace })[1];
  const dsh = await listen(t, createServer(route.handler)) + "/archiview/api";
  const [left, right] = await Promise.all([json<ComparisonView>(panel + "/comparison"), json<ComparisonView>(dsh + "/comparison?repository=b")]);
  assert.deepEqual(left.workspace, { root, repositories: ["a", "b"], repository: "a" });
  assert.equal(right.workspace?.repository, "b");
  assert.deepEqual([left.root, right.root], [a, b]);
  assert.equal(left.after.digest, right.after.digest);
  assert.notEqual(left.id, right.id);
  for (const view of [left, right]) assert.deepEqual(view.modules.map((module) => module.moduleId), ["shared"]);
  const apiModule = "/module?repository=b&path=.&view=";
  assert.equal((await json<ModuleDetail>(panel + apiModule + right.id)).moduleId, "shared");
  await json(dsh + apiModule + left.id, 409);
  await json(panel + "/comparison?repository=..", 400);
  await json(dsh + "/comparison?repository=.", 400);
  await json(panel + "/snapshots?repository=b", 400, { repository: "a", view: left.id });
  await json(dsh + "/reviews?repository=a", 409, { path: ".", view: right.id });
  const saved = await json<TimelineEntry>(panel + "/snapshots?repository=b", 201, { view: right.id, label: "Only B" });
  const request = await json<PreparedAnalysis>(dsh + "/analysis?repository=b", 201, { path: ".", view: right.id });
  assert.equal((await json<PreparedAnalysis>(panel + "/analysis/" + request.id + "?repository=b")).status, "prepared");
  await json(dsh + "/analysis/" + request.id + "?repository=a", 404);
  const nextA = await json<ComparisonView>(dsh + "/comparison?repository=a");
  const nextB = await json<ComparisonView>(panel + "/comparison?repository=b");
  assert.equal(nextA.baselines.some((snapshot) => snapshot.id === saved.id), false);
  assert.equal(nextB.baselines.some((snapshot) => snapshot.id === saved.id), true);
  await assert.rejects(stat(path.join(root, ".archiview")), { code: "ENOENT" });
});

test("Codex can open a healthy sibling, refresh discovery, and route the selected repository", async (t) => {
  const { root, a, b } = await fixture(t);
  const previous = await readFile(path.join(a, ".archiview/project.json"));
  await writeFile(path.join(a, ".archiview/project.json"), "invalid json");
  const panel = createCodexPanel(root);
  t.after(() => panel.close());
  const call = (operation: string, args = {}) => panel.callUi("archiview_ui_" + operation, args);
  const fallback = uiData<ComparisonView>(await call("get_comparison"));
  assert.equal(fallback.root, b);
  assert.deepEqual(fallback.workspace, { root, repositories: ["a", "b"], repository: "b" });
  await assert.rejects(call("get_comparison", { repository: "a" }).then(uiData));
  await writeFile(path.join(a, ".archiview/project.json"), previous);
  git(root, "clone", "-q", a, "c");
  const view = uiData<ComparisonView>(await call("get_comparison", { repository: "c" }));
  assert.deepEqual(view.workspace, { root, repositories: ["a", "b", "c"], repository: "c" });
  assert.equal(uiData<ModuleDetail>(await call("get_module", { repository: "c", view: view.id, path: "." })).moduleId, "shared");
  await assert.rejects(call("get_module", { repository: "b", view: view.id, path: "." }).then(uiData), { code: "STALE_VIEW" });
  await assert.rejects(stat(path.join(root, ".archiview")), { code: "ENOENT" });
});

test("a shared external history directory isolates repositories opened through a workspace or directly by DSH", async (t) => {
  const { root, a, b } = await fixture(t);
  const stateDirectory = path.join(root, "history");
  const workspace = await createWorkspaceSession({ root, stateDirectory: "../history" });
  const left = await workspace.session("a"), right = await workspace.session("b");
  assert.notEqual(left.store.directory, right.store.directory);
  assert.equal(path.dirname(path.dirname(left.store.directory)), stateDirectory);
  const directA = await createWorkspaceSession({ root: a, stateDirectory, sharedStateDirectory: true });
  const directB = await createWorkspaceSession({ root: b, stateDirectory, sharedStateDirectory: true });
  assert.equal((await directA.session()).store.directory, left.store.directory);
  assert.equal((await directB.session()).store.directory, right.store.directory);
  const aView = await left.getComparison(), bView = await right.getComparison();
  await Promise.all([left.saveSnapshot({ view: aView.id, label: "Saved A" }), right.saveSnapshot({ view: bView.id, label: "Saved B" })]);
  for (const [direct, label] of [[directA, "Saved A"], [directB, "Saved B"]] as const) {
    const refreshed = await direct.getComparison();
    assert.deepEqual(refreshed.baselines.filter((item) => item.kind === "saved").map((item) => item.label), [label]);
  }
  const request = await right.prepareAnalysis({ view: bView.id, path: "." });
  const args = ["--import", "tsx", "src/archiview/cli.ts", "--root", b, "--state-dir", right.store.directory, "--prepare-analysis", request.id];
  const output = execFileSync(process.execPath, args, { encoding: "utf8", windowsHide: true });
  assert.ok(output.includes(path.join(right.store.directory, "snapshots", "analysis", request.id)));
  await assert.rejects(left.getAnalysis({ id: request.id }), { code: "ENOENT" });
});

test("the physical owner retains its existing external DSH history when another checkout has the same portable identity", async (t) => {
  const { root, a, b } = await fixture(t);
  const stateDirectory = path.join(root, "history");
  const old = await createArchiViewSession({ root: a, stateDirectory });
  const current = await old.getComparison();
  await old.saveSnapshot({ view: current.id, label: "Previous DSH history" });
  const direct = await createWorkspaceSession({ root: a, stateDirectory, sharedStateDirectory: true });
  const workspace = await createWorkspaceSession({ root, stateDirectory });
  for (const session of [await direct.session(), await workspace.session("a")]) {
    assert.equal(session.store.directory, stateDirectory);
    assert.ok((await session.getComparison()).baselines.some((item) => item.label === "Previous DSH history"));
  }
  const other = await workspace.session("b");
  assert.equal(other.root, b);
  assert.notEqual(other.store.directory, stateDirectory);
  assert.equal((await other.getComparison()).baselines.some((item) => item.label === "Previous DSH history"), false);
});
