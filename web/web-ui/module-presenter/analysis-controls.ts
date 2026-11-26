import type { AnalysisType } from "../../../framework/ai-report/types.js";
import { bindHarnessMenu } from "./harness-menu.js";
import type { AnalysisRecord, ArchiViewClient, ComparisonView, ModuleSummary } from "../types.js";
import { errorMessage } from "../types.js";
import { byId } from "../views/dom.js";

export function createAnalysisControls({ client, selection, copyPrompt, refresh, toast }: {
  client: Pick<ArchiViewClient, "prepareAnalysis" | "getAnalysis" | "listHarnesses" | "deliverAnalysis">;
  selection: () => { type?: AnalysisType; module?: ModuleSummary; view: ComparisonView | null };
  copyPrompt: (prompt: string) => Promise<void>;
  refresh: (view: ComparisonView, module: ModuleSummary) => Promise<void>;
  toast: (message: string) => void;
}) {
  const analyses = new Map<string, AnalysisRecord>();
  const actions = new Set<AnalysisRecord>();
  type PendingRequest = {
    record: AnalysisRecord;
    request: NonNullable<AnalysisRecord["request"]>;
    imported?: boolean;
    poll?: { timer: ReturnType<typeof setTimeout> };
  };
  const pending = new Map<string, PendingRequest>();
  function selectedAnalysis() {
    const { module, view, type } = selection();
    const key = module?.moduleId && view && type ? JSON.stringify([view.root, view.id, module.moduleId, type]) : undefined;
    return { module, view, key, type, request: key ? analyses.get(key) : undefined };
  }

  const trigger = document.querySelector<HTMLButtonElement>("#analyze-module")!;
  const status = byId("analysis-status");
  const menu = document.getElementById("analysis-menu")!;
  const hosts = document.getElementById("analysis-harnesses")!;
  const copy = document.querySelector<HTMLButtonElement>("#copy-analysis")!;
  const updateMenu = bindHarnessMenu(trigger, menu, hosts, copy, () => {
    const { key, view, request } = selectedAnalysis();
    if (!key || !view) return;
    return { list: () => client.listHarnesses({ repository: view.workspace?.repository }),
      current: () => selectedAnalysis().key === key, prefix: request?.delivery ? "Новый анализ · " : "",
      copy: () => void runAnalysis(), choose: id => void runAnalysis(id) };
  });
  function deliveryMessage(receipt: NonNullable<AnalysisRecord["delivery"]>) {
    if (receipt.state === "sent") return "Отправлено в новый чат " + receipt.name + ". Ожидаем импорт результата.";
    return receipt.state === "pending" ? "Ожидаем подтверждение доставки в " + receipt.name + "." :
      "Доставка в " + receipt.name + " не подтверждена. " + (receipt.message ?? "");
  }

  function renderAnalysisControls() {
    const { request, view, module, type } = selectedAnalysis();
    const busy = Boolean(request && actions.has(request));
    trigger.disabled = !type || !module?.currentPath || !view?.complete || module?.documentState !== "documented" || !module.moduleId || busy;
    trigger.textContent = busy ? "Подготавливаем…" : "Выполнить анализ ▾";
    updateMenu();
    watchPreparedRequests(view, module);
    const unavailable = !module?.currentPath ? "Модуль отсутствует в выбранном срезе." :
      module.documentState !== "documented" ? "Для анализа нужен контракт модуля." :
      view && !view.complete ? "Для анализа нужен полный срез." : "";
    status.textContent = request?.message || unavailable;
    status.hidden = !status.textContent;
  }

  async function runAnalysis(harnessId?: string) {
    const { module, view, key, type, request: previous } = selectedAnalysis();
    if (!module || !view || !key || previous && actions.has(previous)) return;
    const record: AnalysisRecord = previous && previous.status !== "completed" && !(harnessId && previous.delivery) ? previous :
      { status: "ready", message: "" };
    const watching = record.status === "prepared";
    if (!watching) {
      record.status = "preparing";
      record.message = "Подготавливаем входы выбранного снимка…";
    }
    actions.add(record);
    analyses.set(key, record);
    renderAnalysisControls();
    try {
      if (!record.request) {
        const prepared = await client.prepareAnalysis({ view: view.id, path: module.key, analysisType: type, repository: view.workspace?.repository });
        if (prepared.analysisType !== type || prepared.viewId !== view.id || prepared.moduleId !== module.moduleId)
          throw new Error("Получен запрос для другого снимка модуля");
        record.request = prepared;
      }
      if (selectedAnalysis().key !== key) {
        if (!watching) {
          record.status = "ready";
          record.message = "Промпт подготовлен. Скопируйте его для анализа.";
        }
        return;
      }
      if (harnessId) {
        record.message = "Отправляем поручение в новый чат…";
        renderAnalysisControls();
        try {
          record.delivery = await client.deliverAnalysis({ repository: view.workspace?.repository, id: record.request.id, harnessId });
          if (record.status !== "preparing" && record.status !== "prepared") return;
          record.message = deliveryMessage(record.delivery);
        } catch (error) {
          if (record.status !== "preparing" && record.status !== "prepared") return;
          record.message = "Не удалось подтвердить доставку: " + errorMessage(error);
        }
        record.status = "prepared";
        return;
      }
      await copyPrompt(record.request.prompt);
      if (record.status !== "preparing" && record.status !== "prepared") return;
      record.status = "prepared";
      record.message = "Промпт скопирован. Вставьте его в чат с агентом. Ожидаем импорт результата для выбранного снимка.";
      if (selectedAnalysis().key === key) toast("Промпт для анализа модуля скопирован");
    } catch (error) {
      if (record.status !== "preparing" && record.status !== "prepared") return;
      record.status = watching ? "prepared" : "error";
      record.message = (record.request ? "Не удалось скопировать промпт: " : "Не удалось подготовить промпт: ") + errorMessage(error);
    } finally {
      actions.delete(record);
      if (record.status === "prepared" && record.request && !pending.has(record.request.id)) {
        pending.set(record.request.id, { record, request: record.request });
      }
      renderAnalysisControls();
    }
  }

  /** Every pending request belongs to one card, across all of its tabs. */
  function watchPreparedRequests(view: ComparisonView | null, module?: ModuleSummary) {
    for (const item of pending.values()) {
      if (!view || !module || item.request.viewId !== view.id || item.request.moduleId !== module.moduleId || item.record.status !== "prepared") {
        clearTimeout(item.poll?.timer);
        item.poll = undefined;
      } else if (!item.poll) startPoll(item, view, module);
    }
  }

  function startPoll(item: PendingRequest, view: ComparisonView, module: ModuleSummary) {
    const { id, viewId, moduleId } = item.request;
    const { record } = item;
    const observer = { timer: setTimeout(check, 3000) };
    item.poll = observer;

    async function check() {
      if (item.poll !== observer) return;
      if (document.visibilityState === "hidden") {
        observer.timer = setTimeout(check, 3000);
        return;
      }
      try {
        if (!item.imported) {
          const status = await client.getAnalysis({ id, repository: view.workspace?.repository });
          if (item.poll !== observer) return;
          if (status.id !== id || status.viewId !== viewId || status.moduleId !== moduleId)
            throw new Error("Получен статус другого запроса анализа");
          if (status.delivery) {
            record.delivery = status.delivery;
            record.message = deliveryMessage(status.delivery);
          }
          if (status.limitation) {
            pending.delete(id);
            item.poll = undefined;
            record.status = "error";
            record.message = status.limitation;
            renderAnalysisControls();
            return;
          }
          item.imported = status.status === "completed";
        }
        if (item.imported) {
          await refresh(view, module);
          if (item.poll !== observer) return;
          pending.delete(id);
          item.poll = undefined;
          record.status = "completed";
          record.message = "Анализ выбранного снимка сохранён. Актуальность показана в результатах проверки.";
          renderAnalysisControls();
          return;
        }
      } catch (error) {
        if (item.poll !== observer) return;
        record.message = (item.imported ? "Анализ сохранён. Не удалось обновить карточку: " : "Не удалось обновить статус: ") + errorMessage(error);
      }
      observer.timer = setTimeout(check, 3000);
      renderAnalysisControls();
    }
  }
  return renderAnalysisControls;
}
