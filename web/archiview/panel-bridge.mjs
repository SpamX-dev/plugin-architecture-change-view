/**
 * Канал MCP Apps: вызовы UI возвращают данные только компоненту.
 * Отправка поручения агенту выделена в отдельный явный метод send.
 */
export async function connectPanel() {
  const legacy = window.openai?.sendFollowUpMessage;
  const fallback = typeof legacy === "function" ? {
    async send(prompt) { await window.openai.sendFollowUpMessage({ prompt }); },
  } : null;
  if (window.parent === window) return fallback;
  try {
    const { App } = await import("./mcp-app-sdk.mjs");
    const app = new App({ name: "ArchiView", version: "0.4.0" }, {}, { autoResize: false });
    await app.connect(undefined, { timeout: 5000 });
    const capabilities = app.getHostCapabilities();
    return {
      /** UI-only результат не добавляется в контекст модели и не запускает её. */
      call: capabilities?.serverTools ? async (name, args) => {
        const result = await app.callServerTool({ name, arguments: args });
        if (result.isError) {
          const error = result._meta?.error;
          throw Object.assign(new Error(error?.message ?? "Не удалось выполнить операцию панели"), { code: error?.code });
        }
        if (!result._meta || !Object.hasOwn(result._meta, "result")) throw new Error("Хост не передал данные операции в UI");
        return result._meta.result;
      } : undefined,
      /** Успешный ответ означает только принятие поручения, а не готовность анализа. */
      send: capabilities?.message ? async (prompt) => {
        const result = await app.sendMessage({ role: "user", content: [{ type: "text", text: prompt }] });
        if (result.isError) throw new Error("Codex отклонил запрос анализа");
      } : fallback?.send,
    };
  } catch { return fallback; }
}
