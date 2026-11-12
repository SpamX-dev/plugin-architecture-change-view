import { readAnalysisStatus, readPreparedAnalysis } from "../../src/application/analysis-record.js";
/** Typed application operations; components do not know HTTP routes or MCP tool names. */
import type { ArchiViewClient, ClientOptions } from "./types.js";
import { isRecord } from "./types.js";

/** The transport boundary owns deserialization. The same DTOs are returned by both adapters. */
export function createArchiViewClient({ mode, connection, fetcher = globalThis.fetch, base = "", sessionId = "" }: ClientOptions): ArchiViewClient {
  async function request<T>(tool: string, verb: "GET" | "POST", route: string, args: object = {}, query = true, decode?: (value: Record<string, unknown>) => T): Promise<T> {
    let result: unknown;
    if (mode === "mcp") {
      const bridge = await connection;
      if (!bridge?.call) throw new Error("Хост не поддерживает вызовы MCP из панели");
      const input = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined));
      result = await bridge.call("archiview_ui_" + tool, input);
    } else {
      const params = new URLSearchParams();
      const { repository, ...payload } = args as Record<string, unknown>;
      if (verb === "GET" && query) for (const [key, value] of Object.entries(payload)) {
        if (value !== undefined) params.set(key, String(value));
      }
      if (typeof repository === "string") params.set("repository", repository);
      if (sessionId !== "") params.set("session", sessionId);
      const search = params.toString();
      const response = await fetcher(base + route + (search ? "?" + search : ""), verb === "GET" ? undefined : {
        method: verb, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
      });
      result = await response.json();
      if (!response.ok) throw Object.assign(new Error(isRecord(result) && typeof result.error === "string" ? result.error : "Не удалось получить данные"),
        { code: isRecord(result) && typeof result.code === "string" ? result.code : undefined });
    }
    if (!isRecord(result)) throw new Error("Сервер передал некорректные данные операции");
    return decode ? decode(result) : result as T;
  }
  return {
    setProject: args => request("set_project", "POST", "/api/project", args),
    getComparison: (args = {}) => request("get_comparison", "GET", "/api/comparison", args),
    getModule: args => request("get_module", "GET", "/api/module", args),
    prepareAnalysis: args => request("prepare_analysis", "POST", "/api/analysis", args, true, readPreparedAnalysis),
    getAnalysis: args => request("get_analysis", "GET", "/api/analysis/" + encodeURIComponent(args.id), args, false, readAnalysisStatus),
    buildReview: args => request("build_review", "POST", "/api/reviews", args),
    saveSnapshot: args => request("save_snapshot", "POST", "/api/snapshots", args),
  };
}
