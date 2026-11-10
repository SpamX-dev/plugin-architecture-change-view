/**
 * Контракт между половинами плагина dsh.
 *
 * Хост и браузерный бандл — разные процессы и разные модульные графы, поэтому
 * единственное, что они могут разделить, — это зависимый от данных контракт:
 * имя глобального объекта, форму строки внедрения в index.html и правило
 * разбора. Модуль намеренно не имеет зависимостей, чтобы его можно было
 * импортировать и в Node-половину, и в бандл браузера.
 *
 * Так префикс маршрутов остаётся одним значением: конфигурация хоста попадает
 * в документ клиента через публичный канал `webserver/index-inject`, а клиент
 * читает её оттуда. Ни одна половина не дублирует константу маршрута.
 *
 * @module plugin-architecture-change-view/dsh/panel-contract
 */

/** Префикс маршрутов панели по умолчанию, если хост не сообщил другой. */
export const DEFAULT_PREFIX = "/archiview";

/** Имя глобального объекта, который хост внедряет в документ клиента. */
export const CLIENT_GLOBAL = "__DSH_ARCHIVIEW__";

/**
 * Проверяет префикс, пришедший из конфигурации или документа.
 *
 * @param {unknown} value - проверяемое значение.
 * @returns {string | null} префикс без хвостового слэша либо `null`.
 */
export function asPrefix(value) {
  if (typeof value !== "string" || !value.startsWith("/") || value.endsWith("/")) return null;
  if (value.includes("?") || value.includes("#") || /\s/.test(value)) return null;
  return value;
}

/**
 * Собирает строку внедрения конфигурации клиента в index.html.
 *
 * `kind: "global"` — штатная строка веб-сервера dsh: она присваивает
 * JSON-значение свойству `globalThis` до выполнения клиентских бандлов. Форма
 * строки стабильна и не зависит от версии плагина.
 *
 * @param {string} prefix - нормализованный префикс маршрутов панели.
 * @returns {{ kind: "global", name: string, value: { prefix: string } }} строка внедрения.
 */
export function clientConfigRow(prefix) {
  return { kind: "global", name: CLIENT_GLOBAL, value: { prefix } };
}

/**
 * Читает префикс, который сообщил хост.
 *
 * Отсутствие или порча значения не считаются ошибкой: клиент откатывается к
 * стандартному префиксу, потому что вкладка не должна ломаться из-за
 * документа, который ещё не успел получить внедрение.
 *
 * @param {object} [scope] - глобальный объект; параметр нужен для тестов.
 * @returns {string} действующий префикс маршрутов.
 */
export function resolveClientPrefix(scope = globalThis) {
  const injected = scope?.[CLIENT_GLOBAL]?.prefix;
  return asPrefix(injected) ?? DEFAULT_PREFIX;
}

/**
 * Собирает адрес страницы панели для вкладки чата.
 *
 * Идентификатор чата — единственное, что клиент знает о сессии: хост по нему
 * разрешает рабочий каталог проекта. Значение кодируется как параметр запроса,
 * потому что оно приходит из состояния клиента и не должно влиять на разбор
 * пути.
 *
 * @param {string} prefix - действующий префикс маршрутов.
 * @param {unknown} sessionId - идентификатор чата, которому принадлежит вкладка.
 * @returns {string} адрес страницы с идентификатором чата или без него.
 */
export function panelPageUrl(prefix, sessionId) {
  const base = (asPrefix(prefix) ?? DEFAULT_PREFIX) + "/";
  if (typeof sessionId !== "string" || sessionId === "") return base;
  return base + "?session=" + encodeURIComponent(sessionId);
}
