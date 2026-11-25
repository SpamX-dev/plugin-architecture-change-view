import { bindHarnessMenu } from "./harness-menu.js";
import type { AnalysisRecord, ArchiViewClient, ComparisonView, ModuleSummary } from "../types.js";
import { errorMessage } from "../types.js";
import { byId } from "../views/dom.js";

export function createAnalysisControls({ client, selection, copyPrompt, refresh, toast }: {
  client: Pick<ArchiViewClient, "prepareAnalysis" | "getAnalysis" | "listHarnesses" | "deliverAnalysis">;
  selection: () => { module?: ModuleSummary; view: ComparisonView | null };
  copyPrompt: (prompt: string) => Promise<void>;
  refresh: () => Promise<void>;
  toast: (message: string) => void;
}) {
  const analyses = new Map<string, AnalysisRecord>();
  let activePoll: { record: AnalysisRecord; timer: ReturnType<typeof setTimeout> } | undefined;
  function selectedAnalysis() {
    const { module, view } = selection();
    const key = module?.moduleId && view ? JSON.stringify([view.root, view.id, module.moduleId]) : undefined;
    return { module, view, key, request: key ? analyses.get(key) : undefined };
  }

  const trigger = document.querySelector<HTMLButtonElement>("#analyze-module")!;
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
    const { request, view, module } = selectedAnalysis();
    trigger.disabled = !view?.complete || module?.documentState !== "documented" || !module.moduleId || request?.status === "preparing";
    trigger.textContent = request?.status === "preparing" ? "Подготавливаем…" : "Анализировать ▾";
    updateMenu();
    watchPreparedRequest(request, view?.workspace?.repository);
    const status = byId("analysis-status");
    status.hidden = !request;
    status.textContent = request?.message ?? "";
  }

  async function runAnalysis(harnessId?: string) {
    const { module, view, key, request: previous } = selectedAnalysis();
    if (!module || !view || !key || previous?.status === "preparing") return;
    const record: AnalysisRecord = previous && previous.status !== "completed" && !(harnessId && previous.delivery) ? previous :
      { status: "ready", message: "" };
    const alreadyCopied = record.status === "prepared";
    record.status = "preparing";
    record.message = "Подготавливаем входы выбранного снимка…";
    analyses.set(key, record);
    renderAnalysisControls();
    try {
      if (!record.request) {
        const prepared = await client.prepareAnalysis({ view: view.id, path: module.key, repository: view.workspace?.repository });
        if (prepared.viewId !== view.id || prepared.moduleId !== module.moduleId)
          throw new Error("Получен запрос для другого снимка модуля");
        record.request = prepared;
      }
      if (selectedAnalysis().key !== key) {
        record.status = alreadyCopied ? "prepared" : "ready";
        record.message = alreadyCopied ? "Ожидаем импорт результата для выбранного снимка." : "Промпт подготовлен. Скопируйте его для анализа.";
        return;
      }
      if (harnessId) {
        record.message = "Отправляем поручение в новый чат…";
        renderAnalysisControls();
        try {
          record.delivery = await client.deliverAnalysis({ repository: view.workspace?.repository, id: record.request.id, harnessId });
          record.message = deliveryMessage(record.delivery);
        } catch (error) {
          record.message = "Не удалось подтвердить доставку: " + errorMessage(error);
        }
        record.status = "prepared";
        return;
      }
      await copyPrompt(record.request.prompt);
      record.status = "prepared";
      record.message = "Промпт скопирован. Вставьте его в чат с агентом. Ожидаем импорт результата для выбранного снимка.";
      if (selectedAnalysis().key === key) toast("Промпт для анализа модуля скопирован");
    } catch (error) {
      record.status = alreadyCopied ? "prepared" : "error";
      record.message = (record.request ? "Не удалось скопировать промпт: " : "Не удалось подготовить промпт: ") + errorMessage(error);
    } finally {
      renderAnalysisControls();
    }
  }

  /** Follow only the visible request. A previous observer may still be awaiting its response. */
  function watchPreparedRequest(request?: AnalysisRecord, repository?: string) {
    const record = request?.status === "prepared" ? request : undefined;
    if (activePoll?.record === record) return;
    clearTimeout(activePoll?.timer);
    activePoll = undefined;
    if (!record?.request) return;
    const { id, viewId, moduleId } = record.request;
    const observer = { record, timer: setTimeout(check, 3000) };
    activePoll = observer;

    async function check() {
      if (activePoll !== observer) return;
      if (document.visibilityState === "hidden") {
        observer.timer = setTimeout(check, 3000);
        return;
      }
      try {
        const status = await client.getAnalysis({ id, repository });
        if (activePoll !== observer) return;
        if (status.id !== id || status.viewId !== viewId || status.moduleId !== moduleId)
          throw new Error("Получен статус другого запроса анализа");
        if (status.delivery) {
          observer.record.delivery = status.delivery;
          observer.record.message = deliveryMessage(status.delivery);
        }
        if (status.status === "completed") {
          observer.record.status = "completed";
          observer.record.message = "Анализ выбранного снимка сохранён. Актуальность показана в результатах проверки.";
          renderAnalysisControls();
          await refresh();
          return;
        }
      } catch (error) {
        if (activePoll !== observer) return;
        observer.record.message = "Не удалось обновить статус: " + errorMessage(error);
      }
      observer.timer = setTimeout(check, 3000);
      renderAnalysisControls();
    }
  }
  return renderAnalysisControls;
}
