import { isAnalysisType, type AnalysisType } from "../framework/ai-report/types.js";

export interface AnalysisRequest {
  analysisType?: AnalysisType;
  schema_version: number;
  id: string;
  moduleId: string;
  directory: string;
  viewId: string;
  reviewId: string;
  createdAt: string;
  inputDigest: string;
  snapshotsDigest?: string;
}

export interface HarnessOption { id: string; name: string; reason?: string }
export interface Delivery {
  harnessId: string;
  name: string;
  state: "pending" | "sent" | "unknown";
  chatId?: string;
  message?: string;
}

export function readDelivery(value: unknown): Delivery {
  if (!isRecord(value) || typeof value.harnessId !== "string" || typeof value.name !== "string" ||
      (value.state !== "pending" && value.state !== "sent" && value.state !== "unknown") ||
      (value.state === "sent" && (typeof value.chatId !== "string" || !value.chatId)) ||
      (value.message !== undefined && typeof value.message !== "string")) throw new Error("Некорректные данные доставки");
  return { harnessId: value.harnessId, name: value.name, state: value.state,
    chatId: typeof value.chatId === "string" ? value.chatId : undefined, message: value.message };
}

export interface AnalysisStatus extends AnalysisRequest {
  delivery?: Delivery;
  limitation?: string;
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
  if ((value.analysisType !== undefined && !isAnalysisType(value.analysisType)) || schema_version !== 1 || typeof id !== "string" || typeof moduleId !== "string" ||
      typeof directory !== "string" || typeof viewId !== "string" || typeof reviewId !== "string" ||
      typeof createdAt !== "string" || typeof inputDigest !== "string" || (snapshotsDigest !== undefined && typeof snapshotsDigest !== "string") || (snapshotsDigest === undefined && !value.analysisType)) {
    throw new Error("Некорректная запись запроса анализа");
  }
  return { ...(value.analysisType ? {analysisType: value.analysisType} : {}), schema_version, id, moduleId, directory, viewId, reviewId, createdAt, inputDigest, snapshotsDigest };
}

export function readAnalysisStatus(value: Record<string, unknown>): AnalysisStatus {
  const status = value.status;
  if (status !== "prepared" && status !== "completed") throw new Error("Некорректный статус запроса анализа");
  return { ...readAnalysisRequest(value), status, ...(value.delivery ? { delivery: readDelivery(value.delivery) } : {}),
    ...(typeof value.limitation === "string" ? {limitation:value.limitation} : {}) };
}

export function readPreparedAnalysis(value: Record<string, unknown>): PreparedAnalysis {
  if (value.status !== "prepared" || typeof value.prompt !== "string")
    throw new Error("Сервис не вернул подготовленное поручение анализа");
  return { ...readAnalysisRequest(value), status: "prepared", prompt: value.prompt };
}
