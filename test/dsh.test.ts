import type { ComparisonView, PreparedAnalysis, SessionOperations } from "../src/application/api.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { PromptContext } from "../src/dsh/client/types.js";
/**
 * Тесты каркаса плагина dsh.
 *
 * Проверяются части, не требующие рантайма dsh: реестр сессий, описания
 * инструментов, разбор скилла и маршруты панели на поддельных запросе и ответе.
 * Загрузка клиентского бандла и вид вкладки проверяются установкой в профиль.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createSessionRegistry } from "../src/dsh/sessions.js";
import { normalizeExtensions, resolveRoot, TOOL_DEFINITIONS } from "../src/dsh/tools.js";
import { loadSkill, parseSkillText } from "../src/dsh/skill.js";
import {
  createRouteTable,
  DEFAULT_PREFIX,
  normalizePrefix,
  rewritePanelHtml,
} from "../src/dsh/routes.js";
import {
  CLIENT_GLOBAL,
  clientConfigRow,
  panelPageUrl,
  resolveClientPrefix,
} from "../src/dsh/panel-contract.js";
import { resolveChatRoot } from "../src/dsh/chat-root.js";
import { createArchiViewClient } from "../web/archiview/client.js";
import { createPromptSender } from "../src/dsh/client/prompt.js";
import { connectPanel } from "../web/archiview/panel-bridge.js";
import { ApplicationError } from "../src/application/errors.js";
import { apply } from "../src/dsh/host.js";
import { contractYaml, writeModuleTree } from "./support.js";

/**
 * Собирает поддельный запрос node:http.
 *
 * @param {object} [options] - параметры запроса.
 * @returns {object} запрос с асинхронным телом.
 */
function fakeRequest({ method = "GET", url = "/", body, chunks, headers = {} }: { method?: string; url?: string; body?: unknown; chunks?: Buffer[]; headers?: Record<string, string> } = {}): IncomingMessage {
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (chunks) { yield* chunks; return; }
      if (body !== undefined) {
        yield Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
      }
    },
  } as unknown as IncomingMessage;
}

/**
 * Собирает поддельный ответ node:http.
 *
 * @returns {object} ответ, записывающий статус, заголовки и тело.
 */
function fakeResponse() {
  const response = {
    statusCode: 200,
    headers: {} as Record<string, string>,
    body: "",
    ended: false,
    setHeader(name: string, value: string) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) {
        this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      }
      this.ended = true;
    },
  };
  return response as unknown as ServerResponse & typeof response;
}

/**
 * Собирает сессию-заглушку, записывающую вызовы операций.
 *
 * @returns {object} сессия с методами прикладного сервиса.
 */
function fakeSession() {
  const calls: unknown[][] = [];
  const unused = async (): Promise<never> => { throw new Error("Unexpected session operation"); };
  const comparison: ComparisonView = {
    id: "view", root: ".", schema_version: 2, complete: true, diagnostics: [], reviewDiagnostics: [],
    modules: [], counts: {}, timeline: [], baselines: [], historyHasMore: false,
    before: { id: "initial", kind: "initial", label: "Initial" },
    after: { id: "now", digest: "digest", capturedAt: "now" },
    target: { id: "current", kind: "current", label: "Current" },
  };
  const analysis: PreparedAnalysis = {
    id: "analysis", schema_version: 1, moduleId: "src", directory: "src", viewId: "v1", reviewId: "review",
    createdAt: "now", inputDigest: "input", snapshotsDigest: "snapshots", prompt: "Review src", status: "prepared",
  };
  const operations: SessionOperations = {
    async getComparison(args) { calls.push(["getComparison", args]); return comparison; },
    async prepareAnalysis(args) { calls.push(["prepareAnalysis", args]); return analysis; },
    getModule: unused, getAnalysis: unused, buildReview: unused, saveSnapshot: unused,
  };
  return { calls, comparison, analysis, ...operations };
}

/**
 * Находит обработчик префиксного маршрута.
 *
 * @param {ReadonlyArray<object>} table - маршруты.
 * @returns {Function} обработчик.
 */
function prefixHandler(table: ReturnType<typeof createRouteTable>) {
  const route = table.find((entry) => entry.kind === "prefix");
  assert.ok(route, "префиксный маршрут должен существовать");
  return route.handler;
}

test("sessions: одна сессия на корень", async () => {
  let created = 0;
  const registry = createSessionRegistry({
    createSession: async ({ root }) => ({ root, sequence: ++created }),
  });
  const [first, second] = await Promise.all([registry.get("/project"), registry.get("/project")]);
  assert.equal(first, second);
  assert.equal(created, 1);
  assert.equal(registry.size(), 1);
});

test("sessions: неудачная инициализация не кэшируется", async () => {
  let attempts = 0;
  const registry = createSessionRegistry({
    createSession: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("нет доступа");
      return { ok: true };
    },
  });
  await assert.rejects(registry.get("/project"), /нет доступа/);
  assert.equal(registry.has("/project"), false);
  assert.deepEqual(await registry.get("/project"), { ok: true });
});

test("sessions: dispose закрывает реестр", async () => {
  const registry = createSessionRegistry({ createSession: async () => ({}) });
  await registry.get("/project");
  await registry.dispose();
  assert.throws(() => registry.get("/project"), /закрыт/);
});

test("tools: описания инструментов стабильны", () => {
  assert.deepEqual(TOOL_DEFINITIONS.map((tool) => tool.name),
    ["archiview_inventory", "archiview_context"]);
  for (const tool of TOOL_DEFINITIONS) {
    assert.ok(tool.description.length > 0);
    assert.equal(tool.parameters.projectRoot.type, "string");
  }
});

test("tools: путь файла из рабочей папки чата dsh выбирает собственный контракт репозитория", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "dsh-chat-repositories-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  for (const repository of ["client", "server"]) {
    const root = path.join(workspace, repository);
    await mkdir(path.join(root, "src"), { recursive: true });
    execFileSync("git", ["init", "-q", root], { windowsHide: true });
    await writeModuleTree(root, { core: "src" });
    await writeFile(path.join(root, ".archiview/modules/core.yaml"), contractYaml("core", repository));
  }
  type Tool = { name: string; execute(args: { path: string }, exec: typeof execution): Promise<{ repository: string; contracts: { text: string | null }[] }> };
  const execution = { agent: { session: { header: { cwd: workspace } } } };
  const registered = new Map<string, Tool>();
  const unused = () => { throw new Error("Unexpected host service"); };
  apply({ tools: { register(tool) { const item = tool as Tool; registered.set(item.name, item); } },
    effect: () => {}, get: unused, on: unused, connection: { requestRejection: unused }, webServer: { register: unused } },
  { root: "", stateDirectory: "", prefix: "/archiview", maxFiles: 100, extensions: [], tools: true, panel: false, skill: false });
  for (const repository of ["client", "server"]) {
    const result = await registered.get("archiview_context")!.execute({ path: repository + "/src/new.ts" }, execution);
    assert.equal(result.repository, repository);
    assert.equal(result.contracts.at(-1)?.text, contractYaml("core", repository));
  }
});

test("tools: расширения исходников нормализуются и проверяются", () => {
  const extensions = normalizeExtensions([".TS"]);
  assert.ok(extensions.has(".ts"));
  assert.ok(extensions.size > 1);
  assert.throws(() => normalizeExtensions(["ts"]), /расширение/);
});

test("tools: выбор проекта ограничен настроенным корнем", async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "dsh-tool-roots-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const configuredRoot = path.join(fixture, "selected");
  const nested = path.join(configuredRoot, "nested");
  await mkdir(nested, { recursive: true });
  assert.equal(await resolveRoot({ configuredRoot }), await realpath(configuredRoot));
  assert.equal(await resolveRoot({ projectRoot: nested, configuredRoot }), await realpath(nested));
  assert.equal(await resolveRoot({ projectRoot: fixture }), await realpath(fixture));
  await assert.rejects(resolveRoot({ projectRoot: fixture, configuredRoot }), /projectRoot/);
  await assert.rejects(resolveRoot({}), /projectRoot/);
});

test("skill: разбор frontmatter и тела", () => {
  const text = "---\nname: demo\ndescription: \"Описание скилла\"\n---\n# Тело\n\nТекст\n";
  const skill = parseSkillText(text);
  assert.equal(skill.name, "demo");
  assert.equal(skill.description, "Описание скилла");
  assert.ok(skill.content.startsWith("# Тело"));
  assert.ok(!skill.content.includes("description:"));
  assert.throws(() => parseSkillText("без frontmatter"), /frontmatter/);
});

test("skill: канонический файл пакета разбирается", async () => {
  const skill = await loadSkill();
  assert.equal(skill.name, "module-boundaries");
  assert.ok(skill.description.length > 0);
  assert.ok(skill.content.length > 0);
});

test("routes: префикс нормализуется", () => {
  assert.equal(normalizePrefix(""), DEFAULT_PREFIX);
  assert.equal(normalizePrefix("/archiview"), "/archiview");
  assert.throws(() => normalizePrefix("/archiview/"), /префикс/i);
  assert.throws(() => normalizePrefix("archiview"), /префикс/i);
});

test("routes: сетевая ссылка и обратный слэш не принимаются как префикс", () => {
  // `//host/path` — network-path reference: браузер оставит себе схему, но
  // возьмёт чужой origin. `/\host/path` он разберёт точно так же.
  for (const value of ["//outside.invalid/archiview", "/\\outside.invalid/archiview", "///archiview"]) {
    assert.throws(() => normalizePrefix(value), /префикс/i);
  }
  assert.throws(() => normalizePrefix("/archi\\view"), /префикс/i);
});

test("контракт: хост передаёт клиенту тот же префикс, что зарегистрировал", () => {
  for (const configured of ["", "/custom-architecture", "/панель"]) {
    const prefix = normalizePrefix(configured);
    const row = clientConfigRow(prefix);
    assert.deepEqual(row, { kind: "global", name: CLIENT_GLOBAL, value: { prefix } });
    assert.equal(resolveClientPrefix({ [CLIENT_GLOBAL]: row.value }), prefix);
  }
});

test("контракт: без внедрения и при порче значения действует стандартный префикс", () => {
  assert.equal(resolveClientPrefix({}), DEFAULT_PREFIX);
  assert.equal(resolveClientPrefix({ [CLIENT_GLOBAL]: { prefix: "custom" } }), DEFAULT_PREFIX);
  assert.equal(resolveClientPrefix({ [CLIENT_GLOBAL]: { prefix: "/custom/" } }), DEFAULT_PREFIX);
  assert.equal(resolveClientPrefix({ [CLIENT_GLOBAL]: { prefix: "/custom?x" } }), DEFAULT_PREFIX);
  for (const value of ["//outside.invalid/archiview", "/\\outside.invalid/archiview", "///archiview"]) {
    assert.equal(resolveClientPrefix({ [CLIENT_GLOBAL]: { prefix: value } }), DEFAULT_PREFIX);
  }
});

test("контракт: адрес страницы остаётся на origin хоста", () => {
  const base = "https://dsh.example.invalid/chat";
  for (const prefix of [DEFAULT_PREFIX, "/custom-architecture"]) {
    const url = new URL(panelPageUrl(prefix, "s 1"), base);
    assert.equal(url.origin, "https://dsh.example.invalid");
    assert.equal(url.pathname, prefix + "/");
    assert.equal(url.searchParams.get("session"), "s 1");
  }
  // Порча внедрённого значения не уводит iframe на другой origin.
  for (const value of ["//outside.invalid/archiview", "/\\outside.invalid/archiview"]) {
    const prefix = resolveClientPrefix({ [CLIENT_GLOBAL]: { prefix: value } });
    assert.equal(new URL(panelPageUrl(prefix, "s1"), base).origin, "https://dsh.example.invalid");
  }
});

test("контракт: адрес страницы несёт идентификатор чата", () => {
  assert.equal(panelPageUrl(DEFAULT_PREFIX, undefined), "/archiview/");
  assert.equal(panelPageUrl(DEFAULT_PREFIX, ""), "/archiview/");
  assert.equal(panelPageUrl(DEFAULT_PREFIX, "s 1"), "/archiview/?session=s%201");
  assert.equal(panelPageUrl("bad", "s1"), "/archiview/?session=s1");
  assert.equal(panelPageUrl("//outside.invalid/archiview", "s1"), "/archiview/?session=s1");
});

test("chat-root: живой чат, сохранённый заголовок и отказ", async () => {
  const sessions = {
    get: (id: string) => (id === "live" ? { header: { cwd: "D:/live" } } : undefined),
  };
  const sessionController = {
    inspect: async (id: string) => (id === "cold" ? { meta: { cwd: "D:/cold" } } : { meta: {} }),
  };
  assert.equal(await resolveChatRoot({ sessionId: "live", sessions }), "D:/live");
  assert.equal(await resolveChatRoot({ sessionId: "cold", sessions, sessionController }), "D:/cold");
  assert.equal(await resolveChatRoot({ sessionId: "missing", sessions, sessionController }), null);
  assert.equal(await resolveChatRoot({ sessionId: "", sessions }), null);
  assert.equal(await resolveChatRoot({ sessionId: "x" }), null);
});

test("chat-root: сессия без каталога не подменяет конфигурацию", async () => {
  const sessions = { get: () => ({ header: { cwd: "   " } }) };
  const sessionController = { inspect: async () => ({ meta: { cwd: "D:/persisted" } }) };
  assert.equal(await resolveChatRoot({ sessionId: "empty", sessions, sessionController }), "D:/persisted");
});

test("веб-клиент: идентификатор чата уходит в каждый запрос", async () => {
  const calls: unknown[][] = [];
  const { analysis, comparison } = fakeSession();
  const client = createArchiViewClient({
    mode: "http",
    base: "/archiview",
    sessionId: "chat-1",
    fetcher: async (url, init) => {
      calls.push([url, init?.method ?? "GET"]);
      return Response.json(String(url).includes("/api/analysis") ? analysis : comparison);
    },
  });
  await client.getComparison({ target: "current" });
  await client.prepareAnalysis({ view: "v1", path: "src" });
  const status = await client.getAnalysis({ id: "a-1" });
  assert.equal(Object.hasOwn(status, "prompt"), false);
  assert.deepEqual(calls, [
    ["/archiview/api/comparison?target=current&session=chat-1", "GET"],
    ["/archiview/api/analysis?session=chat-1", "POST"],
    ["/archiview/api/analysis/a-1?session=chat-1", "GET"],
  ]);
});

test("веб-клиент: без чата адреса остаются прежними", async () => {
  const calls: unknown[] = [];
  const client = createArchiViewClient({
    mode: "http",
    base: "/archiview",
    fetcher: async (url) => {
      calls.push(url);
      return Response.json({});
    },
  });
  await client.getModule({ view: "v1", path: "src" });
  assert.deepEqual(calls, ["/archiview/api/module?view=v1&path=src"]);
});

test("поручение анализа уходит в чат вкладки", async () => {
  const calls: unknown[][] = [];
  let released = 0;
  const sessions: NonNullable<ReturnType<PromptContext["get"]>> = {
    retain(sessionId, options) {
      calls.push(["retain", sessionId, options]);
      return {
        ready: Promise.resolve({
          session: {
            async prompt(content, mode) {
              calls.push(["prompt", content, mode]);
              return { ok: true, value: { accepted: true } };
            },
          },
        }),
        release() { released += 1; },
      };
    },
  };
  const send = createPromptSender({ get: (name) => (name === "sessions" ? sessions : undefined) });
  await send("chat-1", "  анализ модуля  ");
  assert.equal(released, 1);
  assert.deepEqual(calls[0], ["retain", "chat-1", { source: "archiview" }]);
  assert.deepEqual(calls[1], ["prompt", [{ type: "text", text: "  анализ модуля  " }], "queue"]);
});

test("поручение: отказ хоста не удерживает сессию", async () => {
  let released = 0;
  const sessions = {
    retain: () => ({
      ready: Promise.resolve({
        session: { prompt: async () => ({ ok: false, error: { message: "очередь недоступна" } }) },
      }),
      release() { released += 1; },
    }),
  };
  const send = createPromptSender({ get: () => sessions });
  await assert.rejects(send("chat-1", "текст"), /очередь недоступна/);
  assert.equal(released, 1);
});

test("поручение: без сервиса сессий и без чата отправка отклоняется", async () => {
  await assert.rejects(createPromptSender({ get: () => undefined })("chat-1", "текст"),
    /сессии dsh недоступны/);
  await assert.rejects(createPromptSender({ get: () => undefined })("", "текст"),
    /Чат вкладки неизвестен/);
  await assert.rejects(createPromptSender({ get: () => undefined })("chat-1", "   "),
    /Пустое поручение/);
});

test("routes: шаблон переписывается под префикс и получает метаданные", () => {
  const html = "<head><link rel=\"stylesheet\" href=\"/styles.css\"><script src=\"/app.mjs\"></script></head>";
  const result = rewritePanelHtml(html, { prefix: "/archiview", sessionId: "s\"1" });
  assert.ok(result.includes('<meta name="archiview-base" content="/archiview">'));
  assert.ok(result.includes('content="s&quot;1"'));
  assert.ok(result.includes('href="/archiview/styles.css"'));
  assert.ok(result.includes('src="/archiview/app.mjs"'));
});

test("routes: таблица содержит точный и префиксный маршруты", () => {
  const table = createRouteTable({
    prefix: "/archiview",
    guard: () => false,
    getSession: async () => fakeSession(),
  });
  assert.deepEqual(table.map((route) => [route.kind, route.path]),
    [["exact", "/archiview"], ["prefix", "/archiview"]]);
  // Правило сопоставления веб-сервера dsh: path === prefix || startsWith(prefix + "/").
  const prefix = table.find((route) => route.kind === "prefix")!.path;
  for (const pathname of ["/archiview", "/archiview/", "/archiview/styles.css", "/archiview/api/comparison"]) {
    assert.ok(pathname === prefix || pathname.startsWith(prefix + "/"), pathname);
  }
});

test("routes: Unicode-префикс работает на обеих сторонах редиректа и сохраняет чат", async () => {
  const prefix = "/панель";
  const table = createRouteTable({ prefix, guard: () => false, getSession: () => fakeSession() });
  const route = new URL(prefix, "http://localhost").pathname;
  assert.ok(table.every((entry) => entry.path === route));
  const query = "?session=chat%201&extra=1";
  const redirect = fakeResponse();
  await table[0].handler(fakeRequest({ url: route + query }), redirect);
  assert.equal(redirect.statusCode, 308);
  assert.equal(redirect.headers.location, route + "/" + query);
  const page = fakeResponse();
  await prefixHandler(table)(fakeRequest({ url: redirect.headers.location }), page);
  assert.equal(page.statusCode, 200);
  assert.ok(page.body.includes('name="archiview-session" content="chat 1"'));
  assert.ok(page.body.includes('name="archiview-base" content="' + route + '"'));
});

test("routes: сравнение выполняется с приведённым historyLimit", async () => {
  const session = fakeSession();
  const table = createRouteTable({
    prefix: "/archiview",
    guard: () => false,
    getSession: async () => session,
  });
  const response = fakeResponse();
  await prefixHandler(table)(
    fakeRequest({ url: "/archiview/api/comparison?view=v1&historyLimit=25" }), response);
  assert.equal(response.statusCode, 200);
  assert.equal(session.calls[0][0], "getComparison");
  assert.equal((session.calls[0][1] as { historyLimit: number }).historyLimit, 25);
  assert.deepEqual(JSON.parse(response.body), session.comparison);
});

test("routes: подготовка анализа принимает JSON-тело", async () => {
  const session = fakeSession();
  const table = createRouteTable({
    prefix: "/archiview",
    guard: () => false,
    getSession: async () => session,
  });
  const response = fakeResponse();
  await prefixHandler(table)(fakeRequest({
    method: "POST",
    url: "/archiview/api/analysis",
    body: { view: "v1", path: "src" },
  }), response);
  assert.equal(response.statusCode, 201);
  assert.deepEqual(session.calls[0], ["prepareAnalysis", { view: "v1", path: "src" }]);
});

test("routes: неизвестная операция и слишком большое тело отклоняются", async () => {
  const table = createRouteTable({
    prefix: "/archiview",
    guard: () => false,
    getSession: async () => fakeSession(),
  });
  const unknown = fakeResponse();
  await prefixHandler(table)(fakeRequest({ url: "/archiview/api/unknown" }), unknown);
  assert.equal(unknown.statusCode, 404);
  assert.equal(JSON.parse(unknown.body).code, "NOT_FOUND");

  const oversized = fakeResponse();
  await prefixHandler(table)(fakeRequest({
    method: "POST",
    url: "/archiview/api/analysis",
    body: "x".repeat(5000),
  }), oversized);
  assert.equal(oversized.statusCode, 413);
});

test("routes: отклонённый политикой запрос не создаёт сессию", async () => {
  let requested = false;
  const table = createRouteTable({
    prefix: "/archiview",
    guard: (request, response) => {
      response.statusCode = 403;
      response.end();
      return true;
    },
    getSession: async () => {
      requested = true;
      return fakeSession();
    },
  });
  const response = fakeResponse();
  await prefixHandler(table)(fakeRequest({ url: "/archiview/api/comparison" }), response);
  assert.equal(response.statusCode, 403);
  assert.equal(requested, false);
});

test("routes: идентификатор чата передаётся резолверу сессии", async () => {
  const seen: (string | null)[] = [];
  const table = createRouteTable({
    prefix: "/archiview",
    guard: () => false,
    getSession: async (request, url) => {
      seen.push(url.searchParams.get("session"));
      return fakeSession();
    },
  });
  const response = fakeResponse();
  await prefixHandler(table)(fakeRequest({ url: "/archiview/api/comparison?session=chat-1" }), response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(seen, ["chat-1"]);
});

test("интеграция: чат вкладки открывает сессию его рабочего каталога", async () => {
  const created: string[] = [];
  const registry = createSessionRegistry({
    createSession: async ({ root }) => {
      created.push(root);
      return fakeSession();
    },
  });
  const chatSessions = {
    get: (id: string) => (id === "chat-1" ? { header: { cwd: "D:/project-a" } } : undefined),
  };
  const table = createRouteTable({
    prefix: "/archiview",
    guard: () => false,
    getSession: async (request, url) => {
      const root = await resolveChatRoot({ sessionId: url.searchParams.get("session"), sessions: chatSessions });
      if (root === null) throw new ApplicationError("NOT_FOUND", "Чат не найден или у него нет рабочего каталога");
      return registry.get(root);
    },
  });

  const response = fakeResponse();
  await prefixHandler(table)(
    fakeRequest({ url: "/archiview/api/comparison?session=chat-1&view=v1" }), response);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(created, ["D:/project-a"]);

  const missing = fakeResponse();
  await prefixHandler(table)(
    fakeRequest({ url: "/archiview/api/comparison?session=chat-2" }), missing);
  assert.equal(missing.statusCode, 404);
  assert.equal(JSON.parse(missing.body).code, "NOT_FOUND");
});

test("мост dsh: приветствие, отправка и подтверждение", async () => {
  const listeners = new Set<(event: { source: object; origin: string; data: Record<string, unknown> }) => void>();
  const origin = "http://host";
  const parent = {
    postMessage(message: Record<string, unknown>) {
      if (message?.type === "archiview:hello") {
        queueMicrotask(() => dispatch({ type: "archiview:host", protocol: 2, sessionId: message.sessionId, capabilities: { send: true } }));
      } else if (message?.type === "archiview:send") {
        queueMicrotask(() => dispatch({ type: "archiview:sent", id: message.id, protocol: 2, sessionId: message.sessionId }));
      }
    },
  };
  /** Доставляет сообщение родителя всем подписчикам страницы. */
  function dispatch(data: Record<string, unknown>) {
    for (const listener of [...listeners]) listener({ source: parent, origin, data });
  }
  const windowStub = {
    parent,
    location: { origin },
    openai: undefined,
    addEventListener(_type: string, listener: (event: { source: object; origin: string; data: Record<string, unknown> }) => void) { listeners.add(listener); },
    removeEventListener(_type: string, listener: (event: { source: object; origin: string; data: Record<string, unknown> }) => void) { listeners.delete(listener); },
  };
  const documentStub = {
    querySelector: (selector: string) => (selector === 'meta[name="archiview-base"]' ? { content: "/archiview" } :
      selector === 'meta[name="archiview-session"]' ? { content: "chat-1" } : null),
  };
  const saved = { window: globalThis.window, document: globalThis.document, location: globalThis.location };
  Object.assign(globalThis, { window: windowStub, document: documentStub, location: { origin } });
  try {
    const bridge = await connectPanel();
    assert.equal(typeof bridge?.send, "function");
    await bridge!.send!("поручение анализа");
  } finally {
    globalThis.window = saved.window;
    globalThis.document = saved.document;
    globalThis.location = saved.location;
  }
});

test("мост dsh: отказ хоста отклоняет отправку", async () => {
  const listeners = new Set<(event: { source: object; origin: string; data: Record<string, unknown> }) => void>();
  const origin = "http://host";
  const parent = {
    postMessage(message: Record<string, unknown>) {
      if (message?.type === "archiview:hello") {
        queueMicrotask(() => dispatch({ type: "archiview:host", protocol: 2, sessionId: message.sessionId, capabilities: { send: true } }));
      } else if (message?.type === "archiview:send") {
        queueMicrotask(() => dispatch({ type: "archiview:send-failed", id: message.id, protocol: 2, sessionId: message.sessionId, error: "очередь недоступна" }));
      }
    },
  };
  /** Доставляет ответ родителя подписчикам страницы. */
  function dispatch(data: Record<string, unknown>) {
    for (const listener of [...listeners]) listener({ source: parent, origin, data });
  }
  const windowStub = {
    parent,
    location: { origin },
    openai: undefined,
    addEventListener(_type: string, listener: (event: { source: object; origin: string; data: Record<string, unknown> }) => void) { listeners.add(listener); },
    removeEventListener(_type: string, listener: (event: { source: object; origin: string; data: Record<string, unknown> }) => void) { listeners.delete(listener); },
  };
  const documentStub = {
    querySelector: (selector: string) => (selector === 'meta[name="archiview-base"]' ? { content: "/archiview" } :
      selector === 'meta[name="archiview-session"]' ? { content: "chat-1" } : null),
  };
  const saved = { window: globalThis.window, document: globalThis.document, location: globalThis.location };
  Object.assign(globalThis, { window: windowStub, document: documentStub, location: { origin } });
  try {
    const bridge = await connectPanel();
    await assert.rejects(bridge!.send!("поручение анализа"), /очередь недоступна/);
  } finally {
    globalThis.window = saved.window;
    globalThis.document = saved.document;
    globalThis.location = saved.location;
  }
});

test("routes: статика и страница панели отдаются из пакета", async () => {
  const table = createRouteTable({
    prefix: "/archiview",
    guard: () => false,
    getSession: async () => fakeSession(),
  });
  const styles = fakeResponse();
  await prefixHandler(table)(fakeRequest({ url: "/archiview/styles.css" }), styles);
  assert.equal(styles.statusCode, 200);
  assert.match(styles.headers["content-type"], /text\/css/);
  assert.ok(styles.body.length > 1000);

  const page = fakeResponse();
  await prefixHandler(table)(fakeRequest({ url: "/archiview/?session=s1" }), page);
  assert.equal(page.statusCode, 200);
  assert.match(page.headers["content-type"], /text\/html/);
  assert.ok(page.body.includes('<meta name="archiview-base" content="/archiview">'));
  assert.ok(page.body.includes('content="s1"'));
  assert.ok(page.body.includes('href="/archiview/styles.css"'));
  assert.ok(page.body.includes('href="./favicon.svg"'));
  const icon = fakeResponse();
  await prefixHandler(table)(fakeRequest({ url: "/archiview/favicon.svg" }), icon);
  assert.equal(icon.statusCode, 200);
  assert.equal(icon.headers["content-type"], "image/svg+xml");
});

test("routes: malformed JSON is a client error and UTF-8 survives a chunk boundary", async () => {
  const session = fakeSession();
  const handler = prefixHandler(createRouteTable({ prefix: "/archiview", guard: () => false, getSession: () => session }));
  const malformed = fakeResponse();
  await handler(fakeRequest({ method: "POST", url: "/archiview/api/analysis", body: "{" }), malformed);
  assert.equal(malformed.statusCode, 400);
  assert.equal(JSON.parse(malformed.body).code, "INVALID_ARGUMENT");
  assert.deepEqual(session.calls, []);

  const args = { view: "v1", path: "модуль/данные" };
  const payload = Buffer.from(JSON.stringify(args));
  const split = payload.indexOf(Buffer.from("м")) + 1;
  const response = fakeResponse();
  await handler(fakeRequest({ method: "POST", url: "/archiview/api/analysis",
    chunks: [payload.subarray(0, split), payload.subarray(split)] }), response);
  assert.equal(response.statusCode, 201);
  assert.deepEqual(session.calls[0], ["prepareAnalysis", args]);
});

test("routes: both exact redirects and prefix requests pass through the host policy", async () => {
  let checked = 0;
  const table = createRouteTable({ prefix: "/archiview", guard: (_request, response) => {
    checked += 1; response.statusCode = 403; response.end(); return true;
  }, getSession: () => { throw new Error("Denied requests must not create sessions"); } });
  for (const route of table) {
    const response = fakeResponse();
    await route.handler(fakeRequest({ url: "/archiview" }), response);
    assert.equal(response.statusCode, 403);
  }
  assert.equal(checked, 2);
});

test("routes: a throwing host policy becomes an HTTP error", async () => {
  const table = createRouteTable({ prefix: "/archiview", guard: () => { throw new Error("policy unavailable"); },
    getSession: () => { throw new Error("No session before host policy"); } });
  for (const route of table) {
    const response = fakeResponse();
    await route.handler(fakeRequest({ url: "/archiview" }), response);
    assert.equal(response.statusCode, 500);
    assert.equal(JSON.parse(response.body).code, "INTERNAL_ERROR");
  }
});

test("legacy bridge preserves its host method receiver", async () => {
  const calls: string[] = [];
  const legacyHost = { label: "host", async sendFollowUpMessage({ prompt }: { prompt: string }) {
    assert.equal(this.label, "host"); calls.push(prompt);
  } };
  const windowStub = { openai: legacyHost };
  Object.assign(windowStub, { parent: windowStub });
  const savedWindow = globalThis.window;
  Object.assign(globalThis, { window: windowStub });
  try {
    const bridge = await connectPanel();
    assert.ok(bridge?.send);
    await bridge.send("legacy prompt");
    assert.deepEqual(calls, ["legacy prompt"]);
  } finally { globalThis.window = savedWindow; }
});
