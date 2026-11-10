/**
 * Дополнение клиента только для сборки Codex: при неизвестном контексте открывает
 * существующую форму общего UI и добавляет нативный выбор папки, если он доступен.
 * Общие исходники web и клиент dsh не меняются.
 */
import { createArchiViewClient as createSharedClient } from "../../web/archiview/client.mjs";

/** Ограничивает только определение папки: чтение снимков не означает недоступность контекста. */
async function initialResponse(operation, timeoutMs) {
  let timer;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error("Не удалось автоматически определить папку проекта"),
        { code: "CODEX_CONTEXT_UNAVAILABLE" })), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

/**
 * Адаптирует неизвестный root к старому PROJECT_REQUIRED. Явное отсутствие
 * проекта сохраняет PROJECT_UNAVAILABLE. Ввод и диалог проходят ту же проверку
 * абсолютного существующего каталога; повторная смена привязанного корня запрещена.
 */
export function createArchiViewClient(options, { document = globalThis.document, timeoutMs = 15000 } = {}) {
  const client = createSharedClient(options);
  let initialized = false, manualFallback = false, bridge;
  Promise.resolve(options.connection).then((value) => { bridge = value; }).catch(() => {});
  const panel = document?.getElementById("document-panel");
  if (panel) {
    const observer = new MutationObserver(() => {
      const form = panel.querySelector(".project-form");
      if (!form || form.dataset.codexFallback) return;
      form.dataset.codexFallback = "true";
      const description = form.parentElement.querySelector("p");
      if (manualFallback && description) description.textContent = "Не удалось автоматически определить папку проекта. Укажите абсолютный путь к папке.";
      if (document.querySelector('meta[name="archiview-directory-picker"]')?.content !== "true" || !bridge?.call) return;
      const browse = document.createElement("button");
      browse.type = "button"; browse.className = "button button-quiet"; browse.textContent = "Выбрать папку…";
      const input = form.querySelector("input"), error = form.querySelector('[role="alert"]');
      form.insertBefore(browse, form.querySelector('button[type="submit"]'));
      browse.addEventListener("click", async () => {
        browse.disabled = true; error.textContent = "";
        try {
          const result = await bridge.call("archiview_ui_choose_project", {});
          if (result.projectRoot) { input.value = result.projectRoot; form.requestSubmit(); }
        } catch (cause) { error.textContent = cause.message; }
        finally { browse.disabled = false; }
      });
    });
    observer.observe(panel, { childList: true, subtree: true });
  }
  return { ...client, async getComparison(args) {
    if (!initialized) {
      try {
        const operation = Promise.resolve(options.connection).then((connection) => {
          if (!connection?.call) throw new Error("Хост не поддерживает вызовы MCP из панели");
          return connection.call("archiview_ui_get_project", {});
        });
        const result = await initialResponse(operation, timeoutMs);
        if (typeof result?.root !== "string" || result.root.trim() === "") throw Object.assign(new Error("Не удалось определить папку проекта"), { code: "CODEX_CONTEXT_UNAVAILABLE" });
        initialized = true;
      } catch (error) {
        if (error.code !== "CODEX_CONTEXT_UNAVAILABLE") throw error;
        manualFallback = true;
        throw Object.assign(new Error(error.message), { code: "PROJECT_REQUIRED" });
      }
    }
    // После подтверждения корня ждём данные обычным запросом MCP. Медленная
    // подготовка проекта и ошибки снимков не открывают форму выбора папки.
    return client.getComparison(args);
  } };
}
