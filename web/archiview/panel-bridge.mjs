/**
 * Узкий канал к хосту: только явное поручение пользователем запускает агента.
 * Дерево, документы, отчёты и их обновление через этот канал не передаются.
 */
export async function connectPanel() {
  const legacy = window.openai?.sendFollowUpMessage;
  const fallback = typeof legacy === "function" ? {
    async send(prompt) { await window.openai.sendFollowUpMessage({ prompt }); },
  } : null;
  if (window.parent === window) return fallback;
  try {
    const { App } = await import("./mcp-app-sdk.mjs");
    const app = new App({ name: "ArchiView", version: "0.3.0" }, {}, { autoResize: false });
    await app.connect(undefined, { timeout: 5000 });
    if (!app.getHostCapabilities()?.message) { await app.close(); return fallback; }
    return {
      /** Успешный ответ означает только принятие поручения, а не готовность анализа. */
      async send(prompt) {
        const result = await app.sendMessage({ role: "user", content: [{ type: "text", text: prompt }] });
        if (result.isError) throw new Error("Codex отклонил запрос анализа");
      },
    };
  } catch { return fallback; }
}
