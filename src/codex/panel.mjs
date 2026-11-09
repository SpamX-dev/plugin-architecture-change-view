/** Адаптер MCP Apps: публикует готовый web UI и управляет его локальным HTTP backend. */
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createArchiView } from "../archiview/http.mjs";
import { packageUrl } from "../package-paths.mjs";
import { createProjectBinding } from "./project.mjs";

export const PANEL_URI = "ui://archiview/panel-v3.html";
export const PROJECT_INPUT = { type: "string", description: "Absolute project directory of the current chat, not the plugin installation. Required until this process is bound to a project." };
export const PANEL_TOOL = {
  name: "archiview_open", title: "ArchiView",
  description: "Open the local ArchiView architecture panel for this project. Navigation uses HTTP; only an explicit Analyze action sends a request to the agent.",
  inputSchema: { type: "object", properties: { projectRoot: PROJECT_INPUT }, additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  _meta: { ui: { resourceUri: PANEL_URI }, "openai/ui": { entrypoints: [{ type: "thread" }, { type: "global" }] } },
};

/** Запускает только принадлежащий MCP-процессу сервер; ошибка запуска допускает повтор. */
export function createCodexPanel(rootOrBinding, { tls } = {}) {
  const binding = typeof rootOrBinding === "object" ? Promise.resolve(rootOrBinding) : createProjectBinding(rootOrBinding);
  let pending;
  async function backend() {
    if (!pending) pending = (async () => {
      const token = randomBytes(32).toString("hex");
      const project = await binding;
      let application;
      /** UI подключается сразу; дорогое чтение проекта начинается отдельным API-запросом. */
      async function handleRequest(request, response) {
        const json = (status, value) => {
          response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
          response.end(JSON.stringify(value));
        };
        if (!["127.0.0.1:" + request.socket.localPort, "localhost:" + request.socket.localPort].includes(request.headers.host)) {
          return json(403, { error: "Недопустимый Host" });
        }
        const origin = request.headers.origin;
        if (origin) {
          response.setHeader("Access-Control-Allow-Origin", origin);
          response.setHeader("Vary", "Origin");
        }
        if (request.method === "OPTIONS") {
          response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
          response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
          response.setHeader("Access-Control-Allow-Private-Network", "true");
          response.writeHead(204); return response.end();
        }
        if (request.headers.authorization !== "Bearer " + token) return json(403, { error: "Требуется токен панели" });
        try {
          if (request.url === "/api/project" && request.method === "POST") {
            let body = "";
            for await (const chunk of request) {
              body += chunk;
              if (Buffer.byteLength(body) > 4096) return json(413, { error: "Слишком большой запрос" });
            }
            const args = JSON.parse(body);
            return json(200, { root: await project.select(args.projectRoot) });
          }
          if (!project.root) return json(409, { code: "PROJECT_REQUIRED", error: "Выберите папку проекта" });
          if (!application) application = createArchiView({ root: project.root, panelToken: token, tls })
            .catch((error) => { application = null; throw error; });
          await (await application).handleRequest(request, response);
        } catch (error) { json(400, { error: error.message }); }
      }
      const server = tls ? createHttpsServer(tls, handleRequest) : createServer(handleRequest);
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      server.unref();
      return { server, token, origin: (tls ? "https://localhost:" : "http://127.0.0.1:") + server.address().port };
    })().catch((error) => { pending = null; throw error; });
    return pending;
  }
  return {
    /** Служебное открытие не передаёт секреты в модельный результат инструмента. */
    async open(projectRoot) {
      const project = await binding;
      if (projectRoot !== undefined) await project.select(projectRoot);
      await backend();
      const root = project.root;
      if (!root) return { content: [{ type: "text", text: "Выберите папку проекта в панели или передайте projectRoot." }], structuredContent: { projectRequired: true } };
      return { content: [{ type: "text", text: "ArchiView: " + root }], structuredContent: { root } };
    },
    /** Самодостаточный HTML подключается к хосту без сети; API-токен известен только UI. */
    async resource() {
      const { origin, token } = await backend();
      const html = (await readFile(new URL("dist/panel.html", packageUrl), "utf8"))
        .replace("<head>", `<head><meta name="archiview-backend" content="${origin}"><meta name="archiview-token" content="${token}">`)
        .replace('href="/" aria-label="ArchiView"', 'href="#" aria-label="ArchiView"');
      return { contents: [{ uri: PANEL_URI, mimeType: "text/html;profile=mcp-app", text: html,
        _meta: {
          ui: { csp: { connectDomains: [origin], resourceDomains: [] } },
          // Codex с прежним обработчиком CSP читает документированный alias.
          // Обе формы разрешают только API принадлежащего панели backend.
          "openai/widgetCSP": { connect_domains: [origin], resource_domains: [] },
          "openai/ui": { availableDisplayModes: ["inline", "fullscreen"] },
        } }] };
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
