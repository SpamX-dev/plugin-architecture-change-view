/** Клиент операций ArchiView: компоненты UI не знают о маршрутах HTTP и именах инструментов MCP. */
const operations = {
  setProject: ["set_project", "POST", "/api/project"],
  getComparison: ["get_comparison", "GET", "/api/comparison"],
  getModule: ["get_module", "GET", "/api/module"],
  prepareAnalysis: ["prepare_analysis", "POST", "/api/analysis"],
  getAnalysis: ["get_analysis", "GET", (args) => "/api/analysis/" + encodeURIComponent(args.id)],
  buildReview: ["build_review", "POST", "/api/reviews"],
  saveSnapshot: ["save_snapshot", "POST", "/api/snapshots"],
};

/**
 * Выбирает транспорт один раз; сбой MCP не вызывает скрытого перехода к сети.
 *
 * `base` — префикс маршрутов панели, когда интерфейс обслуживает не корень
 * сервера, а плагин хоста (например, `/archiview` в dsh). В Codex и
 * standalone-режиме префикс пуст, поэтому адреса операций остаются прежними.
 *
 * `sessionId` — чат, которому принадлежит страница. Плагин хоста разрешает по
 * нему рабочий каталог проекта, поэтому идентификатор добавляется к каждому
 * запросу: и к GET-параметрам, и к адресу POST.
 */
export function createArchiViewClient({ mode, connection, fetcher = globalThis.fetch, base = "", sessionId = "" }) {
  return Object.fromEntries(Object.entries(operations).map(([method, [tool, verb, route]]) => [method, async (args = {}) => {
    if (mode === "mcp") {
      const bridge = await connection;
      if (!bridge?.call) throw new Error("Хост не поддерживает вызовы MCP из панели");
      return bridge.call("archiview_ui_" + tool, args);
    }
    const target = base + (typeof route === "function" ? route(args) : route);
    const params = new URLSearchParams(verb === "GET" && typeof route !== "function" ? args : {});
    if (typeof sessionId === "string" && sessionId !== "") params.set("session", sessionId);
    const search = params.toString();
    const response = await fetcher(target + (search === "" ? "" : "?" + search), verb === "GET" ? undefined : {
      method: verb, headers: { "Content-Type": "application/json" }, body: JSON.stringify(args),
    });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error ?? "Не удалось получить данные"), { code: result.code });
    return result;
  }]));
}
