import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { ComparisonView, ModuleDetail, PreparedAnalysis, TimelineEntry } from "../module-operations/api.js";
import { createArchiViewSession } from "../web/web-backend/session.js";
import { createWorkspaceSession } from "../web/web-backend/workspace-session.js";
import { createArchiViewHttpServer } from "../web/web-backend/web-service/http.js";
import { contractYaml, writeModuleTree } from "./support.js";

function git(cwd: string, ...args: string[]) {
  execFileSync("git", args, { cwd, windowsHide: true, stdio: "pipe" });
}

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "archiview-workspace-"));
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

test("opening a checkout serves its published tree and card even when its raw archives are unavailable", async (t) => {
  const { root, a, b } = await fixture(t);
  const publisher = await createWorkspaceSession({ root });
  await writeFile(path.join(a, "index.js"), "export const v = 2;\n");
  for (const repository of ["a", "b"]) {
    const first = await publisher.getComparison({ repository, published: true, baseline: "auto" });
    assert.equal(first.published, undefined, "a checkout without work must serve a live result");
    await publisher.buildReview({repository,view:first.id,path:"."});
    const work = path.join(root, repository, ".archiview", "work");
    const technical = (await readdir(work)).find(name => name.endsWith(".archi.yaml"))!;
    assert.match(await readFile(path.join(work, technical), "utf8"), /generation: 1\b/);
  }
  const work = path.join(a, ".archiview", "work");
  const files = await readdir(work);
  const publicationTimes = () => Promise.all(files.map(async file => (await stat(path.join(work, file))).mtimeMs));
  const before = await publicationTimes();
  // The checkout has moved on since publication and the raw archives cannot be traversed.
  await writeFile(path.join(a, ".archiview/modules/shared.yaml"), contractYaml("shared", "New local responsibility."));
  await writeFile(path.join(a, "index.js"), "export const v = 3;\n");
  await writeFile(path.join(b, "index.js"), "export const v = 4;\n");
  await writeFile(path.join(b, ".archiview/modules/shared.yaml"), contractYaml("shared", "Other local responsibility."));
  for (const name of ["modules"]) {
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
  const diffArgs = { repository: "a", view: left.id, path: ".", file: "index.js" };
  assert.deepEqual((await viewer.getFileDiff(diffArgs)).hunks[0].lines, ["-export const v = 1;", "+export const v = 2;"]);
  assert.deepEqual(await viewer.getFileDiff({ ...diffArgs, repository: "b", view: right.id }), {
    hunks: [], unchangedText: "export const v = 1;\n",
  });
  await assert.rejects(viewer.getFileDiff({ ...diffArgs, repository: "b" }), { code: "STALE_VIEW" });
  await assert.rejects(viewer.getModule({ repository: "b", view: left.id, path: "." }), { code: "STALE_VIEW" });
  await assert.rejects(viewer.buildReview({ repository: "a", view: left.id, path: "." }), { code: "STALE_VIEW" });
  assert.deepEqual(await publicationTimes(), before);
  const live = await viewer.getComparison({ repository: "b", baseline: "auto" });
  assert.equal(live.published, undefined);
  assert.equal((await viewer.getModule({ repository: "b", view: live.id, path: "." })).after?.document.contract?.purpose, "Other local responsibility.");
});

test("standalone HTTP isolates concurrent comparisons, snapshots and analyses for clones with identical module IDs", async (t) => {
  const { root, a, b } = await fixture(t);
  const workspace = await createWorkspaceSession({ root });
  const api = await listen(t, createArchiViewHttpServer(workspace)) + "/api";
  const [left, right] = await Promise.all([json<ComparisonView>(api + "/comparison"), json<ComparisonView>(api + "/comparison?repository=b")]);
  assert.deepEqual(left.workspace, { root, repositories: ["a", "b"], repository: "a" });
  assert.equal(right.workspace?.repository, "b");
  assert.deepEqual([left.root, right.root], [a, b]);
  assert.deepEqual(left.counts, right.counts);
  assert.notEqual(left.id, right.id);
  for (const view of [left, right]) assert.deepEqual(view.modules.map((module) => module.moduleId), ["shared"]);
  const apiModule = "/module?repository=b&path=.&view=";
  assert.equal((await json<ModuleDetail>(api + apiModule + right.id)).moduleId, "shared");
  await json(api + apiModule + left.id, 409);
  await json(api + "/comparison?repository=..", 400);
  await json(api + "/comparison?repository=.", 400);
  await json(api + "/snapshots?repository=b", 400, { repository: "a", view: left.id });
  await json(api + "/reviews?repository=a", 409, { path: ".", view: right.id });
  const saved = await json<TimelineEntry>(api + "/snapshots?repository=b", 201, { view: right.id, label: "Only B" });
  const request = await json<PreparedAnalysis>(api + "/analysis?repository=b", 201, { path: ".", view: right.id });
  assert.equal((await json<PreparedAnalysis>(api + "/analysis/" + request.id + "?repository=b")).status, "prepared");
  await json(api + "/analysis/" + request.id + "?repository=a", 404);
  const nextA = await json<ComparisonView>(api + "/comparison?repository=a");
  const nextB = await json<ComparisonView>(api + "/comparison?repository=b");
  assert.equal(nextA.baselines.some((snapshot) => snapshot.id === saved.id), false);
  assert.equal(nextB.baselines.some((snapshot) => snapshot.id === saved.id), true);
  await assert.rejects(stat(path.join(root, ".archiview")), { code: "ENOENT" });
});

test("a workspace can open a healthy sibling, refresh discovery, and route the selected repository", async (t) => {
  const { root, a, b } = await fixture(t);
  const previous = await readFile(path.join(a, ".archiview/project.json"));
  await writeFile(path.join(a, ".archiview/project.json"), "invalid json");
  const workspace = await createWorkspaceSession({ root });
  const fallback = await workspace.getComparison();
  assert.equal(fallback.root, b);
  assert.deepEqual(fallback.workspace, { root, repositories: ["a", "b"], repository: "b" });
  await assert.rejects(workspace.getComparison({ repository: "a" }));
  await writeFile(path.join(a, ".archiview/project.json"), previous);
  git(root, "clone", "-q", a, "c");
  const view = await workspace.getComparison({ repository: "c" });
  assert.deepEqual(view.workspace, { root, repositories: ["a", "b", "c"], repository: "c" });
  assert.equal((await workspace.getModule({ repository: "c", view: view.id, path: "." })).moduleId, "shared");
  await assert.rejects(workspace.getModule({ repository: "b", view: view.id, path: "." }), { code: "STALE_VIEW" });
  await assert.rejects(stat(path.join(root, ".archiview")), { code: "ENOENT" });
});

test("a shared external history directory isolates repositories opened through a workspace or directly", async (t) => {
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
  const args = ["--import", "tsx", "cli/cli.ts", "--root", b, "--state-dir", right.store.directory, "--prepare-analysis", request.id];
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

test("a checkout using another clone's local state cannot share its requests with the host clone", async t => {
  const { a, b } = await fixture(t);
  const directory = path.join(b, ".archiview");
  // The clone initially carries A's portable identity, then repeats the scenario without an identity.
  for (const fresh of [false, true]) {
    if (fresh) await rm(path.join(directory, "project.json"), { force: true });
    const caller = await createWorkspaceSession({ root: a, stateDirectory: directory });
    const host = await createWorkspaceSession({ root: b });
    const remote = await caller.session();
    const local = await host.session();
    try {
      assert.notEqual(remote.store.directory, local.store.directory);
      const view = await remote.getComparison();
      const request = await remote.prepareAnalysis({ view: view.id, path: "." });
      await assert.rejects(local.getAnalysis({ id: request.id }), { code: "ENOENT" });
      const reopened = await createWorkspaceSession({ root: a, stateDirectory: remote.store.directory });
      try {
        assert.equal((await reopened.session()).store.directory, remote.store.directory);
        const partitions = path.dirname(remote.store.directory);
        for (const selected of [remote.store.directory, path.join(partitions, path.basename(remote.store.directory).toUpperCase()), path.join(remote.store.directory, "nested")]) {
          const other = await createWorkspaceSession({ root: b, stateDirectory: selected });
          try {
            assert.notEqual((await other.session()).store.directory, remote.store.directory);
            await assert.rejects((await other.session()).getAnalysis({ id: request.id }), { code: "ENOENT" });
          } finally { await other.close(); }
        }
      } finally { await reopened.close(); }
    } finally { await caller.close(); await host.close(); }
  }
});

test("an external store cannot claim a subdirectory project's state before the project opens it", async t => {
  const { a, b } = await fixture(t);
  const component = path.join(b, "component");
  const directory = path.join(component, ".archiview");
  // The external caller opens this location before even the component directory exists.
  const caller = await createWorkspaceSession({ root: a, stateDirectory: directory });
  t.after(() => caller.close());
  const remote = await caller.session();
  const view = await remote.getComparison();
  const request = await remote.prepareAnalysis({ view: view.id, path: "." });
  const host = await createWorkspaceSession({ root: component });
  t.after(() => host.close());
  const local = await host.session();
  assert.equal(local.store.directory, directory);
  assert.notEqual(remote.store.directory, local.store.directory);
  await assert.rejects(local.getAnalysis({ id: request.id }), { code: "ENOENT" });
});
