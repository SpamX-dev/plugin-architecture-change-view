import { readAnalysisStatus, readPreparedAnalysis, readDelivery } from "../../../module-operations/analysis-record.js";
import type { ArchiViewClient, ClientOptions } from "../types.js";
import { isRecord } from "../types.js";

/** Browser-facing operations scoped to the selected workspace repository. */
export function createArchiViewClient({ fetcher = globalThis.fetch, base = "" }: ClientOptions = {}): ArchiViewClient {
  async function request<T>(verb: "GET" | "POST", route: string, args: object = {}, query = true, decode?: (value: Record<string, unknown>) => T, signal?: AbortSignal): Promise<T> {
    const params = new URLSearchParams();
    const { repository, ...payload } = args as Record<string, unknown>;
    if (verb === "GET" && query) for (const [key, value] of Object.entries(payload)) {
      if (value !== undefined) params.set(key, String(value));
    }
    if (typeof repository === "string") params.set("repository", repository);
    const search = params.toString();
    const response = await fetcher(base + route + (search ? "?" + search : ""), verb === "GET" ? (signal ? { signal } : undefined) : {
      method: verb, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const result: unknown = await response.json();
    if (!response.ok) throw Object.assign(new Error(isRecord(result) && typeof result.error === "string" ? result.error : "Не удалось получить данные"),
      { code: isRecord(result) && typeof result.code === "string" ? result.code : undefined });
    if (!isRecord(result)) throw new Error("Сервер передал некорректные данные операции");
    return decode ? decode(result) : result as T;
  }
  return {
    getComparison: (args = {}) => request("GET", "/api/comparison", args),
    waitForChanges: (args, signal) => request("GET", "/api/changes", args, true, undefined, signal),
    getReviewStatuses: args => request("GET", "/api/review-statuses", args),
    getModule: args => request("GET", "/api/module", args),
    getRelations: args => request("GET", "/api/relations", args),
    buildRelations: args => request("POST", "/api/relations", args),
    getRelationSource: args => request("GET", "/api/relations/source", args),
    changeClause: args => request("POST", "/api/contract-clause", args),
    changePrototype: args => request("POST", "/api/prototype", args),
    getFileDiff: args => request("GET", "/api/file-diff", args),
    listHarnesses: args => request("GET", "/api/harnesses", args),
    deliverFindingFix: args => request("POST", "/api/findings/fix", args, true, readDelivery),
    deliverAnalysis: args => request("POST", "/api/analysis/deliver", args, true, readDelivery),
    prepareAnalysis: args => request("POST", "/api/analysis", args, true, readPreparedAnalysis),
    getAnalysis: args => request("GET", "/api/analysis/" + encodeURIComponent(args.id), args, false, readAnalysisStatus),
    buildReview: args => request("POST", "/api/reviews", args),
    saveSnapshot: args => request("POST", "/api/snapshots", args),
  };
}
