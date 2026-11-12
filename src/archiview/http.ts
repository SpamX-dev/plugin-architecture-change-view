import { callSessionOperation, repositoryArguments } from "../application/arguments.js";
import type { SessionOperations } from "../application/api.js";
import type { IncomingMessage, ServerResponse } from "node:http";
/** HTTP-адаптер самостоятельного ArchiView: статические ресурсы, маршрутизация и защита origin. */
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createWorkspaceSession } from "../application/workspace-session.js";
import { applicationError, ApplicationError } from "../application/errors.js";
import { packageUrl, webAssetUrl } from "../runtime/package-paths.js";

/** Сопоставляет прикладную ошибку HTTP-статусу, не добавляя HTTP в сервис. */
const errorStatus: Record<string, number> = { INVALID_ARGUMENT: 400, REPOSITORY_UNAVAILABLE: 400, NOT_FOUND: 404, STALE_VIEW: 409, INCOMPLETE_VIEW: 422 };

/** Читает ограниченный JSON-запрос; проверка предметных аргументов остаётся в сервисе. */
async function bodyOf(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const input: unknown = chunk;
    if (typeof input !== "string" && !(input instanceof Uint8Array)) throw new ApplicationError("INVALID_ARGUMENT", "Некорректное тело запроса");
    const data = Buffer.from(input);
    bytes += data.byteLength;
    if (bytes > 4096) throw new ApplicationError("REQUEST_TOO_LARGE", "Слишком большой запрос");
    chunks.push(data);
  }
  // Decode once: a TCP chunk may end in the middle of a Cyrillic UTF-8 character.
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks, bytes).toString("utf8") || "{}"); }
  catch { throw new ApplicationError("INVALID_ARGUMENT", "Некорректный JSON запроса"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApplicationError("INVALID_ARGUMENT", "Ожидается объект параметров");
  return value as Record<string, unknown>;
}

/**
 * Разбирает request-target относительно уже проверенного Host. Цель приходит из
 * сети и может быть синтаксически некорректной; такая ошибка становится
 * прикладной, чтобы обработчик ответил 400, а не завершил процесс отказом Promise.
 */
function requestUrl(request: IncomingMessage, serverOrigin: string) {
  try {
    const target = new URL(request.url ?? "/", serverOrigin);
    if (target.origin === serverOrigin) return target;
  } catch {
    // Report malformed and non-local targets through the same transport error.
  }
  throw new ApplicationError("INVALID_ARGUMENT", "Некорректная цель запроса");
}

/** Создаёт самостоятельный веб-сервер; плагин Codex использует сервис напрямую и этот модуль не импортирует. */
export async function createArchiView({ root, stateDirectory, panelToken }: { root: string; stateDirectory?: string; panelToken?: string }) {
  const workspace = await createWorkspaceSession({ root, stateDirectory });
  const session = await workspace.session();
  return { ...session, ...workspace, server: createArchiViewHttpServer(workspace, panelToken) };
}

export function createArchiViewHttpServer(session: SessionOperations, panelToken?: string) {
  const assets = new Map<string, [URL, string]>(([
    ["/", ["index.html", "text/html"]], ["/app.mjs", ["app.mjs", "text/javascript"]],
    ["/client.mjs", ["client.mjs", "text/javascript"]],
    ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
    ["/panel-bridge.mjs", ["panel-bridge.mjs", "text/javascript"]],
    ["/review.mjs", ["review.mjs", "text/javascript"]], ["/styles.css", ["styles.css", "text/css"]],
  ] satisfies [string, [string, string]][]).map(([route, [file, type]]) => [route, [new URL(file, webAssetUrl), type]]));
  let sdkUrl;
  try { sdkUrl = new URL(import.meta.resolve("@modelcontextprotocol/ext-apps/app-with-deps")); }
  catch { sdkUrl = new URL("web/archiview/mcp-app-sdk.mjs", packageUrl); }
  assets.set("/mcp-app-sdk.mjs", [sdkUrl, "text/javascript"]);
  const json = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(value));
  };
  return createServer(async (request, response) => {
    // Обработчик асинхронный и не имеет внешнего catch, поэтому все способные
    // бросить этапы, включая разбор request-target, входят в единый перехват.
    try {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      const host = request.headers.host;
      if (!["127.0.0.1:" + request.socket.localPort, "localhost:" + request.socket.localPort].includes(host ?? "")) {
        return json(response, 403, { error: "Недопустимый адрес запроса" });
      }
      const serverOrigin = "http://" + host;
      const url = requestUrl(request, serverOrigin);
      const origin = request.headers.origin;
      const crossOrigin = origin !== undefined && origin !== serverOrigin;
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
      if (request.method === "GET" && url.pathname === "/favicon.ico") {
        response.writeHead(302, { Location: "/favicon.svg" });
        return response.end();
      }
      if (request.method === "GET" && assets.has(url.pathname)) {
        const [asset, contentType] = assets.get(url.pathname)!;
        const content = await readFile(asset);
        response.writeHead(200, { "Content-Type": contentType.startsWith("text/") ? contentType + "; charset=utf-8" : contentType });
        return response.end(content);
      }
      const args: Record<string, unknown> = Object.fromEntries(url.searchParams);
      const repository = url.searchParams.get("repository");
      if (request.method === "GET" && url.pathname === "/api/comparison") {
        if (args.historyLimit !== undefined) args.historyLimit = Number(args.historyLimit);
        return json(response, 200, await callSessionOperation(session, "getComparison", args));
      }
      if (request.method === "GET" && url.pathname === "/api/module") return json(response, 200, await callSessionOperation(session, "getModule", args));
      if (request.method === "GET" && /^\/api\/analysis\/[a-f0-9-]{36}$/.test(url.pathname))
        return json(response, 200, await callSessionOperation(session, "getAnalysis", repositoryArguments(repository, { id: url.pathname.split("/").at(-1) })));
      if (request.method === "POST") {
        if (url.pathname === "/api/analysis") return json(response, 201, await callSessionOperation(session, "prepareAnalysis", repositoryArguments(repository, await bodyOf(request))));
        if (url.pathname === "/api/reviews") return json(response, 200, await callSessionOperation(session, "buildReview", repositoryArguments(repository, await bodyOf(request))));
        if (url.pathname === "/api/snapshots") return json(response, 201, await callSessionOperation(session, "saveSnapshot", repositoryArguments(repository, await bodyOf(request))));
      }
      return json(response, 404, { error: "Ресурс не найден" });
    } catch (cause) {
      // После начала ответа заголовки уже отправлены: второй ответ невозможен.
      if (response.headersSent) return response.destroy();
      const error = applicationError(cause);
      return json(response, error.code === "REQUEST_TOO_LARGE" ? 413 : errorStatus[error.code] ?? 500,
        { error: error.message, code: error.code });
    }
  });
}
