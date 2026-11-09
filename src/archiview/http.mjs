/** HTTP-адаптер самостоятельного ArchiView: статические ресурсы, маршрутизация и защита origin. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createArchiViewSession } from "../application/session.mjs";
import { applicationError, ApplicationError } from "../application/errors.mjs";
import { packageUrl } from "../package-paths.mjs";

/** Сопоставляет прикладную ошибку HTTP-статусу, не добавляя HTTP в сервис. */
const errorStatus = { INVALID_ARGUMENT: 400, NOT_FOUND: 404, STALE_VIEW: 409, INCOMPLETE_VIEW: 422 };

/** Читает ограниченный JSON-запрос; проверка предметных аргументов остаётся в сервисе. */
async function bodyOf(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 4096) throw new ApplicationError("REQUEST_TOO_LARGE", "Слишком большой запрос");
  }
  const value = JSON.parse(body || "{}");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApplicationError("INVALID_ARGUMENT", "Ожидается объект параметров");
  return value;
}

/** Создаёт самостоятельный веб-сервер; плагин Codex использует сервис напрямую и этот модуль не импортирует. */
export async function createArchiView({ root, stateDirectory, panelToken }) {
  const session = await createArchiViewSession({ root, stateDirectory });
  const assets = new Map([
    ["/", ["index.html", "text/html"]], ["/app.mjs", ["app.mjs", "text/javascript"]],
    ["/client.mjs", ["client.mjs", "text/javascript"]],
    ["/panel-bridge.mjs", ["panel-bridge.mjs", "text/javascript"]],
    ["/review.mjs", ["review.mjs", "text/javascript"]], ["/styles.css", ["styles.css", "text/css"]],
  ].map(([route, [file, type]]) => [route, [new URL("web/archiview/" + file, packageUrl), type]]));
  let sdkUrl;
  try { sdkUrl = new URL(import.meta.resolve("@modelcontextprotocol/ext-apps/app-with-deps")); }
  catch { sdkUrl = new URL("web/archiview/mcp-app-sdk.mjs", packageUrl); }
  assets.set("/mcp-app-sdk.mjs", [sdkUrl, "text/javascript"]);
  const json = (response, status, value) => {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(value));
  };
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const host = request.headers.host;
    if (!["127.0.0.1:" + request.socket.localPort, "localhost:" + request.socket.localPort].includes(host)) {
      return json(response, 403, { error: "Недопустимый адрес запроса" });
    }
    const url = new URL(request.url, "http://" + host);
    const origin = request.headers.origin;
    const crossOrigin = origin && origin !== url.origin;
    if (panelToken && crossOrigin) {
      response.setHeader("Access-Control-Allow-Origin", origin);
      response.setHeader("Vary", "Origin");
      if (request.method === "OPTIONS") {
        response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
        response.setHeader("Access-Control-Allow-Private-Network", "true");
        response.writeHead(204); return response.end();
      }
    }
    if (crossOrigin && !(panelToken && request.method === "GET" && assets.has(url.pathname) && url.pathname !== "/") &&
        !(panelToken && request.headers.authorization === "Bearer " + panelToken)) {
      return json(response, 403, { error: "Запрос должен исходить из ArchiView или авторизованной панели" });
    }
    try {
      if (request.method === "GET" && assets.has(url.pathname)) {
        const [asset, contentType] = assets.get(url.pathname);
        const content = await readFile(asset);
        response.writeHead(200, { "Content-Type": contentType + "; charset=utf-8" });
        return response.end(content);
      }
      const args = Object.fromEntries(url.searchParams);
      if (request.method === "GET" && url.pathname === "/api/comparison") {
        if (args.historyLimit !== undefined) args.historyLimit = Number(args.historyLimit);
        return json(response, 200, await session.getComparison(args));
      }
      if (request.method === "GET" && url.pathname === "/api/module") return json(response, 200, await session.getModule(args));
      if (request.method === "GET" && /^\/api\/analysis\/[a-f0-9-]{36}$/.test(url.pathname))
        return json(response, 200, await session.getAnalysis({ id: url.pathname.split("/").at(-1) }));
      if (request.method === "POST") {
        if (url.pathname === "/api/analysis") return json(response, 201, await session.prepareAnalysis(await bodyOf(request)));
        if (url.pathname === "/api/reviews") return json(response, 200, await session.buildReview(await bodyOf(request)));
        if (url.pathname === "/api/snapshots") return json(response, 201, await session.saveSnapshot(await bodyOf(request)));
      }
      return json(response, 404, { error: "Ресурс не найден" });
    } catch (cause) {
      const error = applicationError(cause);
      return json(response, error.code === "REQUEST_TOO_LARGE" ? 413 : errorStatus[error.code] ?? 500,
        { error: error.message, code: error.code });
    }
  });
  return { ...session, server };
}
