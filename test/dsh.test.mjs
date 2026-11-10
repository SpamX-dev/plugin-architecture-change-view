/**
 * Тесты каркаса плагина dsh.
 *
 * Проверяются части, не требующие рантайма dsh: реестр сессий, описания
 * инструментов, разбор скилла и маршруты панели на поддельных запросе и ответе.
 * Загрузка клиентского бандла и вид вкладки проверяются установкой в профиль.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createSessionRegistry } from "../src/dsh/sessions.mjs";
import { normalizeExtensions, resolveRoot, TOOL_DEFINITIONS } from "../src/dsh/tools.mjs";
import { loadSkill, parseSkillText } from "../src/dsh/skill.mjs";
import {
  createRouteTable,
  DEFAULT_PREFIX,
  normalizePrefix,
  rewritePanelHtml,
} from "../src/dsh/routes.mjs";
import {
  CLIENT_GLOBAL,
  clientConfigRow,
  panelPageUrl,
  resolveClientPrefix,
} from "../src/dsh/panel-contract.mjs";
import { resolveChatRoot } from "../src/dsh/chat-root.mjs";
import { createArchiViewClient } from "../web/archiview/client.mjs";
import { createPromptSender } from "../src/dsh/client/prompt.mjs";
import { connectPanel } from "../web/archiview/panel-bridge.mjs";
import { ApplicationError } from "../src/application/errors.mjs";

/**
 * Собирает поддельный запрос node:http.
 *
 * @param {object} [options] - параметры запроса.
 * @returns {object} запрос с асинхронным телом.
 */
function fakeRequest({ method = "GET", url = "/", body, headers = {} } = {}) {
  return {
    method,
    url,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) {
        yield Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
      }
    },
  };
}

/**
 * Собирает поддельный ответ node:http.
 *
 * @returns {object} ответ, записывающий статус, заголовки и тело.
 */
function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: "",
    ended: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk) {
      if (chunk !== undefined) {
        this.body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      }
      this.ended = true;
    },
  };
}

/**
 * Собирает сессию-заглушку, записывающую вызовы операций.
 *
 * @returns {object} сессия с методами прикладного сервиса.
 */
function fakeSession() {
  const calls = [];
  const record = (name) => async (args) => {
    calls.push([name, args]);
    return { ok: true, operation: name };
  };
  return {
    calls,
    getComparison: record("getComparison"),
    getModule: record("getModule"),
    getAnalysis: record("getAnalysis"),
    prepareAnalysis: record("prepareAnalysis"),
    buildReview: record("buildReview"),
    saveSnapshot: record("saveSnapshot"),
  };
}

/**
 * Находит обработчик префиксного маршрута.
 *
 * @param {ReadonlyArray<object>} table - маршруты.
 * @returns {Function} обработчик.
 */
function prefixHandler(table) {
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

test("tools: расширения исходников нормализуются и проверяются", () => {
  const extensions = normalizeExtensions([".TS"]);
  assert.ok(extensions.has(".ts"));
  assert.ok(extensions.size > 1);
  assert.throws(() => normalizeExtensions(["ts"]), /расширение/);
});

test("tools: корень берётся из аргумента, затем из конфигурации", () => {
  assert.equal(resolveRoot({ projectRoot: " D:/project ", fallback: "D:/fallback" }), "D:/project");
  assert.equal(resolveRoot({ fallback: "D:/fallback" }), "D:/fallback");
  assert.throws(() => resolveRoot({}), /projectRoot/);
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

test("контракт: хост передаёт клиенту тот же префикс, что зарегистрировал", () => {
  for (const configured of ["", "/custom-architecture"]) {
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
});

test("контракт: адрес страницы несёт идентификатор чата", () => {
  assert.equal(panelPageUrl(DEFAULT_PREFIX, undefined), "/archiview/");
  assert.equal(panelPageUrl(DEFAULT_PREFIX, ""), "/archiview/");
  assert.equal(panelPageUrl(DEFAULT_PREFIX, "s 1"), "/archiview/?session=s%201");
  assert.equal(panelPageUrl("bad", "s1"), "/archiview/?session=s1");
});

test("chat-root: живой чат, сохранённый заголовок и отказ", async () => {
  const sessions = {
    get: (id) => (id === "live" ? { header: { cwd: "D:/live" } } : undefined),
  };
  const sessionController = {
    inspect: async (id) => (id === "cold" ? { meta: { cwd: "D:/cold" } } : { meta: {} }),
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
  const calls = [];
  const client = createArchiViewClient({
    mode: "http",
    base: "/archiview",
    sessionId: "chat-1",
    fetcher: async (url, init) => {
      calls.push([url, init?.method ?? "GET"]);
      return { ok: true, json: async () => ({}) };
    },
  });
  await client.getComparison({ view: "v1" });
  await client.prepareAnalysis({ view: "v1", path: "src" });
  await client.getAnalysis({ id: "a-1" });
  assert.deepEqual(calls, [
    ["/archiview/api/comparison?view=v1&session=chat-1", "GET"],
    ["/archiview/api/analysis?session=chat-1", "POST"],
    ["/archiview/api/analysis/a-1?session=chat-1", "GET"],
  ]);
});

test("веб-клиент: без чата адреса остаются прежними", async () => {
  const calls = [];
  const client = createArchiViewClient({
    mode: "http",
    base: "/archiview",
    fetcher: async (url) => {
      calls.push(url);
      return { ok: true, json: async () => ({}) };
    },
  });
  await client.getModule({ view: "v1", path: "src" });
  assert.deepEqual(calls, ["/archiview/api/module?view=v1&path=src"]);
});

test("поручение анализа уходит в чат вкладки", async () => {
  const calls = [];
  let released = 0;
  const sessions = {
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
  const prefix = table.find((route) => route.kind === "prefix").path;
  for (const pathname of ["/archiview", "/archiview/", "/archiview/styles.css", "/archiview/api/comparison"]) {
    assert.ok(pathname === prefix || pathname.startsWith(prefix + "/"), pathname);
  }
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
  assert.equal(session.calls[0][1].historyLimit, 25);
  assert.deepEqual(JSON.parse(response.body), { ok: true, operation: "getComparison" });
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
  const seen = [];
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
  const created = [];
  const registry = createSessionRegistry({
    createSession: async ({ root }) => {
      created.push(root);
      return fakeSession();
    },
  });
  const chatSessions = {
    get: (id) => (id === "chat-1" ? { header: { cwd: "D:/project-a" } } : undefined),
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
  const listeners = new Set();
  const origin = "http://host";
  const parent = {
    postMessage(message) {
      if (message?.type === "archiview:hello") {
        queueMicrotask(() => dispatch({ type: "archiview:host", protocol: 1, capabilities: { send: true } }));
      } else if (message?.type === "archiview:send") {
        queueMicrotask(() => dispatch({ type: "archiview:sent", id: message.id }));
      }
    },
  };
  /** Доставляет сообщение родителя всем подписчикам страницы. */
  function dispatch(data) {
    for (const listener of [...listeners]) listener({ source: parent, origin, data });
  }
  const windowStub = {
    parent,
    location: { origin },
    openai: undefined,
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
  };
  const documentStub = {
    querySelector: (selector) => (selector === 'meta[name="archiview-base"]' ? { content: "/archiview" } : null),
  };
  const saved = { window: globalThis.window, document: globalThis.document, location: globalThis.location };
  globalThis.window = windowStub;
  globalThis.document = documentStub;
  globalThis.location = { origin };
  try {
    const bridge = await connectPanel();
    assert.equal(typeof bridge?.send, "function");
    await bridge.send("поручение анализа");
  } finally {
    globalThis.window = saved.window;
    globalThis.document = saved.document;
    globalThis.location = saved.location;
  }
});

test("мост dsh: отказ хоста отклоняет отправку", async () => {
  const listeners = new Set();
  const origin = "http://host";
  const parent = {
    postMessage(message) {
      if (message?.type === "archiview:hello") {
        queueMicrotask(() => dispatch({ type: "archiview:host", protocol: 1, capabilities: { send: true } }));
      } else if (message?.type === "archiview:send") {
        queueMicrotask(() => dispatch({ type: "archiview:send-failed", id: message.id, error: "очередь недоступна" }));
      }
    },
  };
  /** Доставляет ответ родителя подписчикам страницы. */
  function dispatch(data) {
    for (const listener of [...listeners]) listener({ source: parent, origin, data });
  }
  const windowStub = {
    parent,
    location: { origin },
    openai: undefined,
    addEventListener(_type, listener) { listeners.add(listener); },
    removeEventListener(_type, listener) { listeners.delete(listener); },
  };
  const documentStub = {
    querySelector: (selector) => (selector === 'meta[name="archiview-base"]' ? { content: "/archiview" } : null),
  };
  const saved = { window: globalThis.window, document: globalThis.document, location: globalThis.location };
  globalThis.window = windowStub;
  globalThis.document = documentStub;
  globalThis.location = { origin };
  try {
    const bridge = await connectPanel();
    await assert.rejects(bridge.send("поручение анализа"), /очередь недоступна/);
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
});
