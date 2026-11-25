import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { harnessInstanceId, listHarnesses, registerHarness } from "../../web/web-backend/host-bridge/channel.js";
import { codexAdapter, desktopStatus } from "./host.js";
import { callerThread, desktopBinding } from "./context.js";

/** The host owns this MCP process. Registration ends when its stdio transport closes. */
const pipe = process.env.CODEX_APP_TOOLS_PIPE_PATH;
const environment = { threadId: process.env.CODEX_THREAD_ID, hostId: process.env.CODEX_APP_TOOLS_CALLER_HOST_ID };
const binding = pipe && desktopBinding(pipe, environment);
if (process.argv.includes("--connect")) {
  if (!binding || !environment.threadId) throw new Error("Выполните --connect из локального чата Codex Desktop");
  if (await desktopStatus(pipe!) !== "ready") throw new Error("Codex Desktop недоступен");
  await binding.connect(environment.threadId);
  const target = { workspaceRoot: process.cwd(), repositoryRoot: process.cwd() };
  if (!(await listHarnesses(target)).harnesses.some(host => host.id === harnessInstanceId("codex", pipe!))) {
    // An already open chat can still have its previous MCP catalogue after installation.
    const child = fork(fileURLToPath(import.meta.url), ["--desktop-worker"], {
      detached: true, windowsHide: true, stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Истекло время подключения ArchiView")), 10000);
        child.once("message", () => { clearTimeout(timeout); resolve(); });
        child.once("error", error => { clearTimeout(timeout); reject(error); });
        child.once("exit", () => { clearTimeout(timeout); reject(new Error("Мост Codex завершился при запуске")); });
      });
    } catch (error) { child.kill(); throw error; }
    if (child.connected) child.disconnect();
    child.unref();
  }
  process.stdout.write("ArchiView подключён к Codex Desktop.\n");
  process.exit(0);
}
if (process.argv.includes("--desktop-worker")) {
  if (!pipe || !binding) throw new Error("Нет канала Codex Desktop");
  const close = await registerHarness(codexAdapter(pipe, binding.read));
  process.send?.("ready");
  let missingProbes = 0;
  while (missingProbes < 2) {
    await delay(15000, undefined, { ref: false });
    missingProbes = await desktopStatus(pipe) === "disconnected" ? missingProbes + 1 : 0;
  }
  await close();
} else await serveMcp();

async function serveMcp() {
  let registration: ReturnType<typeof registerHarness> | undefined;
  function register() {
    if (!pipe || !binding) throw new Error("Требуется локальный Codex Desktop");
    registration ??= registerHarness(codexAdapter(pipe, binding.read)).catch(error => {
      registration = undefined;
      throw error;
    });
    return registration;
  }
  const lines = createInterface({ input: process.stdin });
  function send(id: unknown, value: object) {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, ...value }) + "\n");
  }
  for await (const line of lines) {
    let message;
    try { message = JSON.parse(line); } catch { send(null, { error: { code: -32700, message: "Invalid JSON" } }); continue; }
    if (!message || typeof message !== "object" || message.id === undefined) continue;
    if (message.method === "initialize") {
      if (pipe && binding) void register().catch(error => process.stderr.write(String(error) + "\n"));
      send(message.id, { result: { protocolVersion: message.params?.protocolVersion ?? "2025-11-25",
        capabilities: { tools: {} }, serverInfo: { name: "archiview-bridge", version: "1.0.0" } } });
    } else if (message.method === "tools/list") send(message.id, { result: { tools: [{ name: "archiview_connect",
      description: "Зарегистрировать текущий Codex Desktop в локальном ArchiView по запросу пользователя.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false } }] } });
    else if (message.method === "tools/call" && message.params?.name === "archiview_connect") {
      try {
        const id = callerThread(message.params._meta) ?? environment.threadId;
        if (!binding || !id) throw new Error("Требуется контекст локального чата Codex Desktop");
        await binding.connect(id);
        await register();
        send(message.id, { result: { content: [{ type: "text", text: "Codex Desktop зарегистрирован в ArchiView." }] } });
      } catch (error) {
        send(message.id, { result: { isError: true, content: [{ type: "text", text: String(error) }] } });
      }
    } else if (message.method === "ping") send(message.id, { result: {} });
    else send(message.id, { error: { code: -32601, message: "Method not found" } });
  }
  await (await registration)?.();
}
