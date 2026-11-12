import type { SessionOperations } from "./api.js";
import { ApplicationError } from "./errors.js";

/** Independently supplied selectors must agree on which repository owns the operation. */
export function repositoryArguments(selected: string | null, args: Record<string, unknown>) {
  if (selected === null) return args;
  if (args.repository !== undefined && args.repository !== selected)
    throw new ApplicationError("INVALID_ARGUMENT", "Не совпадают идентификаторы репозитория");
  return { ...args, repository: selected };
}

/** Decode URL scalars for both HTTP adapters. Invalid booleans are rejected by the operation. */
export function comparisonQueryArguments(args: Record<string, unknown>) {
  return { ...args, historyLimit: args.historyLimit === undefined ? undefined : Number(args.historyLimit),
    published: args.published === "true" ? true : args.published === "false" ? false : args.published };
}

/** Decode external arguments once before invoking the transport-independent session. */
export function callSessionOperation(session: SessionOperations, method: keyof SessionOperations, args: Record<string, unknown>) {
  if (args.repository !== undefined && (typeof args.repository !== "string" || !args.repository))
    throw new ApplicationError("INVALID_ARGUMENT", "Некорректный идентификатор репозитория");
  const selector = args.repository === undefined ? {} : { repository: args.repository };
  switch (method) {
    case "getComparison": {
      const { target, baseline, historyLimit, published } = args;
      if ((target !== undefined && typeof target !== "string") ||
          (baseline !== undefined && typeof baseline !== "string") ||
          (historyLimit !== undefined && (typeof historyLimit !== "number" || !Number.isSafeInteger(historyLimit) || historyLimit < 1)) ||
          (published !== undefined && typeof published !== "boolean")) {
        throw new ApplicationError("INVALID_ARGUMENT", "Некорректные параметры сравнения");
      }
      return session.getComparison({ target, baseline, historyLimit, published, ...selector });
    }
    case "getModule":
    case "prepareAnalysis":
    case "buildReview":
      if (typeof args.view !== "string" || typeof args.path !== "string")
        throw new ApplicationError("INVALID_ARGUMENT", "Нужны view и path");
      return session[method]({ view: args.view, path: args.path, ...selector });
    case "getAnalysis":
      if (typeof args.id !== "string") throw new ApplicationError("INVALID_ARGUMENT", "Некорректный идентификатор анализа");
      return session.getAnalysis({ id: args.id, ...selector });
    case "saveSnapshot":
      if (typeof args.view !== "string" || (args.label !== undefined && typeof args.label !== "string"))
        throw new ApplicationError("INVALID_ARGUMENT", "Некорректные параметры снимка");
      return session.saveSnapshot({ view: args.view, label: args.label, ...selector });
  }
}
