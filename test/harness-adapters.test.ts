import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { codexAdapter } from "../bridges/codex/host.js";
import { callerThread, desktopBinding } from "../bridges/codex/context.js";
import { dshAdapter } from "../bridges/dsh/host.js";
import { connectHarness, harnessInstanceId } from "../web/web-backend/host-bridge/channel.js";

const workspaceRoot = path.resolve("workspace");
const repositoryRoot = path.join(workspaceRoot, "repository");
const job = { workspaceRoot, repositoryRoot, moduleId: "test-module", requestId: "0c7c8927-540a-45b8-9474-13dd0f908c5d", prompt: "Test assignment" };

test("Codex discovers the exact local project, falls back to the workspace and preserves model defaults", async () => {
  const projects = [
    { projectKind: "local", hostId: "other", path: repositoryRoot, projectId: "other-machine" },
    { projectKind: "local", hostId: "local", path: workspaceRoot, projectId: "workspace" },
    { projectKind: "local", hostId: "local", path: repositoryRoot, projectId: "repository" },
  ];
  const calls: unknown[] = [];
  const adapter = codexAdapter("test-desktop", () => ({threadId: "caller"}), async (_pipe, method, params) => {
    if (method === "tools/list") return { tools: [{namespace:"codex_app", name:"create_thread"}] };
    assert.equal(params.threadId, "caller");
    const result = params.tool === "list_projects" ? { projects } : { threadId: "new-thread" };
    if (params.tool === "create_thread") calls.push(params.arguments);
    return { success: true, contentItems: [{type:"inputText", text: JSON.stringify(result)}] };
  });
  assert.equal(await adapter.available(job), undefined);
  for (const projectId of ["repository", "workspace"]) {
    assert.equal(await adapter.start(job), "new-thread");
    assert.deepEqual(calls.at(-1), { title: "ArchiView · test-module", prompt: job.prompt,
      target: { type: "project", projectId, environment: {type:"local"} } });
    projects.pop();
  }
  assert.match(await adapter.available(job) ?? "", /Добавьте репозиторий/);
  await assert.rejects(adapter.start(job), /Добавьте репозиторий/);
  assert.equal(calls.length, 2);
});

test("Codex worker delivers after a timed-out heartbeat and unregisters when the Desktop endpoint closes", { timeout: 60000 }, async t => {
  const folder = await mkdtemp(path.join(tmpdir(), "archiview-worker-"));
  const previous = process.env.ARCHIVIEW_BRIDGE_DIR;
  process.env.ARCHIVIEW_BRIDGE_DIR = folder;
  t.after(async () => {
    if (previous === undefined) delete process.env.ARCHIVIEW_BRIDGE_DIR;
    else process.env.ARCHIVIEW_BRIDGE_DIR = previous;
    await rm(folder, { recursive: true, force: true });
  });

  const name = "archiview-test-" + randomUUID();
  const pipe = process.platform === "win32" ? "\\\\.\\pipe\\" + name : path.join("/tmp", name + ".sock");
  let heartbeatTimedOut!: () => void;
  const timeout = new Promise<void>(resolve => { heartbeatTimedOut = resolve; });
  let dropFirstHeartbeat = true;
  const prompts: string[] = [];
  const desktop = createServer(socket => {
    let frame = Buffer.alloc(0);
    socket.on("data", chunk => {
      frame = Buffer.concat([frame, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
      if (frame.length < 4 || frame.length < 4 + frame.readUInt32LE()) return;
      const { method, params } = JSON.parse(frame.toString("utf8", 4));
      if (method === "tools/list" && dropFirstHeartbeat) {
        dropFirstHeartbeat = false;
        socket.once("close", heartbeatTimedOut);
        return;
      }
      let result;
      if (method === "tools/list") result = { tools: [{ namespace: "codex_app", name: "create_thread" }] };
      else {
        const projects = [{ projectKind: "local", hostId: "local", path: repositoryRoot, projectId: "project" }];
        if (params.tool === "create_thread") prompts.push(params.arguments.prompt);
        const text = JSON.stringify(params.tool === "list_projects" ? { projects } : { threadId: "next-chat" });
        result = { success: true, contentItems: [{ type: "inputText", text }] };
      }
      const response = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32LE(response.length);
      socket.end(Buffer.concat([prefix, response]));
    });
  });
  desktop.listen(pipe);
  await once(desktop, "listening");
  t.after(() => { if (desktop.listening) desktop.close(); });
  const worker = fork(new URL("../bridges/codex/server.ts", import.meta.url), ["--desktop-worker"], {
    execArgv: ["--import", "tsx"], windowsHide: true,
    env: { ...process.env, CODEX_APP_TOOLS_PIPE_PATH: pipe, CODEX_THREAD_ID: "caller", CODEX_APP_TOOLS_CALLER_HOST_ID: "local" },
  });
  const exit = once(worker, "exit");
  t.after(() => { if (worker.exitCode === null && worker.signalCode === null) worker.kill(); });
  await once(worker, "message", { signal: t.signal });
  worker.disconnect();
  await timeout;
  const harness = await connectHarness(harnessInstanceId("codex", pipe), job);
  assert.equal(await harness.start(job), "next-chat");
  assert.deepEqual(prompts, [job.prompt]);
  await new Promise<void>(resolve => desktop.close(() => resolve()));
  assert.deepEqual(await exit, [0, null]);
  assert.deepEqual(await readdir(folder), []);
});

test("DeepSeek attaches a new session to the matching workspace or opens the repository by cwd", async () => {
  const projects = [{id:"parent", path:workspaceRoot}, {id:"exact", path:repositoryRoot}];
  const requests: unknown[] = [];
  const sessionId = "session-" + job.requestId;
  const adapter = dshAdapter({ workspaceRegistry: { list: () => projects }, sessionController: {
    async create(args) { requests.push(args); return {sessionId}; },
    async prompt(args) {
      assert.deepEqual(args, { sessionId, requestId: job.requestId, mode:"queue", content:[{type:"text", text:job.prompt}] });
      return {accepted:true};
    },
  } });
  for (const location of [{workspaceId:"exact"}, {workspaceId:"parent"}, {cwd:repositoryRoot}]) {
    assert.equal(await adapter.start(job), sessionId);
    assert.deepEqual(requests.at(-1), {sessionId, ...location});
    projects.pop();
  }
});

test("MCP uses host metadata and shares an explicit binding only within the same Desktop", async t => {
  const previous = process.env.ARCHIVIEW_BRIDGE_DIR;
  const directory = await mkdtemp(path.join(tmpdir(), "archiview-context-"));
  process.env.ARCHIVIEW_BRIDGE_DIR = directory;
  t.after(async () => {
    if (previous === undefined) delete process.env.ARCHIVIEW_BRIDGE_DIR;
    else process.env.ARCHIVIEW_BRIDGE_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  });
  const id = callerThread({"x-codex-turn-metadata": JSON.stringify({thread_id:"native-thread"})});
  assert.equal(id, "native-thread");
  const writer = desktopBinding("desktop-1", { threadId:id });
  await writer.connect(id!);
  assert.equal((await desktopBinding("desktop-1", {}).read()).threadId, id);
  assert.equal((await desktopBinding("desktop-2", {}).read()).threadId, undefined);
  assert.equal(callerThread({}), undefined);
});
