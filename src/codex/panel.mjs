/** Адаптер MCP Apps: публикует готовый web UI и управляет его локальным HTTP backend. */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createArchiView } from "../archiview/http.mjs";
import { packageUrl } from "../package-paths.mjs";

export const PANEL_URI = "ui://archiview/panel-v1.html";
export const PANEL_TOOL = {
  name: "archiview_open", title: "ArchiView",
  description: "Open the local ArchiView architecture panel for this project. Navigation uses HTTP; only an explicit Analyze action sends a request to the agent.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  _meta: { ui: { resourceUri: PANEL_URI }, "openai/ui": { entrypoints: [{ type: "thread" }, { type: "global" }] } },
};

/** Запускает только принадлежащий MCP-процессу сервер; ошибка запуска допускает повтор. */
export function createCodexPanel(root) {
  let pending;
  async function backend() {
    if (!pending) pending = (async () => {
      const token = randomBytes(32).toString("hex");
      const app = await createArchiView({ root, panelToken: token });
      await new Promise((resolve, reject) => {
        app.server.once("error", reject);
        app.server.listen(0, "127.0.0.1", resolve);
      });
      app.server.unref();
      return { ...app, token, origin: "http://127.0.0.1:" + app.server.address().port };
    })().catch((error) => { pending = null; throw error; });
    return pending;
  }
  return {
    /** Служебное открытие не передаёт секреты в модельный результат инструмента. */
    async open() {
      await backend();
      return { content: [{ type: "text", text: "ArchiView: " + root }], structuredContent: { root } };
    },
    /** Готовый HTML загружает те же web-ресурсы; API-токен известен только экземпляру UI. */
    async resource() {
      const { origin, token } = await backend();
      const html = (await readFile(new URL("web/archiview/index.html", packageUrl), "utf8"))
        .replace("<head>", `<head><meta name="archiview-backend" content="${origin}"><meta name="archiview-token" content="${token}">`)
        .replace('href="/styles.css"', `href="${origin}/styles.css"`)
        .replace('src="/app.mjs"', `src="${origin}/app.mjs"`)
        .replace('href="/" aria-label="ArchiView"', 'href="#" aria-label="ArchiView"');
      return { contents: [{ uri: PANEL_URI, mimeType: "text/html;profile=mcp-app", text: html,
        _meta: { ui: { csp: { connectDomains: [origin], resourceDomains: [origin] } } } }] };
    },
    /** Закрывает HTTP-соединения при отключении хоста, не затрагивая чужие процессы. */
    async close() {
      if (!pending) return;
      const { server } = await pending;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
