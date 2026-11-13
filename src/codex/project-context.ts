/** Привязка панели к рабочей папке чата Codex, независимо от projectId и наличия сообщений. */
import { createProjectBinding } from "../application/project.js";
import { ApplicationError } from "../application/errors.js";
import { createHostContextReader } from "./host-context.js";

/** Идентификатор берётся только из метаданных хоста, а не из аргументов инструмента модели. */
export function threadIdFromMetadata(metadata?: Record<string, unknown>) {
  for (const key of ["threadId", "openai/threadId", "openai/thread_id", "codexThreadId", "codex_thread_id", "thread_id"]) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/**
 * Общая прикладная привязка остаётся неизменяемой. Codex-адаптер получает папку
 * до создания сессии; сериализация первых обращений исключает конкурирующие корни.
 * Если у чата нет доступной рабочей папки, пользователь может явно выбрать её.
 */
export async function createCodexProjectBinding(initialRoot?: string, { readContext = createHostContextReader() } = {}) {
  const project = await createProjectBinding(initialRoot);
  let boundThread: string | undefined;
  let queue = Promise.resolve();
  return {
    get root() { return project.root; },
    select(requested?: string, metadata?: Record<string, unknown>) {
      const operation = queue.then(async () => {
        const threadId = threadIdFromMetadata(metadata);
        if (threadId === undefined && requested === undefined && project.root === undefined) {
          throw new ApplicationError("CODEX_CONTEXT_UNAVAILABLE", "Не удалось получить рабочую папку чата от Codex. Повторите попытку.");
        }
        if (threadId !== undefined && threadId !== boundThread) {
          const context = await readContext(threadId, { allowStartupDirectory: boundThread === undefined });
          if (context.status !== "ready") {
            if (requested !== undefined && project.root === undefined) {
              const root = await project.select(requested);
              boundThread = threadId;
              return root;
            }
            if (context.status === "unavailable") throw new ApplicationError("PROJECT_UNAVAILABLE", "Укажите папку проекта, чтобы открыть ArchiView.");
            throw new ApplicationError("CODEX_CONTEXT_UNAVAILABLE", "Не удалось получить рабочую папку чата от Codex. Укажите папку проекта вручную.");
          }
          if (initialRoot === undefined) await project.select(context.root);
          boundThread = threadId;
        }
        return project.select(requested);
      });
      queue = operation.then(() => {}, () => {});
      return operation;
    },
  };
}
