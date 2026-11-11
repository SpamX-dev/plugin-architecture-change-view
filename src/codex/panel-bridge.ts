import { App } from "@modelcontextprotocol/ext-apps/app-with-deps";
import type { PanelBridge } from "../../web/archiview/types.js";
import { isRecord } from "../../web/archiview/types.js";
import { legacyPromptBridge } from "../../web/archiview/panel-bridge.js";

/** Connect the embedded Codex panel to this host's MCP Apps transport. */
export async function connectCodexPanel(): Promise<PanelBridge | null> {
  const fallback = legacyPromptBridge();
  if (window.parent === window) return fallback;
  try {
    const app = new App({ name: "ArchiView", version: "0.4.0" }, {}, { autoResize: false });
    await app.connect(undefined, { timeout: 5000 });
    const capabilities = app.getHostCapabilities();
    return {
      /** UI-only результат не добавляется в контекст модели и не запускает её. */
      call: capabilities?.serverTools ? async (name, args) => {
        const result = await app.callServerTool({ name, arguments: args });
        if (result.isError) {
          const error = isRecord(result._meta?.error) ? result._meta.error : {};
          throw Object.assign(new Error(typeof error.message === "string" ? error.message : "Не удалось выполнить операцию панели"), { code: error.code });
        }
        if (!result._meta || !Object.hasOwn(result._meta, "result")) throw new Error("Хост не передал данные операции в UI");
        return result._meta.result;
      } : undefined,
      /** Успешный ответ означает только принятие поручения, а не готовность анализа. */
      send: capabilities?.message ? async (prompt) => {
        const result = await app.sendMessage({ role: "user", content: [{ type: "text", text: prompt }] });
        if (result.isError) throw new Error("Codex отклонил поручение");
      } : fallback?.send,
    };
  } catch { return fallback; }
}
