import { errorDetails } from "../runtime/errors.js";
/** Прикладная ошибка с устойчивым кодом; транспорт сам выбирает форму доставки и HTTP-статус. */
export class ApplicationError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "ApplicationError";
    this.code = code;
  }
}

/** Нормализует ошибки файлов и аргументов одинаково для CLI, HTTP и MCP. */
export function applicationError(error: unknown) {
  if (error instanceof ApplicationError) return { code: error.code, message: error.message };
  const detail = errorDetails(error);
  return { code: detail.code === "ENOENT" ? "NOT_FOUND" : error instanceof SyntaxError ? "INVALID_ARGUMENT" : "INTERNAL_ERROR",
    message: detail.message ?? "Не удалось выполнить операцию" };
}
