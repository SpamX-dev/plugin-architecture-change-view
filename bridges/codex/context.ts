import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { bridgeDirectory } from "../../web/web-backend/host-bridge/channel.js";

type Caller = { threadId?: string; hostId?: string };

/** All MCP children of the same running Desktop share the context explicitly connected by a user. */
export function desktopBinding(pipe: string, environment: Caller) {
  const dir = bridgeDirectory();
  const file = path.join(dir, "codex-" + createHash("sha256").update(pipe).digest("hex") + ".context");
  return {
    async read(): Promise<Caller> {
      if (environment.threadId) return environment;
      try {
        const data = JSON.parse(await readFile(file, "utf8"));
        return typeof data?.threadId === "string" ? { threadId: data.threadId, hostId: environment.hostId } : environment;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return environment;
      }
    },
    async connect(threadId: string) {
      if (!threadId.trim()) throw new Error("Codex не передал ID текущего чата");
      await mkdir(dir, { recursive: true, mode: 0o700 });
      const temp = file + "." + randomUUID();
      try {
        await writeFile(temp, JSON.stringify({ threadId }), { mode: 0o600, flag: "wx" });
        await rename(temp, file);
      } finally { await rm(temp, { force: true }); }
    },
  };
}

export function callerThread(meta: Record<string, unknown> = {}): string | undefined {
  for (const key of ["openai/threadId", "openai/thread_id", "codexThreadId", "codex_thread_id", "threadId", "thread_id"]) {
    if (typeof meta[key] === "string" && meta[key]) return meta[key];
  }
  const turn = meta["x-codex-turn-metadata"];
  try {
    const info = typeof turn === "string" ? JSON.parse(turn) : turn;
    if (typeof info?.thread_id === "string") return info.thread_id;
  } catch { /* Other host metadata can still identify the thread. */ }
  const thread = meta.thread;
  if (thread && typeof thread === "object" && "id" in thread && typeof thread.id === "string") return thread.id;
}
