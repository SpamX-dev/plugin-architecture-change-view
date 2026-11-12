import type { AnalysisRecord, ArchiViewClient, ComparisonView, ModuleSummary, PromptAction } from "./types.js";
import { errorMessage } from "./types.js";
import { byId } from "./dom.js";

export function createAnalysisControls({ client, selection, promptAction, refresh, toast }: {
  client: Pick<ArchiViewClient, "prepareAnalysis" | "getAnalysis">;
  selection: () => { module?: ModuleSummary; view: ComparisonView | null };
  promptAction: () => PromptAction | undefined;
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

  /**
   * Обновляет действие для выбранного модуля: хосту отправляет поручение, в браузере
   * предлагает копирование промпта. Ожидание импорта не мешает скопировать его повторно.
   */
  function configureAnalysisButton(button: HTMLButtonElement) {
    const { module, view, request } = selectedAnalysis();
    const pending = request && request.status !== "completed" && request.status !== "error";
    const action = promptAction();
    const busy = request?.status === "preparing";
    button.dataset.analysis = "true";
    button.disabled = !action || !view?.complete ||
      module?.documentState !== "documented" || !module?.moduleId || busy || Boolean(action.mode === "send" && pending);
    button.textContent = busy ? "Подготавливаем…" : action?.mode === "copy" ? "Копировать промпт" :
      pending ? "Ожидаем анализ…" : "Анализировать модуль";
    button.title = !action ? "Хост не поддерживает отправку поручений из панели" :
      module?.documentState !== "documented" ? "Сначала подготовьте корректный контракт модуля" :
      action.mode === "send" ? "Проверить выбранный снимок модуля агентом хоста" : "Скопировать промпт для анализа выбранного снимка модуля";
    button.onclick = runAnalysis;
  }

  /** Статус относится к конкретному запросу; принятие сообщения не выдаётся за запуск или завершение модели. */
  function renderAnalysisControls() {
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-analysis]")) configureAnalysisButton(button);
    const { request, view } = selectedAnalysis();
    watchPreparedRequest(request, view?.workspace?.repository);
    const status = byId("analysis-status");
    status.hidden = !request;
    status.textContent = request?.message ?? "";
  }

  /**
   * Фиксирует входы через сервис и передаёт промпт агенту хоста либо в буфер обмена.
   * Повторное копирование использует тот же запрос только для того же view; успешное
   * копирование означает подготовку поручения, а завершение подтверждается импортом.
   */
  async function runAnalysis() {
    const { module, view, key, request: previous } = selectedAnalysis();
    const action = promptAction();
    if (!module || !view || !key || !action) return;
    const sendToHost = action.mode === "send";
    if (previous?.status === "preparing" || (sendToHost && previous && !["completed", "error"].includes(previous.status))) return;
    const record: AnalysisRecord = !sendToHost && previous?.prompt && previous.viewId === view.id && previous.status !== "completed" ?
      previous : { status: "preparing" };
    record.status = "preparing";
    record.message = "Подготавливаем входы выбранного снимка…";
    analyses.set(key, record);
    renderAnalysisControls();
    try {
      if (!record.prompt) Object.assign(record,
        await client.prepareAnalysis({ view: view.id, path: module.key, repository: view.workspace?.repository }), { status: "preparing" });
      await action.deliver(record.prompt!);
      if (sendToHost) {
        record.message = "Поручение передано агенту хоста. Ожидаем импорт результата для выбранного снимка.";
      } else {
        record.message = "Промпт скопирован. Вставьте его в чат с агентом. Ожидаем импорт результата для выбранного снимка.";
        toast("Промпт для анализа модуля скопирован");
      }
      record.status = "prepared";
    } catch (error) {
      record.status = "error";
      record.message = (sendToHost ? "Не удалось передать анализ: " : "Не удалось скопировать промпт: ") + errorMessage(error);
    }
    renderAnalysisControls();
  }

  /** Follow only the visible request. A previous observer may still be awaiting its response. */
  function watchPreparedRequest(request?: AnalysisRecord, repository?: string) {
    const record = request?.status === "prepared" ? request : undefined;
    if (activePoll?.record === record) return;
    clearTimeout(activePoll?.timer);
    activePoll = undefined;
    if (!record?.id) return;
    const id = record.id;
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
