import type { Fact } from "../src/snapshots/types.js";
import type { ComparisonResponse } from "./support.js";
import { uiData, panelMetadata, processEnvironment, firstTextContent, structuredData } from "./support.js";
import type { ComparisonView, ModuleDetail, PreparedAnalysis } from "../src/application/api.js";
import type { ReviewInput } from "../src/reports/types.js";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
/** Реальные stdio/HTTP-сценарии панели и неизменяемого задания на анализ. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, symlink, rename, stat, truncate } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stringify, parse } from "yaml";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createArchiView } from "../src/archiview/http.js";
import { reviewFreshness } from "../src/reports/model.js";
import { digest } from "../src/serialization/digest.js";
import { createCodexPanel } from "../src/codex/panel.js";
import { createArchiViewClient } from "../web/archiview/client.js";

/** Проверяет, что данные и ошибки UI не попадают в модельные поля результата MCP. */


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
  assert.equal(hidden.length, 9);
  for (const tool of hidden) assert.deepEqual(panelMetadata(tool).ui.visibility, ["app"]);
  assert.deepEqual(tools.filter((tool) => !tool._meta || !panelMetadata(tool).ui?.visibility || panelMetadata(tool).ui.visibility.includes("model")).map((tool) => tool.name),
    ["archiview_open", "module_inventory", "module_context"]);
  const openTool = tools.find((tool) => tool.name === "archiview_open");
  assert.deepEqual(panelMetadata(openTool!)["openai/ui"].entrypoints, [{ type: "thread" }]);
  const resource = (await client.readResource({ uri: panelMetadata(openTool!).ui.resourceUri })).contents[0];
  assert.ok("text" in resource);
  assert.doesNotMatch(resource.text, /<script\b[^>]*\bsrc=|<link\b[^>]*\brel="stylesheet"|name="archiview-backend"|name="archiview-token"/i);
  assert.match(resource.text, /ui\/initialize/);
  assert.deepEqual(panelMetadata(resource).ui.csp, { connectDomains: [], resourceDomains: [] });
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name: "archiview_ui_" + name, arguments: args });
  await assert.rejects(call("get_comparison").then(uiData), { code: "CODEX_CONTEXT_UNAVAILABLE" });
  assert.equal((await client.callTool({ name: "module_inventory", arguments: {} })).isError, true);
  await assert.rejects(stat(path.join(distribution, ".archiview")), { code: "ENOENT" });
  await assert.rejects(call("set_project", { projectRoot: "relative" }).then(uiData), { code: "INVALID_ARGUMENT" });
  await assert.rejects(call("set_project", { projectRoot: path.join(root, "child/code.js") }).then(uiData), { code: "INVALID_ARGUMENT" });
  assert.equal(uiData(await call("set_project", { projectRoot: root })).root, root);
  assert.equal(structuredData(await client.callTool({ name: "archiview_open", arguments: {} })).root, root);
  await assert.rejects(call("set_project", { projectRoot: distribution }).then(uiData), { code: "PROJECT_BOUND" });
  const context = await client.callTool({ name: "module_context", arguments: { directory: "child" } });
  assert.match(firstTextContent(context), /Тестовый модуль/);
  const view = uiData<ComparisonView>(await call("get_comparison", { target: "current", baseline: "auto", historyLimit: 50 }));
  assert.equal(view.root, root);
  assert.equal(view.modules.length, 2);
  const detail = uiData<ModuleDetail>(await call("get_module", { view: view.id, path: "child" }));
  assert.equal(detail.moduleId, "child");
  await assert.rejects(call("get_module", { view: view.id, path: "../outside" }).then(uiData), { code: "NOT_FOUND" });
  await assert.rejects(call("get_module", { view: "expired", path: "child" }).then(uiData), { code: "STALE_VIEW" });
  await assert.rejects(call("get_comparison", { url: "http://example.com" }).then(uiData), { code: "INVALID_ARGUMENT" });
  await assert.rejects(call("get_comparison", { historyLimit: "50" }).then(uiData), { code: "INVALID_ARGUMENT" });
  const saved = uiData(await call("save_snapshot", { view: view.id, label: "MCP snapshot" }));
  assert.equal(saved.label, "MCP snapshot");
  await writeFile(path.join(root, "child/code.js"), "export const value = 2;\n");
  const analysis = uiData<PreparedAnalysis>(await call("prepare_analysis", { view: view.id, path: "child" }));
  assert.ok(analysis.prompt.length > 0);
  const status = uiData(await call("get_analysis", { id: analysis.id }));
  assert.equal(status.status, "prepared");
  assert.equal(Object.hasOwn(status, "prompt"), false);
  const input = parse(await readFile(path.join(root, ".archiview/snapshots/analysis", analysis.id, "input.yaml"), "utf8"));
  assert.ok(input.current.facts.some((fact: Fact) => fact.text === "export const value = 1;\n"));
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
export async function panelFixture(t: TestContext) {
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
export function completedFixture(input: ReviewInput) {
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
async function serve(t: TestContext, root: string, panelToken?: string) {
  const app = await createArchiView({ root, panelToken });
  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { app.server.closeAllConnections(); await new Promise<void>((resolve) => app.server.close(() => resolve())); });
  return { ...app, url: "http://127.0.0.1:" + (app.server.address() as AddressInfo).port };
}

/** Создаёт запрос кнопки в реальном API, а не напрямую в модели хранения. */
async function prepare(app: { url: string }, view: { id: string }, module = "child") {
  return fetch(app.url + "/api/analysis", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ view: view.id, path: module }) });
}

test("the panel rejects an analysis status delivered as a prepared prompt", async () => {
  const client = createArchiViewClient({ mode: "mcp", connection: {
    call: async () => ({ status: "prepared" }),
  } });
  await assert.rejects(client.prepareAnalysis({ view: "view", path: "." }), /поручение анализа/);
});

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
  const args = ["--import", import.meta.resolve("tsx"), fileURLToPath(new URL("../src/archiview/cli.ts", import.meta.url)), "--root", root, "--complete-analysis", request.id];
  await promisify(execFile)(process.execPath, args);
  await promisify(execFile)(process.execPath, args);
  const entries = (await app.reports.list()).entries;
  assert.equal(entries.length, 1);
  assert.equal((await (await fetch(app.url + "/api/analysis/" + request.id)).json()).status, "completed");
  const live = await app.reports.publishedComparison();
  assert.equal(reviewFreshness(entries[0], live!.baseline, live!.current).current.status, "stale");
  const child = (await ((await fetch(app.url + "/api/comparison?baseline=initial")).json() as Promise<ComparisonResponse>)).modules.find((module) => module.moduleId === "child");
  assert.equal(child!.reviewStatus!.self.current.status, "stale");
});

test("analysis rejects unknown view/module, missing contracts, changed inputs and redirected result files", async (t) => {
  const root = await panelFixture(t);
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
  await rm(path.join(root, "child/arch.yaml"));
  const missing = await ((await fetch(app.url + "/api/comparison?baseline=initial")).json() as Promise<ComparisonResponse>);
  assert.equal((await prepare(app, missing)).status, 422);
});

test("dependency export extends the original snapshot without replacing the first input or reading changed files", async (t) => {
  const root = await panelFixture(t);
  const app = await serve(t, root);
  const view = await ((await fetch(app.url + "/api/comparison?baseline=initial")).json() as Promise<ComparisonResponse>);
  const request = await (await prepare(app, view)).json();
  const directory = path.join(root, ".archiview/snapshots/analysis", request.id);
  const original = await readFile(path.join(directory, "input.yaml"), "utf8");
  await writeFile(path.join(root, "child/code.js"), "export const value = 99;\n");
  const exported = await app.analysis.prepare(request.id, [], true);
  const input = parse(await readFile(exported, "utf8"));
  assert.equal(input.inputs.current.dependency_coverage.status, "complete");
  assert.ok(input.current.facts.some((fact: Fact) => fact.text === "export const value = 1;\n"));
  assert.equal(await readFile(path.join(directory, "input.yaml"), "utf8"), original);
  await writeFile(path.join(directory, "result.yaml"), stringify(completedFixture(input), { aliasDuplicateObjects: false }));
  assert.equal((await app.analysis.complete(request.id)).status, "completed");
});

test("a prepared review accepts a result above 32 MiB within its input-relative byte budget", async (t) => {
  const root = await panelFixture(t);
  const app = await serve(t, root);
  const view = await app.getComparison({ baseline: "initial" });
  const request = await app.prepareAnalysis({ view: view.id, path: "child" });
  const exported = await app.analysis.prepare(request.id, [], true);
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
  const root = await panelFixture(t);
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
  await assert.rejects(app.analysis.prepare(request.id, [], true), /Недопустимый файл анализа/);
});
