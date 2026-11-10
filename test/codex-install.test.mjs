/** Проверка конфигурации после установки и обнаружения боковой панели нативным загрузчиком Codex. */
import assert from "node:assert/strict";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { configureInstalledCodexPlugin } from "../scripts/install-plugin.mjs";

/** Копия автономного пакета; процессы закрываются раньше удаления установленных файлов. */
async function fixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "archiview-install-"));
  const cleanup = [];
  t.after(async () => { for (const close of cleanup) await close(); await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  const plugin = path.join(directory, "plugins", "Плагин с пробелами");
  await cp(fileURLToPath(new URL("../dist/codex/", import.meta.url)), plugin, { recursive: true });
  return { directory, plugin, cleanup };
}

/**
 * Настоящий дочерний Node играет роль CLI во временной установке Windows.
 * Его PATH не содержит Codex; фиктивный CLI только возвращает принадлежащий тесту
 * пакет и аргументы. Пользовательская конфигурация Codex не читается и не меняется.
 */
async function installerFixture(t) {
  const { directory, plugin } = await fixture(t);
  const localAppData = path.join(directory, "Local AppData");
  const executable = path.join(localAppData, "OpenAI", "Codex", "bin", "current build", "codex.exe");
  await mkdir(path.dirname(executable), { recursive: true });
  await copyFile(process.execPath, executable);
  // Аргументы фиксируются отдельно, чтобы проверить запуск без shell и потерянных пробелов.
  await writeFile(path.join(directory, "plugin"), "process.stdout.write(JSON.stringify({ ..." +
    JSON.stringify({ pluginId: "archiview@archiview-local", installedPath: plugin }) +
    ", arguments: process.argv.slice(2) }));");
  const env = { ...process.env, LOCALAPPDATA: localAppData };
  for (const key of Object.keys(env)) if (["path", "archiview_codex_executable"].includes(key.toLowerCase())) delete env[key];
  env.PATH = directory;
  const installer = pathToFileURL(fileURLToPath(new URL("../scripts/install-plugin.mjs", import.meta.url))).href;
  const script = "import { installCodexPlugin } from " + JSON.stringify(installer) + "; " +
    "console.log(JSON.stringify(await installCodexPlugin({ cwd: " + JSON.stringify(directory) + " })));";
  const run = () => promisify(execFile)(process.execPath, ["--input-type=module", "--eval", script],
    { cwd: directory, env, windowsHide: true });
  return { directory, plugin, localAppData, executable, env, run };
}

test("Windows installer finds the application CLI without PATH and ignores other runtime builds", { skip: process.platform !== "win32" }, async (t) => {
  const { plugin, localAppData, run } = await installerFixture(t);
  const bin = path.join(localAppData, "OpenAI", "Codex", "bin");
  await mkdir(path.join(bin, "newer node runtime"));
  await writeFile(path.join(bin, "newer node runtime", "node.exe"), "not a Codex CLI");
  const obsolete = path.join(bin, "old build", "codex.exe");
  await mkdir(path.dirname(obsolete));
  await writeFile(obsolete, "not executable");
  await utimes(obsolete, new Date(0), new Date(0));
  const installed = JSON.parse((await run()).stdout);
  assert.equal(installed.mcpPathsResolved, true);
  assert.equal(installed.installedPath, await realpath(plugin));
  assert.deepEqual(installed.arguments, ["add", "archiview@archiview-local", "--json"]);
  const configuration = JSON.parse(await readFile(path.join(plugin, ".mcp.json"), "utf8"));
  assert.equal(path.normalize(configuration.mcpServers.archiview.args[0]), path.join(installed.installedPath, "src/server.mjs"));
  assert.equal(configuration.mcpServers.archiview.cwd, undefined);
});

test("Windows installer accepts an explicit CLI path and reports a missing CLI clearly", { skip: process.platform !== "win32" }, async (t) => {
  const { plugin, executable, env, run } = await installerFixture(t);
  env.LOCALAPPDATA += "-not-installed";
  env.ARCHIVIEW_CODEX_EXECUTABLE = executable;
  assert.equal(JSON.parse((await run()).stdout).mcpPathsResolved, true);
  const preserved = await readFile(path.join(plugin, ".mcp.json"), "utf8");
  delete env.ARCHIVIEW_CODEX_EXECUTABLE;
  await assert.rejects(run(), (error) => error.stderr.includes("Не найден CLI Codex") && error.stderr.includes("ARCHIVIEW_CODEX_EXECUTABLE"));
  assert.equal(await readFile(path.join(plugin, ".mcp.json"), "utf8"), preserved);
});

test("installed configuration starts from another cwd without host placeholder substitution", async (t) => {
  const { directory, plugin, cleanup } = await fixture(t);
  const template = await readFile(path.join(plugin, ".mcp.json"), "utf8");
  const configured = await configureInstalledCodexPlugin(plugin);
  const server = configured.configuration.mcpServers.archiview;
  assert.equal(path.normalize(server.args[0]), path.join(configured.installedPath, "src/server.mjs"));
  assert.equal(server.cwd, undefined);
  assert.equal(server.env.PLUGIN_ROOT, configured.installedPath);
  assert.equal(await readFile(path.join(plugin, ".mcp.json.template"), "utf8"), template);
  const normalized = await readFile(path.join(plugin, ".mcp.json"), "utf8");
  await configureInstalledCodexPlugin(plugin);
  assert.equal(await readFile(path.join(plugin, ".mcp.json"), "utf8"), normalized);
  assert.equal(await readFile(path.join(plugin, ".mcp.json.template"), "utf8"), template);
  const client = new Client({ name: "raw-installed-config-test", version: "1" });
  cleanup.push(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: server.args,
    cwd: directory, env: server.env, stderr: "pipe" }));
  const tool = (await client.listTools()).tools.find((item) => item.name === "archiview_open");
  assert.deepEqual(tool._meta["openai/ui"].entrypoints, [{ type: "thread" }]);
});

test("installer refuses a different plugin manifest", async (t) => {
  const { plugin } = await fixture(t);
  const file = path.join(plugin, ".codex-plugin/plugin.json");
  const manifest = JSON.parse(await readFile(file, "utf8"));
  manifest.name = "another-plugin";
  await writeFile(file, JSON.stringify(manifest));
  await assert.rejects(configureInstalledCodexPlugin(plugin), /Unexpected installed ArchiView manifest/);
});

test("reconfiguring an old installation restores the native chat cwd", async (t) => {
  const { plugin } = await fixture(t);
  await configureInstalledCodexPlugin(plugin);
  const file = path.join(plugin, ".mcp.json");
  const configuration = JSON.parse(await readFile(file, "utf8"));
  configuration.mcpServers.archiview.cwd = plugin;
  await writeFile(file, JSON.stringify(configuration));
  const configured = await configureInstalledCodexPlugin(plugin);
  assert.equal(configured.configuration.mcpServers.archiview.cwd, undefined);
});

/** Необязательная проверка настоящего Codex: отдельный профиль и ephemeral-сеанс без turn/start и LLM. */
test("native Codex loader discovers a connected thread-only panel", { skip: !process.env.ARCHIVIEW_CODEX_TEST_EXECUTABLE, timeout: 30000 }, async (t) => {
  const { directory, plugin, cleanup } = await fixture(t);
  const profile = path.join(directory, "profile"), project = path.join(directory, "workspace");
  const marketplace = path.join(directory, ".agents/plugins/marketplace.json");
  await mkdir(profile); await mkdir(project); await mkdir(path.dirname(marketplace), { recursive: true });
  await writeFile(marketplace, JSON.stringify({ name: "fixture", plugins: [{ name: "archiview", source: {
    source: "local", path: "./" + path.relative(directory, plugin).replaceAll("\\", "/"),
  }, policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Developer Tools" }] }));
  await writeFile(path.join(profile, "config.toml"), `[marketplaces.fixture]\nsource_type = "local"\nsource = ${JSON.stringify(directory.replaceAll("\\", "/"))}\n[plugins."archiview@fixture"]\nenabled = true\n`);
  const executable = process.env.ARCHIVIEW_CODEX_TEST_EXECUTABLE;
  // Пустой чат ещё не имеет доступной истории, но хост знает выбранную папку.
  const contextPipe = process.platform === "win32" ? "\\\\.\\pipe\\archiview-cold-" + randomUUID() : path.join(directory, "context.sock");
  const sockets = new Set();
  const host = net.createServer((socket) => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
        const length = buffer.readUInt32LE(0), request = JSON.parse(buffer.subarray(4, 4 + length));
        buffer = buffer.subarray(4 + length);
        const result = request.method === "tools/list" ? { tools: ["read_thread", "list_projects"].map((name) => ({ name, namespace: "codex_app" })) } :
          request.params.tool === "read_thread" ? { success: false, contentItems: [{ type: "inputText", text: "Chat has no persisted history" }] } :
            { success: true, contentItems: [{ type: "inputText", text: JSON.stringify({ projects: [{ projectKind: "local", hostId: "local", path: project }] }) }] };
        const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
        const frame = Buffer.alloc(4 + payload.length); frame.writeUInt32LE(payload.length); payload.copy(frame, 4); socket.write(frame);
      }
    });
  });
  await new Promise((resolve, reject) => { host.once("error", reject); host.listen(contextPipe, resolve); });
  cleanup.push(async () => { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => host.close(resolve)); });
  const env = { ...process.env, CODEX_HOME: profile, USERPROFILE: profile, CODEX_APP_TOOLS_PIPE_PATH: contextPipe, CODEX_APP_TOOLS_CALLER_HOST_ID: "local" };
  const installed = JSON.parse((await promisify(execFile)(executable, ["plugin", "add", "archiview@fixture", "--json"], { env, windowsHide: true })).stdout);
  await configureInstalledCodexPlugin(installed.installedPath);
  const native = spawn(executable, ["app-server"], { cwd: directory, env, windowsHide: true });
  let serial = 0, errors = "";
  const pending = new Map();
  native.stderr.on("data", (chunk) => { errors += chunk; });
  createInterface({ input: native.stdout }).on("line", (line) => {
    const result = JSON.parse(line), request = pending.get(result.id);
    if (!request) return;
    pending.delete(result.id); clearTimeout(request.timer);
    if (result.error) request.reject(new Error(JSON.stringify(result.error))); else request.resolve(result.result);
  });
  cleanup.push(async () => {
    for (const request of pending.values()) clearTimeout(request.timer);
    if (native.exitCode !== null || native.signalCode !== null) return;
    await new Promise((resolve) => {
      const timer = setTimeout(() => { native.kill(); resolve(); }, 3000);
      native.once("exit", () => { clearTimeout(timer); resolve(); });
      native.stdin.end();
    });
  });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Timed out: " + method)); }, 10000);
    pending.set(id, { resolve, reject, timer }); native.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
  try {
    await rpc("initialize", { clientInfo: { name: "archiview_native_loader_test", version: "1" }, capabilities: { experimentalApi: true } });
    native.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const thread = await rpc("thread/start", { cwd: project, ephemeral: true, approvalPolicy: "never", sandbox: "danger-full-access" });
    // thread/start может вернуться до подключения MCP. Ждём готовность, но
    // немедленно показываем ошибку завершившегося запуска вместо повторных попыток.
    const deadline = Date.now() + 10000;
    let server;
    do {
      const inventory = await rpc("mcpServerStatus/list", { threadId: thread.thread.id });
      server = inventory.data.find((item) => item.pluginId === "archiview@fixture");
      if (server && server.runtimeStatus !== "starting") break;
      await delay(100);
    } while (Date.now() < deadline);
    assert.ok(server, "Installed plugin must expose its MCP server");
    assert.equal(server.runtimeStatus, "connected", server.toolsError);
    const tool = server.tools.archiview_open;
    assert.ok(tool, "Connected server must publish the panel entrypoint");
    assert.deepEqual(tool._meta["openai/ui"].entrypoints, [{ type: "thread" }]);
    const projectContext = await rpc("mcpServer/tool/call", { threadId: thread.thread.id, server: server.name, tool: "archiview_ui_get_project", arguments: {} });
    assert.deepEqual(projectContext.content, []);
    assert.equal(projectContext.structuredContent, undefined);
    assert.equal(projectContext._meta?.result?.root, project, "First UI call resolves the workspace without reading snapshots");
    await assert.rejects(readFile(path.join(project, ".archiview/project.json")), { code: "ENOENT" });
    const opened = await rpc("mcpServer/tool/call", { threadId: thread.thread.id, server: server.name, tool: "archiview_open", arguments: {} });
    assert.notEqual(opened.isError, true, "Cold opening must not fail before the host loads the UI");
    assert.equal(opened.structuredContent?.root, project, "Cold opening uses the workspace supplied to native Codex");
    const resource = await rpc("mcpServer/resource/read", { threadId: thread.thread.id, server: server.name, uri: tool._meta.ui.resourceUri });
    assert.ok(resource.contents.some((item) => item.mimeType === "text/html;profile=mcp-app" && item.text.includes("ui/initialize")));
  } catch (error) { t.diagnostic(errors); throw error; }
});
