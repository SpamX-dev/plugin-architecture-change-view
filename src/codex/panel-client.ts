import type { ClientOptions, ComparisonArgs, PanelBridge } from "../../web/archiview/types.js";
import { errorCode, errorMessage, isRecord } from "../../web/archiview/types.js";
import { createArchiViewClient as createSharedClient } from "../../web/archiview/client.js";

/** Ограничивает только определение папки: чтение снимков не означает недоступность контекста. */
async function initialResponse<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("Не удалось автоматически определить папку проекта"),
        { code: "CODEX_CONTEXT_UNAVAILABLE" })), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/**
 * Адаптирует неизвестный root к старому PROJECT_REQUIRED. Явное отсутствие
 * проекта сохраняет PROJECT_UNAVAILABLE. Ввод и диалог проходят ту же проверку
 * абсолютного существующего каталога; повторная смена привязанного корня запрещена.
 */
export function createArchiViewClient(options: ClientOptions, { timeoutMs = 15000 } = {}) {
  const client = createSharedClient(options);
  let initialized = false;
  return { ...client, async getComparison(args?: ComparisonArgs) {
    if (!initialized) {
      try {
        const operation = Promise.resolve(options.connection).then((connection) => {
          if (!connection?.call) throw new Error("Хост не поддерживает вызовы MCP из панели");
          return connection.call("archiview_ui_get_project", {});
        });
        const result = await initialResponse(operation, timeoutMs);
        if (!isRecord(result) || typeof result.root !== "string" || result.root.trim() === "") throw Object.assign(new Error("Не удалось определить папку проекта"), { code: "CODEX_CONTEXT_UNAVAILABLE" });
        initialized = true;
      } catch (error) {
        if (errorCode(error) !== "CODEX_CONTEXT_UNAVAILABLE") throw error;
        throw Object.assign(new Error(errorMessage(error)), { code: "PROJECT_REQUIRED" });
      }
    }
    // После подтверждения корня ждём данные обычным запросом MCP. Медленная
    // подготовка проекта и ошибки снимков не открывают форму выбора папки.
    return client.getComparison(args);
  } };
}


/** The explicit picker action returns the host selection; the form owns submission and error display. */
export async function choosePanelProject(connection: Promise<PanelBridge | null>): Promise<string | null> {
  const bridge = await connection;
  if (!bridge?.call) throw new Error("Хост не поддерживает выбор папки");
  const result = await bridge.call("archiview_ui_choose_project", {});
  if (!isRecord(result) || (result.projectRoot !== null && typeof result.projectRoot !== "string"))
    throw new Error("Хост вернул некорректный путь проекта");
  return result.projectRoot;
}
