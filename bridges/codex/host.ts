import net from "node:net";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Adapter, ProjectTarget } from "../../web/web-backend/host-bridge/channel.js";

type Data = Record<string, unknown>;
function object(value: unknown): Data {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Некорректный ответ Codex Desktop");
  return value as Data;
}

/** Codex Desktop's local App Tools transport uses length-prefixed JSON-RPC frames. */
async function rpc(pipe: string, method: string, params: Data) {
  const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(payload.length);
  const socket = net.createConnection(pipe);
  try {
    return await new Promise<Data>((resolve, reject) => {
      socket.setTimeout(method === "tools/list" ? 2500 : 45000, () => socket.destroy(new Error("Codex Desktop не ответил")));
      socket.once("connect", () => socket.write(Buffer.concat([prefix, payload])));
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("Соединение с Codex Desktop закрыто")));
      let buffer = Buffer.alloc(0);
      socket.on("data", chunk => {
        try {
          buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
          if (buffer.length < 4) return;
          const size = buffer.readUInt32LE();
          if (size > 8 * 1024 * 1024) throw new Error("Слишком большой ответ Codex Desktop");
          if (buffer.length < 4 + size) return;
          const response = object(JSON.parse(buffer.toString("utf8", 4, 4 + size)));
          if (response.error) throw new Error(String(object(response.error).message));
          resolve(object(response.result));
        } catch (error) { reject(error); }
      });
    });
  } finally { socket.destroy(); }
}

export async function desktopStatus(pipe: string): Promise<"ready" | "unresponsive" | "disconnected"> {
  try {
    await rpc(pipe, "tools/list", { threadStartKind: "all" });
    return "ready";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ECONNREFUSED" ? "disconnected" : "unresponsive";
  }
}

export function codexAdapter(pipe: string, context: () => { threadId?: string; hostId?: string } | Promise<{ threadId?: string; hostId?: string }>, transport = rpc): Adapter {
  async function tool(name: "list_projects" | "create_thread", args: Data) {
    const result = await transport(pipe, "tools/call", { ...await context(), tool: name, arguments: args,
      namespace: "codex_app", callerSource: "codex", callId: randomUUID(), turnId: "archiview-" + randomUUID() });
    const items = Array.isArray(result.contentItems) ? result.contentItems.map(object) : [];
    const text = items.find(item => item.type === "inputText")?.text;
    if (result.success !== true || typeof text !== "string") throw new Error(typeof text === "string" ? text : "Codex отклонил " + name);
    return object(JSON.parse(text));
  }
  async function project(target: ProjectTarget) {
    const result = await tool("list_projects", {});
    const hostId = (await context()).hostId || "local";
    const projects = Array.isArray(result.projects) ? result.projects.map(object) : [];
    for (const root of [target.repositoryRoot, target.workspaceRoot]) {
      const found = projects.find(p => p.projectKind === "local" && p.hostId === hostId &&
        typeof p.path === "string" && path.relative(p.path, root) === "");
      if (typeof found?.projectId === "string") return found.projectId;
    }
  }
  const missingProject = "Добавьте репозиторий или рабочую папку ArchiView в проекты Codex";
  return {
    kind: "codex", instance: pipe,
    async available(target) {
      const catalogue = await transport(pipe, "tools/list", { threadStartKind: "all" });
      const tools = Array.isArray(catalogue.tools) ? catalogue.tools.map(object) : [];
      if (!tools.some(t => t.namespace === "codex_app" && t.name === "create_thread")) throw new Error("Создание чатов недоступно");
      if (!(await context()).threadId) return "В чате Codex вызовите archiview_connect";
      return (await project(target)) ? undefined : missingProject;
    },
    async start(job) {
      const projectId = await project(job);
      if (!projectId) throw new Error(missingProject);
      const value = await tool("create_thread", { target: { type: "project", projectId, environment: { type: "local" } },
        title: "ArchiView · " + job.moduleId, prompt: job.prompt });
      if (typeof value.threadId !== "string") throw new Error("Codex не подтвердил идентификатор созданного чата");
      return value.threadId;
    },
  };
}
