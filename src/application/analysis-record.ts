export interface AnalysisRequest {
  schema_version: number;
  id: string;
  moduleId: string;
  directory: string;
  viewId: string;
  reviewId: string;
  createdAt: string;
  inputDigest: string;
  snapshotsDigest: string;
}

export interface AnalysisStatus extends AnalysisRequest {
  status: "prepared" | "completed";
}
export interface PreparedAnalysis extends AnalysisStatus {
  status: "prepared";
  prompt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Decode the v1 metadata shared by persisted requests and analysis responses. */
export function readAnalysisRequest(value: unknown): AnalysisRequest {
  if (!isRecord(value)) throw new Error("Некорректная запись запроса анализа");
  const { schema_version, id, moduleId, directory, viewId, reviewId, createdAt, inputDigest, snapshotsDigest } = value;
  if (schema_version !== 1 || typeof id !== "string" || typeof moduleId !== "string" ||
      typeof directory !== "string" || typeof viewId !== "string" || typeof reviewId !== "string" ||
      typeof createdAt !== "string" || typeof inputDigest !== "string" || typeof snapshotsDigest !== "string") {
    throw new Error("Некорректная запись запроса анализа");
  }
  return { schema_version, id, moduleId, directory, viewId, reviewId, createdAt, inputDigest, snapshotsDigest };
}

export function readAnalysisStatus(value: Record<string, unknown>): AnalysisStatus {
  const status = value.status;
  if (status !== "prepared" && status !== "completed") throw new Error("Некорректный статус запроса анализа");
  return { ...readAnalysisRequest(value), status };
}

export function readPreparedAnalysis(value: Record<string, unknown>): PreparedAnalysis {
  if (value.status !== "prepared" || typeof value.prompt !== "string")
    throw new Error("Сервис не вернул подготовленное поручение анализа");
  return { ...readAnalysisRequest(value), status: "prepared", prompt: value.prompt };
}
