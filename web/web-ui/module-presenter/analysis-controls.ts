import type { AnalysisRecord, ArchiViewClient, ComparisonView, ModuleSummary } from "../types.js";
import { errorMessage } from "../types.js";
import { byId } from "../views/dom.js";

export function createAnalysisControls({ client, selection, copyPrompt, refresh, toast }: {
  client: Pick<ArchiViewClient, "prepareAnalysis" | "getAnalysis">;
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

  function configureAnalysisButton(button: HTMLButtonElement) {
    const { module, view, request } = selectedAnalysis();
    const busy = request?.status === "preparing";
    button.disabled = !view?.complete || module?.documentState !== "documented" || !module.moduleId || busy;
    button.textContent = busy ? "Подготавливаем…" : "Копировать промпт";
    button.title = module?.documentState !== "documented" ? "Сначала подготовьте корректный контракт модуля" :
      "Скопировать промпт для анализа выбранного снимка модуля";
    button.onclick = runAnalysis;
  }

  function renderAnalysisControls() {
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-analysis]")) configureAnalysisButton(button);
    const { request, view } = selectedAnalysis();
    watchPreparedRequest(request, view?.workspace?.repository);
    const status = byId("analysis-status");
    status.hidden = !request;
    status.textContent = request?.message ?? "";
  }

  async function runAnalysis() {
    const { module, view, key, request: previous } = selectedAnalysis();
    if (!module || !view || !key || previous?.status === "preparing") return;
    const record: AnalysisRecord = previous && previous.status !== "completed" ? previous :
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
