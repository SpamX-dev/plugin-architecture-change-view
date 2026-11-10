/** Привязка панели к рабочей папке чата Codex, независимо от projectId и наличия сообщений. */
import { createProjectBinding } from "../application/project.mjs";
import { ApplicationError } from "../application/errors.mjs";
import { createHostContextReader } from "./host-context.mjs";

/** Идентификатор берётся только из метаданных хоста, а не из аргументов инструмента модели. */
export function threadIdFromMetadata(metadata) {
  for (const key of ["threadId", "openai/threadId", "openai/thread_id", "codexThreadId", "codex_thread_id", "thread_id"]) {
    const value = metadata?.[key];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

/**
 * Общая прикладная привязка остаётся неизменяемой. Codex-адаптер получает папку
 * до создания сессии; сериализация первых обращений исключает конкурирующие корни.
 * Когда хост не сообщает контекст, разрешён явный выбор существующей папки.
 * Подтверждённое отсутствие проекта не обходится ручным вводом.
 */
export async function createCodexProjectBinding(initialRoot, { readContext = createHostContextReader() } = {}) {
  const project = await createProjectBinding(initialRoot);
  let boundThread;
  let queue = Promise.resolve();
  return {
    get root() { return project.root; },
    select(requested, metadata) {
      const operation = queue.then(async () => {
        const threadId = threadIdFromMetadata(metadata);
        if (threadId === undefined && requested === undefined && project.root === undefined) {
          throw new ApplicationError("CODEX_CONTEXT_UNAVAILABLE", "Не удалось получить рабочую папку чата от Codex. Повторите попытку.");
        }
        if (threadId !== undefined && threadId !== boundThread) {
          const context = await readContext(threadId, { allowStartupDirectory: boundThread === undefined });
          if (context.status === "unavailable") throw new ApplicationError("PROJECT_UNAVAILABLE", "Плагин доступен только в проектах");
          if (context.status !== "ready") {
            if (requested !== undefined && project.root === undefined) {
              const root = await project.select(requested);
              boundThread = threadId;
              return root;
            }
            throw new ApplicationError("CODEX_CONTEXT_UNAVAILABLE", "Не удалось получить рабочую папку чата от Codex. Укажите папку проекта вручную.");
          }
          if (initialRoot === undefined) await project.select(context.root);
          boundThread = threadId;
        }
        return project.select(requested);
      });
      queue = operation.catch(() => {});
      return operation;
    },
  };
}
