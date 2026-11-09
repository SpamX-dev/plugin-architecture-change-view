/** Реальные stdio/HTTP-сценарии панели и неизменяемого задания на анализ. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, symlink, rename, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

test("autonomous plugin serves MCP UI and HTTP without node_modules, and disconnect closes its backend", async (t) => {
  const root = await panelFixture(t);
  const distribution = await mkdtemp(path.join(os.tmpdir(), "archiview-distribution-"));
  t.after(() => rm(distribution, { recursive: true, force: true }));
  await cp(fileURLToPath(new URL("../dist/codex/", import.meta.url)), distribution, { recursive: true });
  const client = new Client({ name: "panel-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [path.join(distribution, "src/server.mjs"), "--root", root, "--panel"], stderr: "pipe" }));
  const tools = (await client.listTools()).tools;
  const tool = tools.find((tool) => tool.name === "archiview_open");
  assert.deepEqual(tool._meta["openai/ui"].entrypoints, [{ type: "thread" }, { type: "global" }]);
  const result = await client.callTool({ name: tool.name, arguments: {} });
  assert.deepEqual(result.structuredContent, { root });
  const resource = (await client.readResource({ uri: tool._meta.ui.resourceUri })).contents[0];
  assert.equal(resource.mimeType, "text/html;profile=mcp-app");
  const origin = /name="archiview-backend" content="([^"]+)"/.exec(resource.text)[1];
  const token = /name="archiview-token" content="([^"]+)"/.exec(resource.text)[1];
  assert.equal(token.length, 64);
  assert.ok(!JSON.stringify(result).includes(token));
  // Загрузка JS/CSS не должна зависеть от CSP-разрешения loopback-ресурсов.
  assert.doesNotMatch(resource.text, /<script\b[^>]*\bsrc=|<link\b[^>]*\brel="stylesheet"/i);
  assert.match(resource.text, /<script type="module">/);
  assert.match(resource.text, /ui\/initialize/);
  assert.deepEqual(resource._meta.ui.csp, { connectDomains: [origin], resourceDomains: [] });
  assert.deepEqual(resource._meta["openai/widgetCSP"], { connect_domains: [origin], resource_domains: [] });
  assert.equal((await fetch(origin + "/api/comparison")).status, 403);
  assert.equal((await fetch(origin + "/api/comparison", { headers: { Origin: "null", Authorization: "Bearer " + token } })).status, 200);
  await client.close();
  await assert.rejects(fetch(origin + "/api/comparison"), /fetch failed/);
});

test("plugin cwd is not a project; explicit binding is shared by tools and cannot switch roots", async (t) => {
  const root = await panelFixture(t);
  const plugin = await mkdtemp(path.join(os.tmpdir(), "archiview-plugin-cwd-"));
  const client = new Client({ name: "project-test", version: "1.0.0" });
  t.after(async () => { await client.close(); await rm(plugin, { recursive: true, force: true }); });
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../dist/codex/src/server.mjs", import.meta.url)), "--panel"],
    cwd: plugin, env: { ...process.env, PLUGIN_ROOT: plugin }, stderr: "pipe" }));
  assert.equal((await client.callTool({ name: "module_inventory", arguments: {} })).isError, true);
  const opened = await client.callTool({ name: "archiview_open", arguments: {} });
  assert.equal(opened.structuredContent.projectRequired, true);
  await assert.rejects(stat(path.join(plugin, ".archiview")), { code: "ENOENT" });
  const invalid = await client.callTool({ name: "archiview_open", arguments: { projectRoot: "relative" } });
  assert.equal(invalid.isError, true);
  const bound = await client.callTool({ name: "archiview_open", arguments: { projectRoot: root } });
  assert.equal(bound.structuredContent.root, root);
  const context = await client.callTool({ name: "module_context", arguments: { directory: "child" } });
  assert.equal(context.isError, undefined);
  assert.match(context.content[0].text, /Тестовый модуль/);
  assert.equal((await client.callTool({ name: "archiview_open", arguments: { projectRoot: plugin } })).isError, true);
  await assert.rejects(stat(path.join(root, ".archiview")), { code: "ENOENT" });
});

test("direct panel entry binds a project over authenticated HTTP without routing BFF through MCP", async (t) => {
  const root = await panelFixture(t);
  const other = await panelFixture(t);
  const panel = createCodexPanel();
  t.after(() => panel.close());
  const resource = (await panel.resource()).contents[0];
  const origin = /name="archiview-backend" content="([^"]+)"/.exec(resource.text)[1];
  const token = /name="archiview-token" content="([^"]+)"/.exec(resource.text)[1];
  const headers = { Origin: "https://web-sandbox.oaiusercontent.com", Authorization: "Bearer " + token, "Content-Type": "application/json" };
  assert.equal((await fetch(origin + "/api/comparison", { headers }).then((r) => r.json())).code, "PROJECT_REQUIRED");
  const bind = (projectRoot, authorized = true) => fetch(origin + "/api/project", { method: "POST", headers: authorized ? headers : { Origin: headers.Origin }, body: JSON.stringify({ projectRoot }) });
  assert.equal((await bind(root, false)).status, 403);
  assert.equal((await bind("relative")).status, 400);
  assert.equal((await bind(path.join(root, "child/code.js"))).status, 400);
  assert.equal((await bind(root)).status, 200);
  assert.equal((await bind(other)).status, 400);
  const response = await fetch(origin + "/api/comparison", { headers });
  assert.equal(response.status, 200);
  const view = await response.json();
  assert.equal(view.root, root);
  assert.ok(view.modules.some((entry) => entry.moduleId === "child"));
});
