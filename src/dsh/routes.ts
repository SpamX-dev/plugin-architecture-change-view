import type { SessionOperations } from "../application/api.js";
import { callSessionOperation, comparisonQueryArguments, repositoryArguments } from "../application/arguments.js";
import type { IncomingMessage, ServerResponse } from "node:http";
/**
 * HTTP-маршруты панели ArchiView для веб-сервера dsh.
 *
 * Модуль знает только про node:http-запросы и прикладной сервис: он отдаёт
 * статический интерфейс из `web/archiview`, переписывает в нём адреса под
 * префикс плагина и выполняет те же операции просмотра, что standalone-адаптер
 * `src/archiview/http.ts`. Сервер не поднимается: маршруты регистрируются в
 * `ctx.webServer` хоста.
 *
 * Политика соединения приходит снаружи как `guard`: маршрут не читает проект
 * до того, как хост подтвердит допустимость запроса. Корень проекта также не
 * берётся из URL — его определяет `getSession`.
 *
 * @module plugin-architecture-change-view/dsh/routes
 */

import { readFile } from "node:fs/promises";
import { applicationError, ApplicationError } from "../application/errors.js";
import { packageUrl, webAssetUrl } from "../runtime/package-paths.js";
import { asPrefix, DEFAULT_PREFIX } from "./panel-contract.js";

export { DEFAULT_PREFIX };

/** Предел тела JSON-запроса: операции панели передают только идентификаторы и пути. */
const MAX_BODY_BYTES = 4096;

/** Прикладной код ошибки в HTTP-статус; незнакомый код считается внутренним. */
const ERROR_STATUS: Record<string, number> = {
  INVALID_ARGUMENT: 400,
  REPOSITORY_UNAVAILABLE: 400,
  NOT_FOUND: 404,
  STALE_VIEW: 409,
  REQUEST_TOO_LARGE: 413,
  INCOMPLETE_VIEW: 422,
};

/**
 * Статические ресурсы панели: имя под префиксом, файл пакета и тип содержимого.
 *
 * Статические ресурсы HTTP-панели. Отправку поручений обслуживает мост iframe dsh.
 *
 * @constant {ReadonlyMap<string, { file: string, type: string }>}
 */
export const PANEL_ASSETS = new Map([
  ["", { file: "web/archiview/index.html", type: "text/html; charset=utf-8" }],
  ["index.html", { file: "web/archiview/index.html", type: "text/html; charset=utf-8" }],
  ["app.mjs", { file: "web/archiview/app.mjs", type: "text/javascript; charset=utf-8" }],
  ["client.mjs", { file: "web/archiview/client.mjs", type: "text/javascript; charset=utf-8" }],
  ["panel-bridge.mjs", { file: "web/archiview/panel-bridge.mjs", type: "text/javascript; charset=utf-8" }],
  ["review.mjs", { file: "web/archiview/review.mjs", type: "text/javascript; charset=utf-8" }],
  ["styles.css", { file: "web/archiview/styles.css", type: "text/css; charset=utf-8" }],
  ["favicon.svg", { file: "web/archiview/favicon.svg", type: "image/svg+xml" }],
]);

/** Кэш прочитанных ресурсов: файлы панели неизменны в пределах установленного пакета. */
const assetCache = new Map<string, Buffer>();

/**
 * Приводит префикс к виду `/archiview`: локальный путь без хвостового слэша и
 * служебных символов.
 *
 * Сетевые ссылки вида `//host/path` и обратные слэши отклоняются той же
 * проверкой, которой пользуется клиент: префикс обязан оставаться путём на
 * origin хоста.
 *
 * @param {unknown} value - значение конфигурации.
 * @returns {string} нормализованный префикс.
 * @throws {Error} если значение не является допустимым локальным путём.
 */
export function normalizePrefix(value: unknown) {
  const prefix = typeof value === "string" ? value.trim() : "";
  if (prefix === "") return DEFAULT_PREFIX;
  const normalized = asPrefix(prefix);
  if (normalized === null) {
    throw new Error(
      "Префикс плагина ArchiView должен быть локальным путём: /путь без хвостового слэша, обратных слэшей, ? и #",
    );
  }
  return normalized;
}

/**
 * Экранирует значение для HTML-атрибута.
 *
 * @param {string} value - недоверенное значение.
 * @returns {string} безопасная для атрибута строка.
 */
function escapeAttribute(value: string) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Переписывает шаблон панели под префикс плагина.
 *
 * Шаблон ссылается на ресурсы абсолютными путями от корня сервера, поэтому без
 * переписывания они попадут в SPA-фолбэк dsh. Заодно вставляются метаданные:
 * префикс маршрутов (его читает `web/archiview/client.ts` и приклеивает к
 * адресам операций вида `/api/...`) и идентификатор чата, к которому относится
 * вкладка.
 *
 * @param {string} html - исходный шаблон.
 * @param {object} options - параметры переписывания.
 * @param {string} options.prefix - префикс маршрутов плагина.
 * @param {string | null} [options.sessionId] - идентификатор чата для вкладки.
 * @returns {string} готовый HTML.
 */
export function rewritePanelHtml(html: string, { prefix, sessionId }: { prefix: string; sessionId?: string | null }) {
  const meta = [`<meta name="archiview-base" content="${escapeAttribute(prefix)}">`];
  if (typeof sessionId === "string" && sessionId !== "") {
    meta.push(`<meta name="archiview-session" content="${escapeAttribute(sessionId)}">`);
  }
  return html
    .replace('href="/styles.css"', `href="${prefix}/styles.css"`)
    .replace('src="/app.mjs"', `src="${prefix}/app.mjs"`)
    .replace("<head>", "<head>\n  " + meta.join("\n  "));
}

/**
 * Отправляет JSON-ответ с запретом кэширования.
 *
 * @param {import("node:http").ServerResponse} response - ответ.
 * @param {number} status - HTTP-статус.
 * @param {unknown} value - сериализуемое значение.
 * @returns {void}
 */
function sendJson(response: ServerResponse, status: number, value: unknown) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

/**
 * Отправляет прикладную ошибку в общей для адаптеров форме.
 *
 * @param {import("node:http").ServerResponse} response - ответ.
 * @param {unknown} cause - перехваченная ошибка.
 * @returns {void}
 */
function sendError(response: ServerResponse, cause: unknown) {
  const error = applicationError(cause);
  const status = error.code === "REQUEST_TOO_LARGE" ? 413 : ERROR_STATUS[error.code] ?? 500;
  sendJson(response, status, { error: error.message, code: error.code });
}

/**
 * Читает ограниченное JSON-тело запроса.
 *
 * Проверяется только форма: предметные ограничения остаются в прикладном
 * сервисе, поэтому маршрут не дублирует его правила.
 *
 * @param {import("node:http").IncomingMessage} request - запрос.
 * @returns {Promise<Record<string, unknown>>} объект аргументов.
 * @throws {ApplicationError} при превышении предела или неверной форме.
 */
async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const input: unknown = chunk;
    if (typeof input !== "string" && !(input instanceof Uint8Array)) throw new ApplicationError("INVALID_ARGUMENT", "Некорректное тело запроса");
    const data = Buffer.from(input);
    bytes += data.byteLength;
    if (bytes > MAX_BODY_BYTES) throw new ApplicationError("REQUEST_TOO_LARGE", "Слишком большой запрос");
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
 * Выполняет операцию панели по относительному пути под `/api/`.
 *
 * @param {import("node:http").IncomingMessage} request - запрос.
 * @param {import("node:http").ServerResponse} response - ответ.
 * @param {URL} url - разобранный адрес запроса.
 * @param {string} relative - путь после `<prefix>/api/`.
 * @param {object} session - прикладная сессия ArchiView.
 * @returns {Promise<void>} завершение после отправки ответа.
 * @throws {ApplicationError} если операция неизвестна.
 */
async function runApiOperation(request: IncomingMessage, response: ServerResponse, url: URL, relative: string, session: SessionOperations) {
  const method = request.method ?? "GET";
  const match = /^analysis\/([a-f0-9-]{36})$/.exec(relative);
  const query: Record<string, unknown> = Object.fromEntries(url.searchParams);
  const repository = url.searchParams.get("repository");

  if (method === "GET" && relative === "comparison") {
    return sendJson(response, 200, await callSessionOperation(session, "getComparison", comparisonQueryArguments(query)));
  }
  if (method === "GET" && relative === "module") {
    return sendJson(response, 200, await callSessionOperation(session, "getModule", query));
  }
  if (method === "GET" && match !== null) {
    return sendJson(response, 200, await callSessionOperation(session, "getAnalysis", repositoryArguments(repository, { id: match[1] })));
  }
  if (method === "POST" && relative === "analysis") {
    return sendJson(response, 201, await callSessionOperation(session, "prepareAnalysis", repositoryArguments(repository, await readJson(request))));
  }
  if (method === "POST" && relative === "reviews") {
    return sendJson(response, 200, await callSessionOperation(session, "buildReview", repositoryArguments(repository, await readJson(request))));
  }
  if (method === "POST" && relative === "snapshots") {
    return sendJson(response, 201, await callSessionOperation(session, "saveSnapshot", repositoryArguments(repository, await readJson(request))));
  }
  throw new ApplicationError("NOT_FOUND", "Операция панели не найдена");
}

/**
 * Читает статический ресурс панели с кэшированием.
 *
 * @param {string} name - имя ресурса под префиксом.
 * @returns {Promise<{ content: Buffer, type: string } | null>} ресурс или `null`.
 */
async function readAsset(name: string) {
  const asset = PANEL_ASSETS.get(name);
  if (asset === undefined) return null;
  let content = assetCache.get(name);
  if (content === undefined) {
    content = await readFile(new URL(asset.file.replace("web/archiview/", ""), webAssetUrl));
    assetCache.set(name, content);
  }
  return { content, type: asset.type };
}

/**
 * Создаёт маршруты плагина для `ctx.webServer`.
 *
 * Возвращаются два маршрута: точный адрес панели с редиректом на слэш и
 * префиксный обработчик для ресурсов, API и HTML. Обработчик сначала отдаёт
 * запрос политике соединения хоста и только потом читает проект.
 *
 * @param {object} options - параметры маршрутов.
 * @param {string} [options.prefix] - префикс маршрутов.
 * @param {(request: import("node:http").IncomingMessage, response: import("node:http").ServerResponse) => boolean} options.guard
 *   проверка запроса; `true` означает, что ответ уже отправлен.
 * @param {(request: import("node:http").IncomingMessage, url: URL) => object | Promise<object>} options.getSession
 *   сессия прикладного сервиса для запроса.
 * @returns {ReadonlyArray<{ kind: "exact" | "prefix", path: string, handler: Function }>} маршруты.
 */
export function createRouteTable({ prefix: configuredPrefix = DEFAULT_PREFIX, guard, getSession }: { prefix?: string; guard: (request: IncomingMessage, response: ServerResponse) => boolean; getSession: (request: IncomingMessage, url: URL) => SessionOperations | Promise<SessionOperations> }) {
  if (typeof guard !== "function" || typeof getSession !== "function") {
    throw new Error("createRouteTable требует guard и getSession");
  }
  const prefix = normalizePrefix(configuredPrefix);
  const apiBase = prefix + "/api/";
  const assetBase = prefix + "/";

  /**
   * Общий обработчик префикса: политика, статика, API.
   *
   * @param {import("node:http").IncomingMessage} request - запрос.
   * @param {import("node:http").ServerResponse} response - ответ.
   * @returns {Promise<void>} завершение обработки.
   */
  async function handler(request: IncomingMessage, response: ServerResponse) {
    try {
      if (guard(request, response)) return;
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
      "object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
      if (request.method === "OPTIONS") {
        response.statusCode = 204;
        response.end();
        return;
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      if (url.pathname === assetBase || url.pathname === assetBase + "index.html") {
        const html = await readFile(new URL("web/archiview/index.html", packageUrl), "utf8");
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(rewritePanelHtml(html, {
          prefix,
          sessionId: url.searchParams.get("session"),
        }));
        return;
      }
      if (url.pathname.startsWith(apiBase)) {
        const session = await getSession(request, url);
        await runApiOperation(request, response, url, url.pathname.slice(apiBase.length), session);
        return;
      }
      const asset = await readAsset(url.pathname.slice(assetBase.length));
      if (asset === null) {
        sendJson(response, 404, { error: "Ресурс не найден", code: "NOT_FOUND" });
        return;
      }
      response.statusCode = 200;
      response.setHeader("Content-Type", asset.type);
      response.end(asset.content);
    } catch (error) {
      if (response.headersSent) { response.destroy(); return; }
      sendError(response, error);
    }
  }

  return [
    {
      kind: "exact",
      path: prefix,
      handler(request: IncomingMessage, response: ServerResponse) {
        try {
          if (guard(request, response)) return;
          response.statusCode = 308;
          const url = new URL(request.url ?? "/", "http://localhost");
          response.setHeader("Location", prefix + "/" + url.search);
          response.end();
        } catch (error) {
          if (response.headersSent) { response.destroy(); return; }
          sendError(response, error);
        }
      },
    },
    // Префикс регистрируется без хвостового слэша: веб-сервер dsh сопоставляет
    // `pathname === path || pathname.startsWith(path + "/")`, поэтому путь
    // `/archiview/` не покрыл бы `/archiview/styles.css`.
    { kind: "prefix", path: prefix, handler },
  ];
}
