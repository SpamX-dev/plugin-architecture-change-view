/**
 * Cordis-плагин ArchiView для DeepSeek Harness.
 *
 * Плагин собирает из существующих домены проекта две половины:
 *
 * 1. инструменты модели (`archiview_inventory`, `archiview_context`) — чтение
 *    контрактов через `src/inventory.mjs`;
 * 2. маршруты панели под префиксом `/archiview` — тот же прикладной сервис
 *    `src/application`, что используют standalone-адаптер и панель Codex;
 * 3. публикацию скилла module-boundaries в реестре dsh;
 * 4. передачу настроенного префикса маршрутов браузерной половине через
 *    публичный канал `webserver/index-inject`.
 *
 * Плагин не содержит прикладной логики и не запускает модель: просмотр только
 * читает проект, а анализ выполняет агент хоста по явному поручению. Корень
 * проекта берётся из конфигурации (или рабочего каталога процесса) и никогда
 * из URL запроса.
 *
 * @module plugin-architecture-change-view/dsh/host
 */

import path from "node:path";
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { ApplicationError } from "../application/errors.mjs";
import { resolveChatRoot } from "./chat-root.mjs";
import { clientConfigRow, DEFAULT_PREFIX } from "./panel-contract.mjs";
import { createRouteTable, normalizePrefix } from "./routes.mjs";
import { createSessionRegistry } from "./sessions.mjs";
import { loadSkill } from "./skill.mjs";
import {
  normalizeExtensions,
  readContext,
  readInventory,
  resolveRoot,
  TOOL_DEFINITIONS,
} from "./tools.mjs";

/** Имя Cordis-плагина для диагностики загрузчика. */
export const name = "archiview";

/**
 * Сервисы, без которых плагин не активируется.
 *
 * `connection` обязателен: маршруты панели отдают проект только после его
 * проверки политики соединения. Реестр скиллов подключается необязательно —
 * без него инструменты и панель продолжают работать.
 */
export const inject = ["tools", "webServer", "connection"];

/** Схема конфигурации плагина; значения по умолчанию рассчитаны на локальный проект. */
export const Config = z.object({
  root: z.string().default(""),
  stateDirectory: z.string().default(""),
  prefix: z.string().default(DEFAULT_PREFIX),
  maxFiles: z.number().default(50_000),
  extensions: z.array(z.string()).default([]),
  panel: z.boolean().default(true),
  tools: z.boolean().default(true),
  skill: z.boolean().default(true),
});

/**
 * Применяет плагин к контексту dsh.
 *
 * Регистрации живут ровно столько же, сколько плагин: маршруты и скилл
 * снимаются возвращёнными disposer'ами, а реестр сессий закрывается эффектом.
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx - контекст хоста.
 * @param {object} config - нормализованная конфигурация схемы.
 * @returns {void}
 */
export function apply(ctx, config) {
  const prefix = normalizePrefix(config.prefix);
  const extensions = normalizeExtensions(config.extensions);
  const root = config.root === "" ? "" : path.resolve(config.root);
  const sessions = createSessionRegistry({
    stateDirectory: config.stateDirectory === "" ? undefined : config.stateDirectory,
  });

  ctx.effect(() => () => {
    void sessions.dispose();
  }, "archiview: сессии");

  if (config.tools) registerTools(ctx, { extensions, maxFiles: config.maxFiles, fallbackRoot: root });
  if (config.skill) registerSkill(ctx);
  if (config.panel) {
    registerClientConfig(ctx, prefix);
    registerRoutes(ctx, { prefix, sessions, fallbackRoot: root });
  }
}

/**
 * Регистрирует инструменты модели.
 *
 * Схема вывода — произвольный JSON: результат инвентаризации и контекста
 * остаётся структурированным, а не превращается в строку до валидации.
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx - контекст хоста.
 * @param {object} options - параметры регистрации.
 * @param {Set<string>} options.extensions - расширения исходников.
 * @param {number} options.maxFiles - предел обхода.
 * @param {string} options.fallbackRoot - корень из конфигурации.
 * @returns {void}
 */
function registerTools(ctx, { extensions, maxFiles, fallbackRoot }) {
  for (const definition of TOOL_DEFINITIONS) {
    ctx.tools.register(defineTool({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      output: {
        schema: { type: "json" },
        render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }],
      },
      async execute(args) {
        const projectRoot = resolveRoot({ projectRoot: args.projectRoot, fallback: fallbackRoot });
        const value = definition.name === "archiview_inventory"
          ? await readInventory({ root: projectRoot, extensions, maxFiles })
          : await readContext({ root: projectRoot, directory: args.directory });
        return value;
      },
    }));
  }
}

/**
 * Публикует встроенный скилл в реестре dsh, если он есть в композиции.
 *
 * Регистрация асинхронная: файл читается с диска после активации плагина, а
 * ошибка чтения не отменяет инструменты и панель.
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx - контекст хоста.
 * @returns {void}
 */
function registerSkill(ctx) {
  // Скиллы не входят в inject: композиция без dsh-skill должна активировать
  // инструменты и панель. Поэтому сервис читается через ctx.get, а не ctx.skills.
  const skills = ctx.get("skills");
  if (skills === undefined) {
    ctx.logger?.warn?.("ArchiView: реестр скиллов dsh недоступен, module-boundaries не опубликован");
    return;
  }
  let dispose;
  let disposed = false;
  loadSkill().then((skill) => {
    if (!disposed) dispose = skills.register(skill);
  }, (error) => {
    ctx.logger?.warn?.("ArchiView: скилл не зарегистрирован: " + error.message);
  });
  ctx.effect(() => () => {
    disposed = true;
    dispose?.();
  }, "archiview: скилл");
}

/**
 * Сообщает браузерной половине префикс маршрутов панели.
 *
 * Используется публичный канал веб-сервера dsh: строка `webserver/index-inject`
 * с `kind: "global"` присваивает значение свойству `globalThis` до запуска
 * клиентских бандлов. Так конфигурация `prefix` доходит до вкладки, и клиенту
 * не нужно угадывать адрес страницы по собственной константе.
 *
 * Внедрение действует там, где index.html отдаёт веб-сервер (Web-профиль). В
 * Electron документ грузится по `file://` и внедрения не получает — клиент
 * остаётся на стандартном префиксе, который совпадает с настройкой по
 * умолчанию.
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx - контекст хоста.
 * @param {string} prefix - нормализованный префикс маршрутов.
 * @returns {void}
 */
function registerClientConfig(ctx, prefix) {
  ctx.effect(() => ctx.on("webserver/index-inject", (rows) => {
    rows.push(clientConfigRow(prefix));
  }), "archiview: конфигурация клиента");
}

/**
 * Регистрирует маршруты панели в веб-сервере хоста.
 *
 * Корень проекта определяется по чату, которому принадлежит вкладка: клиент
 * передаёт `?session=<id>`, хост разрешает рабочий каталог сессии и открывает
 * прикладную сессию этого каталога. Без параметра действует корень из
 * конфигурации — этот путь остаётся для прямого открытия страницы.
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx - контекст хоста.
 * @param {object} options - параметры регистрации.
 * @param {string} options.prefix - префикс маршрутов.
 * @param {ReturnType<createSessionRegistry>} options.sessions - реестр сессий.
 * @param {string} options.fallbackRoot - корень из конфигурации.
 * @returns {void}
 */
function registerRoutes(ctx, { prefix, sessions, fallbackRoot }) {
  const projectRoot = fallbackRoot === "" ? process.cwd() : fallbackRoot;
  const getSession = async (request, url) => {
    const sessionId = url.searchParams.get("session");
    if (sessionId === null) return sessions.get(projectRoot);
    const root = await chatRoot(ctx, sessionId);
    if (root === null) {
      throw new ApplicationError("NOT_FOUND", "Чат не найден или у него нет рабочего каталога");
    }
    return sessions.get(root);
  };
  const guard = (request, response) => {
    const rejection = ctx.connection.requestRejection(request);
    if (rejection === undefined) return false;
    response.statusCode = rejection;
    response.end();
    return true;
  };
  for (const route of createRouteTable({ prefix, guard, getSession })) {
    ctx.effect(() => ctx.webServer.register(route), "archiview: маршрут " + route.path);
  }
}

/**
 * Разрешает рабочий каталог чата, не раскрывая деталей хранилища маршруту.
 *
 * Ошибка чтения сессии означает лишь то, что корень определить нельзя:
 * маршрут отвечает `NOT_FOUND`, а не внутренней ошибкой с путями хранилища.
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx - контекст хоста.
 * @param {string} sessionId - идентификатор чата из запроса.
 * @returns {Promise<string | null>} рабочий каталог или `null`.
 */
async function chatRoot(ctx, sessionId) {
  try {
    return await resolveChatRoot({
      sessionId,
      // Хранилище и контроллер сессий не входят в inject: панель должна
      // активироваться и в композиции без них. ctx.get читает сервис, если он есть.
      sessions: ctx.get("sessions"),
      sessionController: ctx.get("sessionController"),
    });
  } catch {
    return null;
  }
}
