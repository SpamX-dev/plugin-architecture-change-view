import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
