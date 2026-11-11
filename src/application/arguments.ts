import type { SessionOperations } from "./api.js";
import { ApplicationError } from "./errors.js";

/** Decode external arguments once before invoking the transport-independent session. */
export function callSessionOperation(session: SessionOperations, method: keyof SessionOperations, args: Record<string, unknown>) {
  switch (method) {
    case "getComparison": {
      const { target, baseline, historyLimit } = args;
      if ((target !== undefined && typeof target !== "string") ||
          (baseline !== undefined && typeof baseline !== "string") ||
          (historyLimit !== undefined && typeof historyLimit !== "number")) {
        throw new ApplicationError("INVALID_ARGUMENT", "Некорректные параметры сравнения");
      }
      return session.getComparison({ target, baseline, historyLimit });
    }
    case "getModule":
    case "prepareAnalysis":
    case "buildReview":
      if (typeof args.view !== "string" || typeof args.path !== "string")
        throw new ApplicationError("INVALID_ARGUMENT", "Нужны view и path");
      return session[method]({ view: args.view, path: args.path });
    case "getAnalysis":
      if (typeof args.id !== "string") throw new ApplicationError("INVALID_ARGUMENT", "Некорректный идентификатор анализа");
      return session.getAnalysis({ id: args.id });
    case "saveSnapshot":
      if (typeof args.view !== "string" || (args.label !== undefined && typeof args.label !== "string"))
        throw new ApplicationError("INVALID_ARGUMENT", "Некорректные параметры снимка");
      return session.saveSnapshot({ view: args.view, label: args.label });
  }
}
