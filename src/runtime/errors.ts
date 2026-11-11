/** Normalize unknown exceptions while retaining filesystem/process diagnostics. */
export interface ErrorDetails extends Error { code?: string; stderr?: string; exitCode?: number | null; }
export function errorDetails(error: unknown): ErrorDetails {
  if (error instanceof Error) return error;
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const result: ErrorDetails = new Error(typeof value.message === "string" ? value.message : String(error));
  if (typeof value.code === "string") result.code = value.code;
  if (typeof value.stderr === "string") result.stderr = value.stderr;
  if (typeof value.exitCode === "number" || value.exitCode === null) result.exitCode = value.exitCode;
  return result;
}
