import { callSessionOperation, comparisonQueryArguments, repositoryArguments } from "../../../module-operations/arguments.js";
import type { SessionOperations } from "../../../module-operations/api.js";
import type { IncomingMessage, ServerResponse } from "node:http";
/** HTTP-адаптер самостоятельного ArchiView: статические ресурсы, маршрутизация и защита origin. */
import { createServer } from "node:http";
import { createWorkspaceSession, listWorkspaceModules } from "../workspace-session.js";
import { applicationError, ApplicationError } from "../../../module-operations/errors.js";
import { readWebAsset } from "../runtime/package-paths.js";
import { getModuleContract, listModuleFiles, saveModuleContract } from "../../../module-operations/module-access.js";

/** Сопоставляет прикладную ошибку HTTP-статусу, не добавляя HTTP в сервис. */
const errorStatus: Record<string, number> = { DECISION_CONFLICT: 409, HARNESS_UNAVAILABLE: 409, DELIVERY_CONFLICT: 409, INVALID_ARGUMENT: 400, REPOSITORY_UNAVAILABLE: 400, NOT_FOUND: 404, STALE_VIEW: 409, INCOMPLETE_VIEW: 422 };

/** Читает ограниченный JSON-запрос; проверка предметных аргументов остаётся в сервисе. */
async function bodyOf(request: IncomingMessage, limit = 4096): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const input: unknown = chunk;
    if (typeof input !== "string" && !(input instanceof Uint8Array)) throw new ApplicationError("INVALID_ARGUMENT", "Некорректное тело запроса");
    const data = Buffer.from(input);
    bytes += data.byteLength;
    if (bytes > limit) throw new ApplicationError("REQUEST_TOO_LARGE", "Слишком большой запрос");
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

/** Programmatic access to the server and its initialized store. The standalone CLI only needs the HTTP adapter. */
export async function createArchiView({ root, stateDirectory, publishOnOpen = false }: { root: string; stateDirectory?: string; publishOnOpen?: boolean }) {
  const workspace = await createWorkspaceSession({ root, stateDirectory });
  const session = await workspace.session(undefined, !publishOnOpen);
  return { ...session, ...workspace, server: createArchiViewHttpServer(workspace) };
}

export function createArchiViewHttpServer(session: SessionOperations & { root: string; close?(): void | Promise<void> }) {
  // Keep this process's UI and API together if another checkout build replaces dist/web.
  const assets = new Map<string, [Buffer, string]>(([
    ["/", ["index.html", "text/html"]], ["/app.mjs", ["app.mjs", "text/javascript"]],
    ["/client.mjs", ["client.mjs", "text/javascript"]],
    ["/favicon.svg", ["favicon.svg", "image/svg+xml"]],
    ["/review.mjs", ["review.mjs", "text/javascript"]], ["/styles.css", ["styles.css", "text/css"]],
  ] satisfies [string, [string, string]][]).map(([route, [file, type]]) => [route, [readWebAsset(file), type]]));
  const json = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(value));
  };
  const stopping = new AbortController();
  const active = new Set<ServerResponse>();
  const server = createServer(async (request, response) => {
    // Already accepted sockets may carry another request after the listener closes.
    if (stopping.signal.aborted) {
      response.setHeader("Connection", "close");
      return json(response, 503, { error: "Сервер ArchiView останавливается" });
    }
    active.add(response);
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
      if (origin !== undefined && origin !== serverOrigin) {
        return json(response, 403, { error: "Запрос должен исходить из локального ArchiView" });
      }
      if (request.method === "GET" && url.pathname === "/favicon.ico") {
        response.writeHead(302, { Location: "/favicon.svg" });
        return response.end();
      }
      if (request.method === "GET" && assets.has(url.pathname)) {
        const [content, contentType] = assets.get(url.pathname)!;
        response.writeHead(200, { "Content-Type": contentType.startsWith("text/") ? contentType + "; charset=utf-8" : contentType });
        return response.end(content);
      }
      const args: Record<string, unknown> = Object.fromEntries(url.searchParams);
      const repository = url.searchParams.get("repository");
      const selection = { repository: repository ?? undefined, target: url.searchParams.get("target") ?? undefined };
      if (request.method === "GET" && url.pathname === "/api/modules")
        return json(response, 200, await listWorkspaceModules(session.root, selection));
      if (request.method === "GET" && (url.pathname === "/api/module-files" || url.pathname === "/api/contract")) {
        const id = url.searchParams.get("id");
        if (!id) throw new ApplicationError("INVALID_ARGUMENT", "Укажите ID модуля");
        const result = url.pathname === "/api/module-files" ? await listModuleFiles(session.root, id, selection)
          : { id, text: await getModuleContract(session.root, id, selection) };
        return json(response, 200, result);
      }
      if (request.method === "POST" && url.pathname === "/api/contract") {
        const body = repositoryArguments(repository, await bodyOf(request, 1024 * 1024));
        const { id, text, directory, expectedText } = body;
        if (typeof id !== "string" || !id || typeof text !== "string" ||
          directory !== undefined && typeof directory !== "string" || expectedText !== undefined && typeof expectedText !== "string" ||
          body.repository !== undefined && typeof body.repository !== "string" ||
          body.target !== undefined && (typeof body.target !== "string" || selection.target !== undefined && body.target !== selection.target))
          throw new ApplicationError("INVALID_ARGUMENT", "Некорректные поля записи контракта");
        return json(response, 200, await saveModuleContract(session.root, id, text, {
          target: selection.target ?? body.target, repository: body.repository, directory, expectedText,
        }));
      }
      if (request.method === "GET" && url.pathname === "/api/comparison") {
        return json(response, 200, await callSessionOperation(session, "getComparison", comparisonQueryArguments(args)));
      }
      if (request.method === "GET" && url.pathname === "/api/changes") {
        const controller = new AbortController();
        response.once("close", () => controller.abort());
        const result = await callSessionOperation(session, "waitForChanges", args, AbortSignal.any([controller.signal, stopping.signal]));
        if (!response.destroyed) json(response, 200, result);
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/review-statuses") return json(response, 200, await callSessionOperation(session, "getReviewStatuses", args));
      if (request.method === "GET" && url.pathname === "/api/module") return json(response, 200, await callSessionOperation(session, "getModule", args));
      if (request.method === "GET" && url.pathname === "/api/harnesses") return json(response, 200, await callSessionOperation(session, "listHarnesses", args));
      if (request.method === "GET" && url.pathname === "/api/review-settings") return json(response, 200, await callSessionOperation(session, "getReviewSettings", args));
      if (request.method === "GET" && url.pathname === "/api/relations") return json(response, 200, await callSessionOperation(session, "getRelations", args));
      if (request.method === "GET" && url.pathname === "/api/relations/source") return json(response, 200, await callSessionOperation(session, "getRelationSource", args));
      if (request.method === "GET" && url.pathname === "/api/file-diff") return json(response, 200, await callSessionOperation(session, "getFileDiff", args));
      if (request.method === "GET" && /^\/api\/analysis\/[a-f0-9-]{36}$/.test(url.pathname))
        return json(response, 200, await callSessionOperation(session, "getAnalysis", repositoryArguments(repository, { id: url.pathname.split("/").at(-1) })));
      if (request.method === "POST") {
        if (url.pathname === "/api/review-settings") {
          if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json")
            throw new ApplicationError("INVALID_ARGUMENT", "Требуется application/json");
          return json(response, 200, await callSessionOperation(session, "setReviewSetting", repositoryArguments(repository, await bodyOf(request))));
        }
        if (url.pathname === "/api/findings/decision") return json(response, 200, await callSessionOperation(session, "updateFinding", repositoryArguments(repository, await bodyOf(request))));
        if (url.pathname === "/api/relations") return json(response, 200, await callSessionOperation(session, "buildRelations", repositoryArguments(repository, await bodyOf(request))));
        if (url.pathname === "/api/contract-clause") return json(response, 200, await callSessionOperation(session, "changeClause", repositoryArguments(repository, await bodyOf(request, 1024 * 1024))));
        if (url.pathname === "/api/prototype") return json(response, 200, await callSessionOperation(session, "changePrototype", repositoryArguments(repository, await bodyOf(request, 1024 * 1024))));
        if (url.pathname === "/api/analysis/deliver" || url.pathname === "/api/findings/fix") {
          if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json"))
            throw new ApplicationError("INVALID_ARGUMENT", "Требуется application/json");
          return json(response, 200, await callSessionOperation(session, url.pathname === "/api/findings/fix" ? "deliverFindingFix" : "deliverAnalysis", repositoryArguments(repository, await bodyOf(request))));
        }
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
    } finally { active.delete(response); }
  }).on("close", () => { void session.close?.(); });
  function shutdown() {
    if (stopping.signal.aborted) return;
    server.close();
    // Finish in-flight operations on their original sockets. Wake idle watch requests immediately.
    for (const response of active) response.shouldKeepAlive = false;
    stopping.abort();
  }
  function listenLocal(port: number, listening: () => void) {
    return server.listen(port, "127.0.0.1", listening);
  }
  return Object.assign(server, { shutdown, listenLocal });
}
