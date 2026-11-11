import type { HostProjectContext } from "../src/codex/host-context.js";
import { uiData, panelMetadata, processEnvironment } from "./support.js";
import type { ComparisonView, ModuleDetail, PreparedAnalysis } from "../src/application/api.js";
import type { TestContext } from "node:test";
/** Контекст Codex и первая UI-загрузка: пустой чат, отсутствие папки, ошибки хоста и готовый пакет. */
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createCodexProjectBinding } from "../src/codex/project-context.js";
import { createHostConnection, createHostContextReader } from "../src/codex/host-context.js";
import { createCodexPanel } from "../src/codex/panel.js";
import { createArchiViewClient as createCodexClient } from "../src/codex/panel-client.js";
import { chooseProjectDirectory } from "../src/codex/directory-picker.js";

/** Временные проекты и отдельные соединения; процессы закрываются раньше удаления их cwd на Windows. */
async function fixture(t: TestContext) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "archiview-codex-project-"));
  const clients: Client[] = [];
  t.after(async () => { await Promise.all(clients.map((client) => client.close())); await rm(temporary, { recursive: true, force: true }); });
  const roots = await Promise.all(["Проект A", "Проект B", "home"].map(async (name, index) => {
    const root = path.join(temporary, name); await mkdir(root);
    await writeFile(path.join(root, "arch.yaml"), `schema_version: 1\nid: root-${index}\ntitle: ${name}\nkind: module\npurpose: Предоставлять значение.\nresponsibilities:\n  R1: Возвращать значение.\nboundaries: {}\ninvariants: {}\n`);
    await writeFile(path.join(root, "main.js"), "export const value = 1;\n");
    return realpath(root);
  }));
  return { temporary, roots, clients };
}

/** Только поля хостового API: наличие сообщений и projectId не определяют выбранную папку. */
interface HostCall { method: string; params?: Record<string, unknown> }
interface HostData { chat: { thread: { id: string; cwd: string; projectId?: null; hostId?: string }; turns: unknown[] } | Error; folders: { projects: { projectKind: string; hostId: string; path: string }[] } | Error }
function hostData(root: string, folders = [root]): HostData {
  return { chat: { thread: { id: "chat-1", cwd: root, projectId: null, hostId: "local" }, turns: [] },
    folders: { projects: folders.map((folder) => ({ projectKind: "local", hostId: "local", path: folder })) } };
}

/** Изолированный ответчик App Tools с запретом любых операций, кроме двух требуемых чтений. */
function contextConnection(data: { chat: unknown; folders: unknown }, calls: HostCall[] = []) {
  return () => ({
    async request(method: string, params?: Record<string, unknown>) {
      calls.push({ method, params });
      if (method === "tools/list") return { tools: ["read_thread", "list_projects"].map((name) => ({ name, namespace: "codex_app" })) };
      assert.equal(method, "tools/call");
      assert.ok(params && typeof params.tool === "string");
      assert.ok(["read_thread", "list_projects"].includes(params.tool));
      const value = params.tool === "read_thread" ? data.chat : data.folders;
      if (value instanceof Error) throw value;
      return { success: true, contentItems: [{ type: "inputText", text: JSON.stringify(value) }] };
    },
    close() {},
  });
}

/** Данные и ошибки просмотра должны оставаться в UI-only метаданных. */


test("empty chat with a selected folder resolves without projectId, hooks or a model request", async (t) => {
  const { roots } = await fixture(t); const calls: HostCall[] = [];
  const readContext = createHostContextReader({ pipePath: "fixture", connection: contextConnection(hostData(roots[0]), calls) });
  const binding = await createCodexProjectBinding(undefined, { readContext });
  assert.deepEqual(await Promise.all([binding.select(undefined, { threadId: "chat-1" }), binding.select(undefined, { threadId: "chat-1" })]), [roots[0], roots[0]]);
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.filter((call) => call.method === "tools/call").map((call) => call.params!.tool).sort(), ["list_projects", "read_thread"]);
});

test("a chat without a selected folder is unavailable; a host failure is a different state", async (t) => {
  const { roots } = await fixture(t);
  const readContext = createHostContextReader({ pipePath: "fixture", connection: contextConnection(hostData(roots[2], [roots[0]])) });
  const absent = await createCodexProjectBinding(undefined, { readContext });
  await assert.rejects(absent.select(undefined, { threadId: "chat-1" }), { code: "PROJECT_UNAVAILABLE", message: "Плагин доступен только в проектах" });
  assert.equal(absent.root, undefined);
  const unknown = await createCodexProjectBinding(undefined, { readContext: createHostContextReader({ pipePath: "" }) });
  await assert.rejects(unknown.select(undefined, { threadId: "chat-1" }), { code: "CODEX_CONTEXT_UNAVAILABLE" });
  assert.equal(unknown.root, undefined);
});

test("cold chat keeps its startup workspace but never uses installation cwd or an unreadable folder catalogue", async (t) => {
  const { roots } = await fixture(t);
  const data = { ...hostData(roots[0]), chat: new Error("No persisted history") };
  const read = createHostContextReader({ pipePath: "fixture", connection: contextConnection(data), startupDirectory: roots[0], installedRoot: roots[1] });
  assert.deepEqual(await read("chat-1"), { status: "ready", root: roots[0] });
  assert.deepEqual(await read("chat-2", { allowStartupDirectory: false }), { status: "unknown" });
  const binding = await createCodexProjectBinding(undefined, { readContext: read });
  assert.equal(await binding.select(undefined, { threadId: "chat-1" }), roots[0]);
  await assert.rejects(binding.select(undefined, { threadId: "chat-2" }), { code: "CODEX_CONTEXT_UNAVAILABLE" });
  const installed = createHostContextReader({ pipePath: "fixture", connection: contextConnection(data), startupDirectory: roots[0], installedRoot: roots[0] });
  assert.deepEqual(await installed("chat-1"), { status: "unknown" });
  const projectless = createHostContextReader({ pipePath: "fixture", connection: contextConnection(data), startupDirectory: roots[2], installedRoot: roots[1] });
  assert.deepEqual(await projectless("chat-1"), { status: "unavailable" });
  data.folders = new Error("Host catalogue unavailable");
  assert.deepEqual(await read("chat-1"), { status: "unknown" });
});

test("context failures keep the panel loadable and retrying can initialize the same empty chat", async (t) => {
  const { roots } = await fixture(t); let context: HostProjectContext = { status: "unknown" };
  const binding = await createCodexProjectBinding(undefined, { readContext: async () => context });
  const panel = createCodexPanel(binding); t.after(() => panel.close());
  const metadata = { threadId: "chat-1" };
  for (const [status, code] of [["unknown", "CODEX_CONTEXT_UNAVAILABLE"], ["unavailable", "PROJECT_UNAVAILABLE"]]) {
    context = { status: status as "unknown" | "unavailable" };
    const opened = await panel.open(undefined, metadata);
    assert.notEqual("isError" in opened && opened.isError, true, "Host must still load the UI");
    assert.equal(opened._meta!.bootstrap.code, code);
    assert.ok((await panel.resource()).contents[0].text.includes("ui/initialize"));
    await assert.rejects(panel.callUi("archiview_ui_get_comparison", {}, metadata).then(uiData), { code });
  }
  context = { status: "ready", root: roots[0] };
  assert.equal((await panel.open(undefined, metadata)).structuredContent.root, roots[0]);
  assert.equal(uiData(await panel.callUi("archiview_ui_get_comparison", {}, metadata)).root, roots[0]);
});

test("unknown context permits one manual project; absent projects and other chats cannot override it", async (t) => {
  const { roots } = await fixture(t); let status: "unknown" | "unavailable" = "unknown";
  const binding = await createCodexProjectBinding(undefined, { readContext: async () => ({ status }) });
  const panel = createCodexPanel(binding, { chooseDirectory: async () => ({ projectRoot: roots[0] }) });
  t.after(() => panel.close());
  const metadata = { threadId: "chat-1" };
  const call = (name: string, args: Record<string, unknown> = {}) => panel.callUi("archiview_ui_" + name, args, metadata).then(uiData);
  await assert.rejects(call("get_comparison"), { code: "CODEX_CONTEXT_UNAVAILABLE" });
  assert.equal((await call("choose_project")).projectRoot, roots[0]);
  assert.equal(binding.root, undefined, "Dialog selection does not bind before the form submits");
  await assert.rejects(call("set_project", { projectRoot: "relative" }), { code: "INVALID_ARGUMENT" });
  assert.equal((await call("set_project", { projectRoot: roots[0] })).root, roots[0]);
  assert.equal((await call("get_comparison")).root, roots[0]);
  await assert.rejects(call("set_project", { projectRoot: roots[1] }), { code: "PROJECT_BOUND" });
  await assert.rejects(binding.select(roots[0], { threadId: "chat-2" }), { code: "CODEX_CONTEXT_UNAVAILABLE" });
  status = "unavailable";
  const absent = await createCodexProjectBinding(undefined, { readContext: async () => ({ status }) });
  let dialogs = 0;
  const denied = createCodexPanel(absent, { chooseDirectory: async () => { dialogs++; return { projectRoot: roots[0] }; } });
  t.after(() => denied.close());
  await assert.rejects(denied.callUi("archiview_ui_choose_project", {}, metadata).then(uiData), { code: "PROJECT_UNAVAILABLE" });
  await assert.rejects(absent.select(roots[0], metadata), { code: "PROJECT_UNAVAILABLE" });
  assert.equal(dialogs, 0);
});

test("Codex client opens the original form on unknown context, missing root or a stalled first response", async () => {
  const missing = Object.assign(new Error("Host context unavailable"), { code: "CODEX_CONTEXT_UNAVAILABLE" });
  for (const call of [async () => { throw missing; }, async () => ({}), () => new Promise(() => {})]) {
    const client = createCodexClient({ mode: "mcp", connection: Promise.resolve({ call }) }, { timeoutMs: 20 });
    await assert.rejects(client.getComparison(), { code: "PROJECT_REQUIRED" });
  }
  const absent = createCodexClient({ mode: "mcp", connection: Promise.resolve({ call: async () => {
    throw Object.assign(new Error("Плагин доступен только в проектах"), { code: "PROJECT_UNAVAILABLE" });
  } }) });
  await assert.rejects(absent.getComparison(), { code: "PROJECT_UNAVAILABLE" });
});

test("a resolved project keeps loading beyond the folder timeout and preserves comparison errors", async () => {
  const root = path.resolve("project"), calls: string[] = [];
  let finish!: (value: unknown) => void;
  let started!: () => void;
  let failure: Error | undefined;
  const loading = new Promise<void>((resolve) => { started = resolve; });
  const view = { root, modules: [] };
  const client = createCodexClient({ mode: "mcp", connection: Promise.resolve({ call: async (name: string) => {
    calls.push(name);
    if (name === "archiview_ui_get_project") return { root };
    assert.equal(name, "archiview_ui_get_comparison");
    if (failure) throw failure;
    started();
    return new Promise((resolve) => { finish = resolve; });
  } }) }, { timeoutMs: 10 });
  let outcome = "pending";
  const comparison = client.getComparison().then((result) => { outcome = "loaded"; return result; }, (error) => { outcome = error.code; throw error; });
  await loading;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(outcome, "pending", "Slow snapshots must not ask for the already resolved folder");
  finish(view);
  assert.deepEqual(await comparison, view);
  failure = Object.assign(new Error("Snapshot unavailable"), { code: "INCOMPLETE_VIEW" });
  await assert.rejects(client.getComparison(), failure);
  assert.deepEqual(calls, ["archiview_ui_get_project", "archiview_ui_get_comparison", "archiview_ui_get_comparison"]);
});

test("directory selection preserves cancellation and supports Unicode paths without changing the root", async () => {
  for (const projectRoot of [null, "D:\\Папка проекта\\Example"]) {
    assert.deepEqual(await chooseProjectDirectory({ platform: "win32", run: async () => ({ stdout: JSON.stringify({ projectRoot }) }) }), { projectRoot });
  }
  await assert.rejects(chooseProjectDirectory({ platform: "win32", run: async () => ({ stdout: '{"projectRoot":"relative"}' }) }), { code: "DIRECTORY_PICKER_UNAVAILABLE" });
  await assert.rejects(chooseProjectDirectory({ platform: "win32", run: async () => { throw new Error("Timed out"); } }), { code: "DIRECTORY_PICKER_UNAVAILABLE" });
  await assert.rejects(chooseProjectDirectory({ platform: "linux" }), { code: "DIRECTORY_PICKER_UNAVAILABLE" });
});

test("folder matching respects path boundaries, host identity and malformed responses", async (t) => {
  const { roots } = await fixture(t);
  for (const data of [hostData(roots[0] + "-other", [roots[0]]), { ...hostData(roots[0]), folders: { projects: [{ projectKind: "local", hostId: "another-host", path: roots[0] }] } }]) {
    const read = createHostContextReader({ pipePath: "fixture", connection: contextConnection(data) });
    assert.deepEqual(await read("chat-1"), { status: "unavailable" });
  }
  for (const data of [{ ...hostData(roots[0]), chat: { thread: { id: "another-chat", cwd: roots[0] } } }, { ...hostData(roots[0]), folders: {} }]) {
    const read = createHostContextReader({ pipePath: "fixture", connection: contextConnection(data) });
    assert.deepEqual(await read("chat-1"), { status: "unknown" });
  }
  const nested = createHostContextReader({ pipePath: "fixture", connection: contextConnection(hostData(path.join(roots[0], "child"), [roots[0]])) });
  assert.deepEqual(await nested("chat-1"), { status: "ready", root: path.join(roots[0], "child") });
});

test("context errors are retryable and another chat cannot silently replace the bound project", async (t) => {
  const { roots } = await fixture(t); let ready = false;
  const binding = await createCodexProjectBinding(undefined, { readContext: async (id) => ready ? { status: "ready", root: id === "chat-1" ? roots[0] : roots[1] } : { status: "unknown" } });
  await assert.rejects(binding.select(undefined, { threadId: "chat-1" }), { code: "CODEX_CONTEXT_UNAVAILABLE" });
  ready = true;
  assert.equal(await binding.select(undefined, { "openai/threadId": "chat-1" }), roots[0]);
  await assert.rejects(binding.select(undefined, { threadId: "chat-2" }), { code: "PROJECT_BOUND" });
  assert.equal(binding.root, roots[0]);
  const explicit = await createCodexProjectBinding(roots[1], { readContext: async () => ({ status: "ready", root: roots[0] }) });
  assert.equal(await explicit.select(undefined, { threadId: "chat-1" }), roots[1]);
});

/** Реальный pipe имитирует канал Codex, дробит ответы и принимает параллельные чтения. */
async function hostPipe(t: TestContext, data: { chat: unknown; folders: unknown }) {
  const address = process.platform === "win32" ? "\\\\.\\pipe\\archiview-project-" + randomUUID() : path.join(os.tmpdir(), "archiview-" + randomUUID() + ".sock");
  const calls: HostCall[] = [], sockets = new Set<net.Socket>();
  const handler = contextConnection(data, calls)();
  const server = net.createServer((socket) => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const length = buffer.readUInt32LE(0), request = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")); buffer = buffer.subarray(4 + length);
        handler.request(request.method, request.params).then((result) => {
          const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
          const frame = Buffer.alloc(4 + payload.length); frame.writeUInt32LE(payload.length); payload.copy(frame, 4);
          socket.write(frame.subarray(0, 2)); socket.write(frame.subarray(2));
        }).catch((error) => { socket.destroy(error); });
      }
    });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(address, resolve); });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  return { address, calls };
}

test("bundled plugin loads the selected folder on its first UI call and rejects projectless chats", async (t) => {
  const { roots, temporary, clients } = await fixture(t); const data = hostData(roots[0]);
  const pipe = await hostPipe(t, data);
  const distribution = path.join(temporary, "installed plugin");
  await cp(fileURLToPath(new URL("../dist/codex/", import.meta.url)), distribution, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(distribution, ".codex-plugin/plugin.json"), "utf8"));
  assert.equal(manifest.hooks, undefined);
  assert.equal(manifest.mcpServers, "./.mcp.json");
  await assert.rejects(readFile(path.join(distribution, "plugin.json")), { code: "ENOENT" });
  const mcp = JSON.parse(await readFile(path.join(distribution, ".mcp.json"), "utf8"));
  assert.ok(mcp.mcpServers.archiview.env_vars.includes("CODEX_APP_TOOLS_PIPE_PATH"));
  const client = new Client({ name: "codex-ui-test", version: "1" }); clients.push(client);
  const env: NodeJS.ProcessEnv = { ...process.env, PLUGIN_ROOT: distribution, CODEX_APP_TOOLS_PIPE_PATH: pipe.address };
  delete env.PLUGIN_ARCHITECTURE_CHANGE_VIEW_ROOT;
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(distribution, "src/server.mjs"), "--panel"], cwd: distribution, env: processEnvironment(env), stderr: "pipe" }));
  const project = await client.callTool({ name: "archiview_ui_get_project", arguments: {}, _meta: { threadId: "chat-1" } }).then(uiData);
  assert.deepEqual(project, { root: roots[0] });
  await assert.rejects(readFile(path.join(roots[0], ".archiview/project.json")), { code: "ENOENT" });
  const call = (threadId: string) => client.callTool({ name: "archiview_ui_get_comparison", arguments: {}, _meta: { threadId } }).then(uiData);
  assert.equal((await call("chat-1")).root, roots[0]);
  assert.deepEqual(pipe.calls.filter((call) => call.method === "tools/call").map((call) => call.params!.tool).sort(), ["list_projects", "read_thread"]);
  assert.ok(!(data.chat instanceof Error));
  data.chat.thread = { id: "chat-without-folder", cwd: roots[2], hostId: "local" };
  await assert.rejects(call("chat-without-folder"), { code: "PROJECT_UNAVAILABLE", message: "Плагин доступен только в проектах" });
  await assert.rejects(readFile(path.join(distribution, ".archiview/project.json")), { code: "ENOENT" });
});

test("host channel bounds waiting when a connected host never returns a response", async (t) => {
  const stalled = net.createServer(); const address = process.platform === "win32" ? "\\\\.\\pipe\\archiview-stall-" + randomUUID() : path.join(os.tmpdir(), "archiview-stall-" + randomUUID() + ".sock");
  const sockets = new Set<net.Socket>(); stalled.on("connection", (socket) => sockets.add(socket));
  await new Promise<void>((resolve) => stalled.listen(address, resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => stalled.close(() => resolve())); });
  const waiting = createHostConnection(address, { timeoutMs: 50 });
  await assert.rejects(waiting.request("tools/list", {}), /timed out/);
  waiting.close();
});
