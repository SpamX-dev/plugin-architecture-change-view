/** Прикладная ошибка с устойчивым кодом; транспорт сам выбирает форму доставки и HTTP-статус. */
export class ApplicationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ApplicationError";
    this.code = code;
  }
}

/** Нормализует ошибки файлов и аргументов одинаково для CLI, HTTP и MCP. */
export function applicationError(error) {
  if (error instanceof ApplicationError) return { code: error.code, message: error.message };
  return { code: error.code === "ENOENT" ? "NOT_FOUND" : error instanceof SyntaxError ? "INVALID_ARGUMENT" : "INTERNAL_ERROR",
    message: error.message ?? "Не удалось выполнить операцию" };
}
