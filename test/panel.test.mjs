/** Реальные stdio/HTTP-сценарии панели и неизменяемого задания на анализ. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, symlink, rename, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stringify, parse } from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createArchiView } from "../src/archiview/http.mjs";
import { reviewFreshness } from "../src/report-model.mjs";
import { digest } from "../src/formats.mjs";
import { createCodexPanel } from "../src/codex/panel.mjs";
import { createArchiViewClient } from "../web/archiview/client.mjs";

/** Проверяет, что данные и ошибки UI не попадают в модельные поля результата MCP. */
function uiData(result) {
  assert.deepEqual(result.content, []);
  assert.equal(result.structuredContent, undefined);
  if (result.isError) throw Object.assign(new Error(result._meta.error.message), { code: result._meta.error.code });
  return result._meta.result;
}

test("autonomous MCP panel serves project operations with no listening sockets and UI-only results", async (t) => {
  const root = await panelFixture(t);
  const distribution = await mkdtemp(path.join(os.tmpdir(), "archiview-distribution-"));
  const client = new Client({ name: "panel-test", version: "1.0.0" });
  t.after(async () => { await client.close(); await rm(distribution, { recursive: true, force: true }); });
  await cp(fileURLToPath(new URL("../dist/codex/", import.meta.url)), distribution, { recursive: true });
  // Реальный процесс завершится ошибкой, если плагин попробует открыть любой TCP/IPC listener.
  await writeFile(path.join(distribution, "deny-listen.mjs"), 'import { Server } from "node:net"; Server.prototype.listen = function () { throw new Error("Panel must not open a listening socket"); };');
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: ["--import", pathToFileURL(path.join(distribution, "deny-listen.mjs")).href, path.join(distribution, "src/server.mjs"), "--panel"],
    cwd: distribution, env: { ...process.env, PLUGIN_ROOT: distribution }, stderr: "pipe" }));
  const tools = (await client.listTools()).tools;
  const hidden = tools.filter((tool) => tool.name.startsWith("archiview_ui_"));
  assert.equal(hidden.length, 8);
  for (const tool of hidden) assert.deepEqual(tool._meta.ui.visibility, ["app"]);
  assert.deepEqual(tools.filter((tool) => !tool._meta?.ui?.visibility || tool._meta.ui.visibility.includes("model")).map((tool) => tool.name),
    ["archiview_open", "module_inventory", "module_context"]);
  const openTool = tools.find((tool) => tool.name === "archiview_open");
  assert.deepEqual(openTool._meta["openai/ui"].entrypoints, [{ type: "thread" }]);
  const resource = (await client.readResource({ uri: openTool._meta.ui.resourceUri })).contents[0];
  assert.doesNotMatch(resource.text, /<script\b[^>]*\bsrc=|<link\b[^>]*\brel="stylesheet"|name="archiview-backend"|name="archiview-token"/i);
  assert.match(resource.text, /ui\/initialize/);
  assert.deepEqual(resource._meta.ui.csp, { connectDomains: [], resourceDomains: [] });
  const call = (name, args = {}) => client.callTool({ name: "archiview_ui_" + name, arguments: args });
  await assert.rejects(call("get_comparison").then(uiData), { code: "CODEX_CONTEXT_UNAVAILABLE" });
  assert.equal((await client.callTool({ name: "module_inventory", arguments: {} })).isError, true);
  await assert.rejects(stat(path.join(distribution, ".archiview")), { code: "ENOENT" });
  await assert.rejects(call("set_project", { projectRoot: "relative" }).then(uiData), { code: "INVALID_ARGUMENT" });
  await assert.rejects(call("set_project", { projectRoot: path.join(root, "child/code.js") }).then(uiData), { code: "INVALID_ARGUMENT" });
  assert.equal(uiData(await call("set_project", { projectRoot: root })).root, root);
  assert.equal((await client.callTool({ name: "archiview_open", arguments: {} })).structuredContent.root, root);
  await assert.rejects(call("set_project", { projectRoot: distribution }).then(uiData), { code: "PROJECT_BOUND" });
  const context = await client.callTool({ name: "module_context", arguments: { directory: "child" } });
  assert.match(context.content[0].text, /Тестовый модуль/);
  const view = uiData(await call("get_comparison", { target: "current", baseline: "auto", historyLimit: 50 }));
  assert.equal(view.root, root);
  assert.equal(view.modules.length, 2);
  const detail = uiData(await call("get_module", { view: view.id, path: "child" }));
  assert.equal(detail.moduleId, "child");
  await assert.rejects(call("get_module", { view: view.id, path: "../outside" }).then(uiData), { code: "NOT_FOUND" });
  await assert.rejects(call("get_module", { view: "expired", path: "child" }).then(uiData), { code: "STALE_VIEW" });
  await assert.rejects(call("get_comparison", { url: "http://example.com" }).then(uiData), { code: "INVALID_ARGUMENT" });
  await assert.rejects(call("get_comparison", { historyLimit: "50" }).then(uiData), { code: "INVALID_ARGUMENT" });
  const saved = uiData(await call("save_snapshot", { view: view.id, label: "MCP snapshot" }));
  assert.equal(saved.label, "MCP snapshot");
  await writeFile(path.join(root, "child/code.js"), "export const value = 2;\n");
  const analysis = uiData(await call("prepare_analysis", { view: view.id, path: "child" }));
  assert.equal(uiData(await call("get_analysis", { id: analysis.id })).status, "prepared");
  const input = parse(await readFile(path.join(root, ".archiview/snapshots/analysis", analysis.id, "input.yaml"), "utf8"));
  assert.ok(input.current.facts.some((fact) => fact.text === "export const value = 1;\n"));
  assert.equal(uiData(await call("build_review", { view: view.id, path: "child" })).module_id, "child");
  await client.close();
});

test("panel client uses the MCP operation adapter and never falls back to fetch", async (t) => {
  const panel = createCodexPanel(await panelFixture(t));
  t.after(() => panel.close());
  const noFetch = () => { throw new Error("Unexpected fetch"); };
  const client = createArchiViewClient({ mode: "mcp", fetcher: noFetch,
    connection: Promise.resolve({ call: async (name, args) => uiData(await panel.callUi(name, args)) }) });
  const view = await client.getComparison();
  assert.equal((await client.getModule({ view: view.id, path: "child" })).moduleId, "child");
  await panel.close();
  await assert.rejects(client.getComparison(), { code: "SESSION_CLOSED" });
  const unavailable = createArchiViewClient({ mode: "mcp", fetcher: noFetch, connection: Promise.resolve(null) });
  await assert.rejects(unavailable.getComparison(), /Хост не поддерживает/);
});

/** Изолированный проект с настоящим наследуемым ограничением и отдельной реализацией ребёнка. */
export async function panelFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "archiview-panel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "child"));
  for (const [directory, id] of [[".", "root"], ["child", "child"]]) {
    await writeFile(path.join(root, directory, "arch.yaml"), stringify({ schema_version: 1,
      id, title: directory === "." ? "Тестовый проект панели" : "Тестовый модуль", kind: "module",
      purpose: "Предоставлять значение тестового модуля.", responsibilities: { R1: "Возвращать значение." },
      boundaries: { B1: "Не изменять исходники при просмотре." }, invariants: {} }));
  }
  await writeFile(path.join(root, "child/code.js"), "export const value = 1;\n");
  return root;
}

/** Искусственная модель проверяет протокол импорта; она не используется как содержательный анализ кода. */
export function completedFixture(input) {
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

/** Открывает временный backend и закрывает ровно принадлежащие тесту соединения. */
async function serve(t, root, panelToken) {
  const app = await createArchiView({ root, panelToken });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { app.server.closeAllConnections(); await new Promise((resolve) => app.server.close(resolve)); });
  return { ...app, url: "http://127.0.0.1:" + app.server.address().port };
}

/** Создаёт запрос кнопки в реальном API, а не напрямую в модели хранения. */
async function prepare(app, view, module = "child") {
  return fetch(app.url + "/api/analysis", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ view: view.id, path: module }) });
}

test("panel CORS requires its token while same-origin and public assets preserve ordinary web use", async (t) => {
  const app = await serve(t, await panelFixture(t), "test-secret-token");
  const headers = { Origin: "https://web-sandbox.oaiusercontent.com" };
  assert.equal((await fetch(app.url + "/api/comparison", { headers })).status, 403);
  assert.equal((await fetch(app.url + "/api/comparison", { headers: { ...headers, Authorization: "Bearer wrong" } })).status, 403);
  const allowed = await fetch(app.url + "/api/comparison", { headers: { ...headers, Authorization: "Bearer test-secret-token" } });
  assert.equal(allowed.status, 200);
  assert.equal(allowed.headers.get("Access-Control-Allow-Origin"), headers.Origin);
  assert.ok(!(await allowed.text()).includes("test-secret-token"));
  assert.equal((await fetch(app.url + "/app.mjs", { headers })).status, 200);
  assert.equal((await fetch(app.url + "/mcp-app-sdk.mjs", { headers })).status, 200);
  assert.equal((await fetch(app.url + "/api/comparison", { method: "OPTIONS", headers: { ...headers, "Access-Control-Request-Headers": "authorization" } })).status, 204);
  assert.equal((await fetch(app.url + "/api/comparison")).status, 200);
  const normal = await serve(t, await panelFixture(t));
  assert.equal((await fetch(normal.url + "/api/comparison", { headers })).status, 403);
});

test("analysis exports exactly the selected view, imports through CLI once, and becomes stale against changed code", async (t) => {
  const root = await panelFixture(t);
  const app = await serve(t, root);
  const view = await (await fetch(app.url + "/api/comparison?baseline=initial")).json();
  await writeFile(path.join(root, "child/code.js"), "export const value = 2;\n");
  const response = await prepare(app, view);
  assert.equal(response.status, 201);
  const request = await response.json();
  const directory = path.join(root, ".archiview/snapshots/analysis", request.id);
  const input = parse(await readFile(path.join(directory, "input.yaml"), "utf8"));
  assert.equal(input.module_id, "child");
  assert.ok(input.current.facts.some((fact) => fact.text === "export const value = 1;\n"));
  assert.ok(!input.current.facts.some((fact) => fact.text === "export const value = 2;\n"));
  assert.equal((await app.analysis.status(request.id)).status, "prepared");
  assert.equal((await app.reports.list()).entries.length, 0);
  await writeFile(path.join(directory, "result.yaml"), stringify(completedFixture(input), { aliasDuplicateObjects: false }));
  const args = [fileURLToPath(new URL("../src/cli.mjs", import.meta.url)), "--root", root, "--complete-analysis", request.id];
  await promisify(execFile)(process.execPath, args);
  await promisify(execFile)(process.execPath, args);
  const entries = (await app.reports.list()).entries;
  assert.equal(entries.length, 1);
  assert.equal((await (await fetch(app.url + "/api/analysis/" + request.id)).json()).status, "completed");
  const live = await app.reports.publishedComparison();
  assert.equal(reviewFreshness(entries[0], live.baseline, live.current).current.status, "stale");
  const child = (await (await fetch(app.url + "/api/comparison?baseline=initial")).json()).modules.find((module) => module.moduleId === "child");
  assert.equal(child.reviewStatus.self.current.status, "stale");
});

test("analysis rejects unknown view/module, missing contracts, changed inputs and redirected result files", async (t) => {
  const root = await panelFixture(t);
  const app = await serve(t, root);
  const view = await (await fetch(app.url + "/api/comparison?baseline=initial")).json();
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
  await rm(path.join(root, "child/arch.yaml"));
  const missing = await (await fetch(app.url + "/api/comparison?baseline=initial")).json();
  assert.equal((await prepare(app, missing)).status, 422);
});

test("dependency export extends the original snapshot without replacing the first input or reading changed files", async (t) => {
  const root = await panelFixture(t);
  const app = await serve(t, root);
  const view = await (await fetch(app.url + "/api/comparison?baseline=initial")).json();
  const request = await (await prepare(app, view)).json();
  const directory = path.join(root, ".archiview/snapshots/analysis", request.id);
  const original = await readFile(path.join(directory, "input.yaml"), "utf8");
  await writeFile(path.join(root, "child/code.js"), "export const value = 99;\n");
  const exported = await app.analysis.prepare(request.id, [], true);
  const input = parse(await readFile(exported, "utf8"));
  assert.equal(input.inputs.current.dependency_coverage.status, "complete");
  assert.ok(input.current.facts.some((fact) => fact.text === "export const value = 1;\n"));
  assert.equal(await readFile(path.join(directory, "input.yaml"), "utf8"), original);
  await writeFile(path.join(directory, "result.yaml"), stringify(completedFixture(input), { aliasDuplicateObjects: false }));
  assert.equal((await app.analysis.complete(request.id)).status, "completed");
});
