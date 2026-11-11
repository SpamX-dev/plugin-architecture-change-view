/**
 * Чтение контекста через канал, который Codex предоставляет собственному App Tools.
 * Допустимы только операции чтения метаданных текущего чата и рабочих папок.
 * Универсальный прокси для UI здесь не публикуется.
 */
import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Тот же предел кадра, что у поставляемого Codex App Tools. */
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/**
 * Один короткоживущий сеанс JSON-RPC поверх именованного pipe/Unix socket хоста.
 * При таймауте или разрыве закрывает соединение и отклоняет ожидающие ответы.
 */
export function createHostConnection(pipePath: string, { timeoutMs = 5000 } = {}) {
  let socket: net.Socket | undefined;
  let connecting: Promise<void> | undefined;
  let serial = 0, buffer: Buffer = Buffer.alloc(0);
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
  function close(error: unknown = new Error("Codex context channel closed")) {
    socket?.destroy();
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(error); }
    pending.clear();
  }
  function connect() {
    if (connecting) return connecting;
    connecting = new Promise<void>((resolve, reject) => {
      socket = net.createConnection(pipePath);
      const timer = setTimeout(() => { const error = new Error("Codex context connection timed out"); reject(error); close(error); }, timeoutMs);
      socket.once("connect", () => { clearTimeout(timer); resolve(); });
      socket.on("error", (error) => { clearTimeout(timer); reject(error); close(error); });
      socket.once("close", () => { clearTimeout(timer); reject(new Error("Codex context channel closed")); close(); });
      socket.on("data", (chunk) => {
        buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
        try {
          while (buffer.length >= 4) {
            const length = buffer.readUInt32LE(0);
            if (length > MAX_FRAME_BYTES) throw new Error("Codex context response was too large");
            if (buffer.length < 4 + length) return;
            const response = record(JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")));
            if (typeof response.id !== "number") throw new Error("Invalid Codex context response identifier");
            buffer = buffer.subarray(4 + length);
            const request = pending.get(response.id);
            if (!request) continue;
            pending.delete(response.id); clearTimeout(request.timer);
            if (response.error) {
              const error = record(response.error);
              request.reject(new Error(typeof error.message === "string" ? error.message : "Codex context request failed"));
            }
            else request.resolve(response.result);
          }
        } catch (error) { close(error); }
      });
    });
    return connecting;
  }
  return {
    async request(method: string, params: Record<string, unknown>): Promise<unknown> {
      await connect();
      const id = ++serial;
      const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
      if (payload.length > MAX_FRAME_BYTES) throw new Error("Codex context request was too large");
      const frame = Buffer.alloc(4 + payload.length); frame.writeUInt32LE(payload.length); payload.copy(frame, 4);
      return new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => close(new Error("Codex context request timed out")), timeoutMs);
        pending.set(id, { resolve, reject, timer });
        socket!.write(frame);
      });
    },
    close,
  };
}

/** Из результата App Tools используются только метаданные чата и каталог папок. */
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Codex context object");
  return value as Record<string, unknown>;
}
function toolData(value: unknown): Record<string, unknown> {
  const result = record(value);
  if (result.success !== true) throw new Error("Codex could not read project context");
  for (const value of Array.isArray(result.contentItems) ? result.contentItems : []) {
    const item = record(value);
    if (item.type === "inputText" && typeof item.text === "string") return record(JSON.parse(item.text));
  }
  throw new Error("Codex did not return project context");
}

/** Рабочая папка может быть вложена в зарегистрированную папку проекта; projectId для этого не требуется. */
function within(root: string, directory: string) {
  const relative = path.relative(root, directory);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
}

/**
 * Использует метаданные чата, а до появления истории — рабочую папку, с которой
 * хост запустил MCP-процесс. Оба пути проверяются по каталогу папок того же хоста.
 * Каталог установки не является резервным проектом; неизвестный контекст
 * не выдаётся за отсутствие проекта. После привязки резервный cwd отключается.
 */
export function createHostContextReader({ pipePath = process.env.CODEX_APP_TOOLS_PIPE_PATH,
  callerHostId = process.env.CODEX_APP_TOOLS_CALLER_HOST_ID, connection = createHostConnection,
  startupDirectory = process.cwd(), installedRoot = process.env.PLUGIN_ROOT } = {}) {
  return async (threadId: string, { allowStartupDirectory = true } = {}): Promise<HostProjectContext> => {
    if (!pipePath) return { status: "unknown" };
    const host = connection(pipePath);
    try {
      const catalogue = record(await host.request("tools/list", { threadStartKind: "all" }));
      async function read(toolName: string, args: Record<string, unknown>) {
        const tool = (Array.isArray(catalogue.tools) ? catalogue.tools : []).map(record).find((candidate) => candidate.name === toolName && candidate.namespace === "codex_app");
        if (!tool) throw new Error("Codex context tool unavailable");
        return toolData(await host.request("tools/call", { arguments: args, callerSource: "codex", namespace: tool.namespace,
          ...(callerHostId ? { hostId: callerHostId } : {}), threadId, tool: toolName, callId: randomUUID(), turnId: "mcp-ui-" + randomUUID() }));
      }
      const [chatResult, projectsResult] = await Promise.allSettled([
        read("read_thread", { threadId, turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 0 }), read("list_projects", {}),
      ]);
      if (projectsResult.status !== "fulfilled" || !Array.isArray(projectsResult.value.projects)) return { status: "unknown" };
      const catalogueProjects = projectsResult.value;
      const thread = chatResult.status === "fulfilled" && chatResult.value.thread ? record(chatResult.value.thread) : undefined;
      if (thread && (thread.id !== threadId || typeof thread.cwd !== "string" || !path.isAbsolute(thread.cwd))) return { status: "unknown" };
      const validStartup = allowStartupDirectory && typeof startupDirectory === "string" && path.isAbsolute(startupDirectory) &&
        !(typeof installedRoot === "string" && path.isAbsolute(installedRoot) && within(installedRoot, startupDirectory));
      const root = typeof thread?.cwd === "string" ? thread.cwd : (validStartup ? startupDirectory : undefined);
      if (!root) return { status: "unknown" };
      const hostId = thread?.hostId ?? callerHostId ?? "local";
      const folders = (catalogueProjects.projects as unknown[]).map(record).filter((project) => project.projectKind === "local" &&
        project.hostId === hostId && typeof project.path === "string" && path.isAbsolute(project.path));
      return folders.some((project) => typeof project.path === "string" && within(project.path, root)) ? { status: "ready", root } : { status: "unavailable" };
    } catch { return { status: "unknown" }; }
    finally { host.close(); }
  };
}

export type HostProjectContext = { status: "ready"; root: string } | { status: "unknown" | "unavailable" };
