import { isAnalysisType, validDisposition } from "../framework/ai-report/types.js";
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
    watch: args.watch === "true" ? true : args.watch === "false" ? false : args.watch,
    published: args.published === "true" ? true : args.published === "false" ? false : args.published };
}

/** Decode external arguments once before invoking the transport-independent session. */
export function callSessionOperation(session: SessionOperations, method: keyof SessionOperations, args: Record<string, unknown>, signal?: AbortSignal) {
  if (args.repository !== undefined && (typeof args.repository !== "string" || !args.repository))
    throw new ApplicationError("INVALID_ARGUMENT", "Некорректный идентификатор репозитория");
  const selector = args.repository === undefined ? {} : { repository: args.repository };
  switch (method) {
    case "getReviewSettings": return session.getReviewSettings(selector);
    case "setReviewSetting":
      if ((args.setting !== "autoAnalysis" && args.setting !== "codexHooks") || typeof args.enabled !== "boolean" ||
          Object.keys(args).some(key => !["setting", "enabled", "repository"].includes(key)))
        throw new ApplicationError("INVALID_ARGUMENT", "Укажите настройку и её новое значение");
      return session.setReviewSetting({...selector, setting:args.setting, enabled:args.enabled});
    case "waitForChanges":
      if (typeof args.cursor !== "string" || !/^[a-f0-9-]{36}\.\d+\.\d+$/.test(args.cursor)) throw new ApplicationError("INVALID_ARGUMENT", "Некорректная версия наблюдения");
      return session.waitForChanges({ ...selector, cursor: args.cursor }, signal);
    case "getComparison": {
      const { target, baseline, historyLimit, published, watch } = args;
      if ((target !== undefined && typeof target !== "string") ||
          (baseline !== undefined && typeof baseline !== "string") ||
          (historyLimit !== undefined && (typeof historyLimit !== "number" || !Number.isSafeInteger(historyLimit) || historyLimit < 1)) ||
          (published !== undefined && typeof published !== "boolean") || (watch !== undefined && typeof watch !== "boolean")) {
        throw new ApplicationError("INVALID_ARGUMENT", "Некорректные параметры сравнения");
      }
      return session.getComparison({ target, baseline, historyLimit, published, ...(watch === undefined ? {} : { watch }), ...selector });
    }
    case "getReviewStatuses":
      if (typeof args.view !== "string") throw new ApplicationError("INVALID_ARGUMENT", "Нужен view");
      return session.getReviewStatuses({view: args.view, ...selector});
    case "getModule":
      if (args.analysis !== undefined && ![true, false, "true", "false"].includes(args.analysis as boolean | string))
        throw new ApplicationError("INVALID_ARGUMENT", "Некорректный параметр analysis");
      if (typeof args.view !== "string" || typeof args.path !== "string") throw new ApplicationError("INVALID_ARGUMENT", "Нужны view и path");
      return session.getModule({view:args.view, path:args.path, currentOnly: args.currentOnly === true || args.currentOnly === "true", analysis: args.analysis !== false && args.analysis !== "false", ...selector});
    case "getRelationSource":
    case "getFileDiff":
      if (typeof args.view !== "string" || typeof args.path !== "string" || typeof args.file !== "string" || !args.file)
        throw new ApplicationError("INVALID_ARGUMENT", "Нужны view, path и file");
      return session[method]({ view: args.view, path: args.path, file: args.file, ...selector });
    case "changePrototype": {
      const { action, path, view, moduleId, title, purpose, text } = args;
      if (typeof view !== "string" || typeof path !== "string") throw new ApplicationError("INVALID_ARGUMENT", "Нужны view и path");
      const target = { ...selector, path, view };
      if (action === "create" && typeof moduleId === "string" && typeof title === "string" && typeof purpose === "string")
        return session.changePrototype({ ...target, action, moduleId, title, purpose });
      if (action === "edit" && typeof text === "string") return session.changePrototype({ ...target, action, text });
      if (action === "delete") return session.changePrototype({ ...target, action });
      throw new ApplicationError("INVALID_ARGUMENT", "Некорректные параметры изменения прототипа");
    }
    case "changeClause": {
      const { view, path, section, clauseId, action, text, undoToken } = args;
      if (typeof view !== "string" || typeof path !== "string" ||
          (section !== "purpose" && section !== "boundaries" && section !== "invariants"))
        throw new ApplicationError("INVALID_ARGUMENT", "Нужны модуль и раздел контракта");
      const target = { ...selector, view, path };
      if (action === "add" && section !== "purpose" && typeof text === "string" && text.trim() &&
          (clauseId === undefined || typeof clauseId === "string" && clauseId.trim()))
        return session.changeClause({ ...target, section, action, text, ...(clauseId === undefined ? {} : { clauseId }) });
      if (typeof clauseId !== "string" || !clauseId.trim()) throw new ApplicationError("INVALID_ARGUMENT", "Нужен ID пункта");
      if (section === "purpose" && (clauseId !== "purpose" || (action !== "edit" && action !== "revert")))
        throw new ApplicationError("INVALID_ARGUMENT", "Назначение модуля можно только редактировать");
      if (action === "edit" && typeof text === "string" && text.trim())
        return session.changeClause({ ...target, section, clauseId, action, text });
      if (action === "delete" || action === "revert") return session.changeClause({ ...target, section, clauseId, action });
      if (action === "restore" && typeof undoToken === "string")
        return session.changeClause({ ...target, section, clauseId, action, undoToken });
      throw new ApplicationError("INVALID_ARGUMENT", "Некорректные параметры изменения пункта");
    }
    case "updateFinding": {
      const {view, path, reviewId, findingId, status, decision, expected} = args;
      const next = {status, decision};
      if (Object.keys(args).some(key => !["repository","view","path","reviewId","findingId","status","decision","expected"].includes(key)) ||
          typeof view !== "string" || typeof path !== "string" || typeof reviewId !== "string" || typeof findingId !== "string" ||
          !validDisposition(next) || !validDisposition(expected))
        throw new ApplicationError("INVALID_ARGUMENT", "Можно изменить только статус и решение замечания.");
      return session.updateFinding({...selector, view, path, reviewId, findingId, ...next, expected});
    }
    case "prepareAnalysis":
      if (typeof args.view !== "string" || typeof args.path !== "string" || (args.analysisType !== undefined && !isAnalysisType(args.analysisType)))
        throw new ApplicationError("INVALID_ARGUMENT", "Нужны view, path и корректный вид анализа");
      return session.prepareAnalysis({view: args.view, path: args.path, analysisType: args.analysisType, ...selector});
    case "getRelations":
    case "buildRelations":
    case "buildReview":
      if (typeof args.view !== "string" || typeof args.path !== "string")
        throw new ApplicationError("INVALID_ARGUMENT", "Нужны view и path");
      return session[method]({ view: args.view, path: args.path, ...selector });
    case "listHarnesses":
      return session.listHarnesses(selector);
    case "deliverFindingFix":
    case "deliverAnalysis":
      if (typeof args.id !== "string" || !/^[a-f0-9-]{36}$/.test(args.id) ||
          typeof args.harnessId !== "string" || !/^(codex|dsh)-[a-f0-9]{24}$/.test(args.harnessId))
        throw new ApplicationError("INVALID_ARGUMENT", "Некорректный идентификатор запроса или harness");
      if (method === "deliverFindingFix") {
        const { reviewId, findingId } = args;
        if (typeof reviewId !== "string" || !reviewId ||
            typeof findingId !== "string" || !findingId) throw new ApplicationError("INVALID_ARGUMENT", "Не указано замечание отчёта");
        return session.deliverFindingFix({ ...selector, id: args.id, harnessId: args.harnessId, reviewId, findingId });
      }
      return session.deliverAnalysis({ ...selector, id: args.id, harnessId: args.harnessId });
    case "getAnalysis":
      if (typeof args.id !== "string") throw new ApplicationError("INVALID_ARGUMENT", "Некорректный идентификатор анализа");
      return session.getAnalysis({ id: args.id, ...selector });
    case "saveSnapshot":
      if (typeof args.view !== "string" || (args.label !== undefined && typeof args.label !== "string"))
        throw new ApplicationError("INVALID_ARGUMENT", "Некорректные параметры снимка");
      return session.saveSnapshot({ view: args.view, label: args.label, ...selector });
  }
}
