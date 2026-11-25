import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, truncate, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse, stringify } from "yaml";
import { registerHarness } from "../web/web-backend/host-bridge/channel.js";
import { createWorkspaceSession } from "../web/web-backend/workspace-session.js";
import { createArchiView } from "../web/web-backend/web-service/http.js";
import { digest } from "../framework/serialization/digest.js";
import type { Fact } from "../framework/snapshots/types.js";
import type { ReviewInput } from "../framework/static-report/types.js";
import type { ComparisonView } from "../module-operations/api.js";
import { commitTestFiles, initTestRepository, writeModuleTree, type ComparisonResponse } from "./support.js";

async function repositoryFixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "archiview-analysis-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "child"));
  initTestRepository(root);
  await writeModuleTree(root, { root: ".", child: "child" });
  for (const [directory, id] of [[".", "root"], ["child", "child"]]) {
    await writeFile(path.join(root, ".archiview/modules", id + ".yaml"), stringify({ schema_version: 1,
      id, title: directory === "." ? "Тестовый проект панели" : "Тестовый модуль", kind: "module",
      purpose: "Возвращать значение.",
      boundaries: { B1: "Не изменять исходники при просмотре." }, invariants: {} }));
  }
  await writeFile(path.join(root, "child/code.js"), "export const value = 1;\n");
  return root;
}

/** Искусственная модель проверяет протокол импорта; она не используется как содержательный анализ кода. */
function completedFixture(input: ReviewInput) {
  const result = structuredClone(input);
  result.report.analysis.model = { provider: "test", id: "protocol-fixture" };
  result.report.analysis.prompt_digest = digest("Protocol fixture, not a real review");
  result.manifest.model = result.report.analysis.model;
  result.manifest.prompt_digest = result.report.analysis.prompt_digest;
  result.report.analysis.input_digest = digest(result.manifest);
  result.report.analysis.coverage = { status: "partial", limitations: ["Protocol fixture; dependencies were not analyzed."] };
  result.report.assessment.current = { verdict: "needs_review", summary: "Protocol fixture only." };
  return result;
}

test("Git tree and separate reviews preserve module order across a revert, a late import, a restart and a commit", async (t) => {
  const root = await repositoryFixture(t);
  await writeFile(path.join(root, ".gitignore"), "*.tmp\n");
  commitTestFiles(root);
  let workspace = await createWorkspaceSession({ root });
  async function tree() { return workspace.getComparison(); }
  async function statuses(view: ComparisonView) {
    const result = await workspace.getReviewStatuses({ view: view.id });
    return Object.fromEntries(result.modules.map(m => [m.key, m.reviewStatus?.self.current.status]));
  }
  const first = await tree();
  assert.equal(first.separateAnalysis, true);
  assert.ok(first.modules.every(m => !m.reviewStatus));
  async function review(view: ComparisonView, key: string) {
    const request = await workspace.prepareAnalysis({ view: view.id, path: key });
    const folder = path.join(root, ".archiview/snapshots/analysis", request.id);
    const input: ReviewInput = parse(await readFile(path.join(folder, "input.yaml"), "utf8"));
    await writeFile(path.join(folder, "result.yaml"), stringify(completedFixture(input), { aliasDuplicateObjects: false }));
    return () => workspace.session().then(session => session.analysis.complete(request.id));
  }
  const parent = await review(first, ".");
  const child = await review(first, "child");
  await parent();
  const filename = "child/новый файл.js";
  await writeFile(path.join(root, filename), "new\n");
  await writeFile(path.join(root, "ignored.tmp"), "ignore");
  const changed = await tree();
  assert.deepEqual((await workspace.getModule({ view: changed.id, path: "child", analysis: false })).files,
    [{ path: filename, status: "new" }]);
  assert.equal(changed.modules.find(m => m.key === ".")!.status, "unchanged");
  await rm(path.join(root, filename));
  await child();
  workspace = await createWorkspaceSession({ root });
  const reverted = await tree();
  assert.equal(reverted.counts.changed, 0);
  assert.deepEqual(await statuses(reverted), { ".": "fresh", child: "stale" });
  await writeFile(path.join(root, "child/code.js"), "updated\n");
  const next = await tree();
  await (await review(next, "child"))();
  assert.deepEqual(await statuses(await tree()), { ".": "fresh", child: "fresh" });
  commitTestFiles(root);
  const committed = await tree();
  assert.equal(committed.counts.changed, 0);
  assert.deepEqual(await statuses(committed), { ".": "fresh", child: "fresh" });
  const contractPath = path.join(root, ".archiview/modules/child.yaml");
  const original = await readFile(contractPath, "utf8");
  const declaration = parse(original);
  declaration.purpose += " Изменённое обещание.";
  await writeFile(contractPath, stringify(declaration));
  assert.deepEqual(await statuses(await tree()), { ".": "stale", child: "stale" });
  await writeFile(contractPath, original);
  workspace = await createWorkspaceSession({ root });
  assert.deepEqual(await statuses(await tree()), { ".": "stale", child: "stale" });

});

/** Открывает временный backend и закрывает ровно принадлежащие тесту соединения. */
async function serve(t: TestContext, root: string) {
  const app = await createArchiView({ root });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { app.server.closeAllConnections(); await new Promise<void>((resolve) => app.server.close(() => resolve())); });
  return { ...app, url: "http://127.0.0.1:" + (app.server.address() as AddressInfo).port };
}

/** Создаёт запрос кнопки в реальном API, а не напрямую в модели хранения. */
async function prepare(app: { url: string }, view: { id: string }, module = "child") {
  return fetch(app.url + "/api/analysis", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ view: view.id, path: module }) });
}

test("only live harness registrations can receive a request, and concurrent delivery creates one chat", async t => {
  const root = await repositoryFixture(t);
  const folder = await mkdtemp(path.join(os.tmpdir(), "archiview-registrations-"));
  const previous = process.env.ARCHIVIEW_BRIDGE_DIR;
  process.env.ARCHIVIEW_BRIDGE_DIR = folder;
  t.after(async () => {
    if (previous === undefined) delete process.env.ARCHIVIEW_BRIDGE_DIR;
    else process.env.ARCHIVIEW_BRIDGE_DIR = previous;
    await rm(folder, { recursive: true, force: true });
  });
  let calls = 0;
  let acknowledge!: () => void;
  const ack = new Promise<void>(resolve => { acknowledge = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const close = await registerHarness({ kind: "dsh", instance: "test-dsh", async available() {},
    async start(job) {
      calls++;
      assert.equal(job.repositoryRoot, root);
      assert.equal(job.moduleId, "child");
      assert.ok(job.prompt.includes(job.requestId));
      entered();
      await ack;
      return "test-chat";
    } });
  try {
    const app = await serve(t, root);
    const view = await (await fetch(app.url + "/api/comparison?baseline=initial")).json();
    const request = await (await prepare(app, view)).json();
    const list = async () => (await (await fetch(app.url + "/api/harnesses")).json()).harnesses;
    const [host] = await list();
    const post = () => fetch(app.url + "/api/analysis/deliver", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: request.id, harnessId: host.id }) });
    const send = post();
    await started;
    assert.equal((await (await post()).json()).state, "pending");
    acknowledge();
    const receipt = await (await send).json();
    assert.equal(receipt.state, "sent");
    assert.equal(receipt.chatId, "test-chat");
    assert.deepEqual(await (await post()).json(), receipt);
    assert.equal(calls, 1);
    const status = await (await fetch(app.url + "/api/analysis/" + request.id)).json();
    assert.equal(status.status, "prepared");
    assert.deepEqual(status.delivery, receipt);
    await close();
    assert.deepEqual(await list(), []);
    const next = await (await prepare(app, view)).json();
    const offline = await fetch(app.url + "/api/analysis/deliver", { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: next.id, harnessId: host.id }) });
    assert.equal(offline.status, 409);

    let uncertainCalls = 0;
    const stop = await registerHarness({ kind: "codex", instance: "lost-ack", async available() {}, async start() {
      uncertainCalls++;
      throw new Error("Хост закрыл соединение после запроса");
    } });
    try {
      const [codex] = await list();
      const deliver = () => app.deliverAnalysis({id: next.id, harnessId: codex.id});
      assert.equal((await deliver()).state, "unknown");
      const reopened = await createWorkspaceSession({root});
      try {
        assert.equal((await reopened.getAnalysis({id: next.id})).delivery?.state, "unknown");
        assert.equal((await reopened.deliverAnalysis({id: next.id, harnessId: codex.id})).state, "unknown");
      } finally { await reopened.close(); }
      assert.equal(uncertainCalls, 1);
    } finally { await stop(); }
  } finally { acknowledge(); await close(); }
});

test("analysis exports exactly the selected view, imports through CLI once, and becomes stale against changed code", async (t) => {
  const root = await repositoryFixture(t);
  const app = await serve(t, root);
  const view = await ((await fetch(app.url + "/api/comparison?baseline=initial")).json() as Promise<ComparisonResponse>);
  await writeFile(path.join(root, "child/code.js"), "export const value = 2;\n");
  const response = await prepare(app, view);
  assert.equal(response.status, 201);
  const request = await response.json();
  const directory = path.join(root, ".archiview/snapshots/analysis", request.id);
  const input = parse(await readFile(path.join(directory, "input.yaml"), "utf8"));
  assert.equal(input.module_id, "child");
  assert.ok(input.current.facts.some((fact: Fact) => fact.text === "export const value = 1;\n"));
  assert.ok(!input.current.facts.some((fact: Fact) => fact.text === "export const value = 2;\n"));
  assert.equal((await app.analysis.status(request.id)).status, "prepared");
  assert.equal((await app.reports.list()).entries.length, 0);
  await writeFile(path.join(directory, "result.yaml"), stringify(completedFixture(input), { aliasDuplicateObjects: false }));
  const args = ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../cli/cli.ts", import.meta.url)), "--root", root, "--complete-analysis", request.id];
  await promisify(execFile)(process.execPath, args);
  await promisify(execFile)(process.execPath, args);
  const entries = (await app.reports.list()).entries;
  assert.equal(entries.length, 1);
  assert.equal((await (await fetch(app.url + "/api/analysis/" + request.id)).json()).status, "completed");
  const live = await app.getComparison();
  const statuses = await app.getReviewStatuses({ view: live.id });
  assert.equal(statuses.modules.find(m => m.key === "child")!.reviewStatus!.self.current.status, "stale");
  const child = (await ((await fetch(app.url + "/api/comparison?baseline=initial")).json() as Promise<ComparisonResponse>)).modules.find((module) => module.moduleId === "child");
  assert.equal(child!.reviewStatus!.self.current.status, "stale");
});

test("analysis rejects unknown view/module, missing contracts, changed inputs and redirected result files", async (t) => {
  const root = await repositoryFixture(t);
  const app = await serve(t, root);
  const view = await ((await fetch(app.url + "/api/comparison?baseline=initial")).json() as Promise<ComparisonResponse>);
  assert.equal((await prepare(app, { id: "expired" })).status, 409);
  assert.equal((await prepare(app, view, "../outside")).status, 404);
  const request = await (await prepare(app, view)).json();
  const directory = path.join(root, ".archiview/snapshots/analysis", request.id);
  const input = parse(await readFile(path.join(directory, "input.yaml"), "utf8"));
  const result = completedFixture(input);
  result.inputs.current.dependency_coverage = { status: "complete", potential_influence: [] };
  await writeFile(path.join(directory, "result.yaml"), stringify(result, { aliasDuplicateObjects: false }));
  await assert.rejects(app.analysis.complete(request.id), /Изменены входы анализа/);
  await writeFile(path.join(directory, "result.yaml"), stringify(completedFixture(input), { aliasDuplicateObjects: false }));
  const outside = path.join(root, "redirected-analysis");
  await rename(directory, outside);
  await symlink(outside, directory, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(app.analysis.complete(request.id), /ссыл|storage|Недопустимый/i);
  assert.equal((await app.reports.list()).entries.length, 0);
  await writeModuleTree(root, { root: "." });
  await rm(path.join(root, ".archiview/modules/child.yaml"));
  const missing = await ((await fetch(app.url + "/api/comparison?baseline=initial")).json() as Promise<ComparisonResponse>);
  assert.equal((await prepare(app, missing)).status, 422);
});

test("CLI rejects dependency collection flags before reading a selector file or creating an export", async (t) => {
  const root = await repositoryFixture(t);
  const output = path.join(root, "disabled-export.yaml");
  const cli = fileURLToPath(new URL("../cli/cli.ts", import.meta.url));
  for (const flags of [["--dependencies", path.join(root, "missing-selectors.yaml")], ["--dependencies-complete"]]) {
    await assert.rejects(promisify(execFile)(process.execPath,
      ["--import", "tsx", cli, "--root", root, "--export-review-input", "child", "--output", output, ...flags], { windowsHide: true }),
      (error: Error & { stderr?: string }) => /Сбор зависимостей через LLM отключён/.test(error.stderr ?? ""));
    await assert.rejects(stat(output), { code: "ENOENT" });
  }
});

test("analysis rejects LLM dependency collection and re-exports original own inputs without changing proof", async (t) => {
  const root = await repositoryFixture(t);
  const app = await serve(t, root);
  const view = await ((await fetch(app.url + "/api/comparison?baseline=initial")).json() as Promise<ComparisonResponse>);
  const request = await (await prepare(app, view)).json();
  const directory = path.join(root, ".archiview/snapshots/analysis", request.id);
  const original = await readFile(path.join(directory, "input.yaml"), "utf8");
  await writeFile(path.join(root, "child/code.js"), "export const value = 99;\n");
  await assert.rejects(app.analysis.prepare(request.id, [{ kind: "file", path: "child/code.js" }]), /LLM отключён/);
  await assert.rejects(app.analysis.prepare(request.id, [], true), /LLM отключён/);
  const exported = await app.analysis.prepare(request.id, []);
  const input = parse(await readFile(exported, "utf8"));
  assert.deepEqual(input.inputs.current.dependencies, []);
  assert.equal(input.inputs.current.dependency_coverage.status, "unknown");
  assert.ok(input.current.facts.some((fact: Fact) => fact.text === "export const value = 1;\n"));
  assert.equal(await readFile(path.join(directory, "input.yaml"), "utf8"), original);
  await writeFile(path.join(directory, "result.yaml"), stringify(completedFixture(input), { aliasDuplicateObjects: false }));
  assert.equal((await app.analysis.complete(request.id)).status, "completed");
});

test("a prepared review accepts a result above 32 MiB within its input-relative byte budget", async (t) => {
  const root = await repositoryFixture(t);
  const app = await serve(t, root);
  const view = await app.getComparison({ baseline: "initial" });
  const request = await app.prepareAnalysis({ view: view.id, path: "child" });
  const exported = await app.analysis.prepare(request.id, []);
  const input = parse(await readFile(exported, "utf8"));
  const result = path.join(path.dirname(exported), "result.yaml");
  const inputBytes = (await stat(exported)).size;
  const allowance = 32 * 1024 * 1024;
  await writeFile(result, "");
  await truncate(result, inputBytes + allowance + 1);
  await assert.rejects(app.analysis.complete(request.id), /Недопустимый файл анализа/);
  assert.equal((await app.analysis.status(request.id)).status, "prepared");

  // YAML comments affect the transport size without creating a huge persisted review.
  const yaml = stringify(completedFixture(input), { aliasDuplicateObjects: false });
  await writeFile(result, yaml + "#" + "a".repeat(inputBytes + allowance - Buffer.byteLength(yaml) - 1));
  assert.equal((await stat(result)).size, inputBytes + allowance);
  assert.equal((await app.analysis.complete(request.id)).status, "completed");
});

test("request metadata keeps its own size limit while saved snapshots have a larger limit", async (t) => {
  const root = await repositoryFixture(t);
  const app = await serve(t, root);
  const view = await app.getComparison({ baseline: "initial" });
  const request = await app.prepareAnalysis({ view: view.id, path: "child" });
  const directory = path.join(root, ".archiview/snapshots/analysis", request.id);
  const requestFile = path.join(directory, "request.json");
  const metadata = await readFile(requestFile);
  await truncate(requestFile, 32 * 1024 * 1024 + 1);
  await assert.rejects(app.analysis.status(request.id), /Недопустимый файл анализа/);
  await writeFile(requestFile, metadata);
  await truncate(path.join(directory, "scope.json"), 32 * 1024 * 1024 + 1);
  await assert.rejects(app.analysis.complete(request.id), /Недопустимый файл анализа/);
  await truncate(path.join(directory, "snapshots.json"), 256 * 1024 * 1024 + 1);
  await assert.rejects(app.analysis.prepare(request.id, []), /Недопустимый файл анализа/);
});
