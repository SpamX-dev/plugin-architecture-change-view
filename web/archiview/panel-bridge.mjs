/**
 * Канал панели ArchiView с хостом.
 *
 * Панель работает в iframe и не имеет прямого доступа к агенту. Отправка
 * поручения анализа или исправления выделена в отдельный явный метод `send`: просмотр,
 * навигация и обновление данных сообщений модели не создают.
 *
 * Поддерживаются три хоста, в порядке проверки:
 *
 * 1. dsh — страница отдана маршрутом плагина, поэтому в ней есть метатег
 *    `archiview-base`; хост подтверждает себя сообщением `archiview:host`;
 * 2. MCP Apps (Codex) — публичный SDK хоста;
 * 3. устаревший `window.openai.sendFollowUpMessage`.
 *
 * Молчаливого перехода на `fetch` нет: если хост не поддерживает отправку,
 * мост отсутствует. Самостоятельная веб-версия предлагает копирование промпта.
 */

/** Версия протокола postMessage между страницей и телом вкладки dsh. */
const PROTOCOL = 1;
/** Приветствие страницы: хост отвечает своими возможностями. */
const HELLO = "archiview:hello";
/** Ответ хоста на приветствие. */
const HOST = "archiview:host";
/** Явное поручение агенту: анализ модуля или исправление замечания. */
const SEND = "archiview:send";
/** Подтверждение принятия поручения. */
const SENT = "archiview:sent";
/** Отказ или ошибка передачи. */
const FAILED = "archiview:send-failed";

/**
 * Подключает панель к хосту и возвращает мост операций.
 *
 * @returns {Promise<{ call?: (name: string, args: object) => Promise<any>,
 *   send?: (prompt: string) => Promise<void> } | null>} мост или `null`.
 */
export async function connectPanel() {
  const legacy = window.openai?.sendFollowUpMessage;
  const fallback = typeof legacy === "function" ? {
    async send(prompt) { await window.openai.sendFollowUpMessage({ prompt }); },
  } : null;
  if (window.parent === window) return fallback;
  if (document.querySelector('meta[name="archiview-base"]') !== null) {
    const bridge = await connectDshBridge();
    if (bridge !== null) return bridge;
  }
  try {
    const { App } = await import("./mcp-app-sdk.mjs");
    const app = new App({ name: "ArchiView", version: "0.4.0" }, {}, { autoResize: false });
    await app.connect(undefined, { timeout: 5000 });
    const capabilities = app.getHostCapabilities();
    return {
      /** UI-only результат не добавляется в контекст модели и не запускает её. */
      call: capabilities?.serverTools ? async (name, args) => {
        const result = await app.callServerTool({ name, arguments: args });
        if (result.isError) {
          const error = result._meta?.error;
          throw Object.assign(new Error(error?.message ?? "Не удалось выполнить операцию панели"), { code: error?.code });
        }
        if (!result._meta || !Object.hasOwn(result._meta, "result")) throw new Error("Хост не передал данные операции в UI");
        return result._meta.result;
      } : undefined,
      /** Успешный ответ означает только принятие поручения, а не готовность анализа. */
      send: capabilities?.message ? async (prompt) => {
        const result = await app.sendMessage({ role: "user", content: [{ type: "text", text: prompt }] });
        if (result.isError) throw new Error("Codex отклонил поручение");
      } : fallback?.send,
    };
  } catch { return fallback; }
}

/**
 * Подключается к телу вкладки dsh по postMessage.
 *
 * Хост отвечает только на приветствие и только из родительского окна с тем же
 * origin. Таймаут означает, что хост не умеет принимать поручения: тогда
 * панель переходит к проверке MCP Apps, а не притворяется подключённой.
 *
 * @returns {Promise<{ send?: (prompt: string) => Promise<void> } | null>} мост или `null`.
 */
async function connectDshBridge() {
  const origin = window.location.origin;
  if (origin === "null") return null;
  const host = await waitForHost(origin);
  if (host === null) return null;
  if (host.capabilities?.send !== true) return {};
  return { send: (prompt) => sendThroughHost(prompt, origin) };
}

/**
 * Ждёт ответ хоста на приветствие, повторяя его до истечения срока.
 *
 * @param {string} origin - ожидаемый origin родительского окна.
 * @returns {Promise<object | null>} сообщение хоста или `null`.
 */
function waitForHost(origin) {
  const timeoutMs = 3000;
  const intervalMs = 350;
  return new Promise((resolve) => {
    let poll;
    let timer;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(value);
    };
    const onMessage = (event) => {
      if (event.source !== window.parent || event.origin !== origin) return;
      const data = event.data;
      if (data === null || typeof data !== "object" || data.type !== HOST) return;
      finish(data);
    };
    const hello = () => {
      try { window.parent.postMessage({ type: HELLO, protocol: PROTOCOL }, origin); }
      catch { finish(null); }
    };
    window.addEventListener("message", onMessage);
    hello();
    // Первое приветствие могло прийти до подписки тела вкладки: повторяем, пока
    // не истечёт срок. Лишние приветствия хост просто игнорирует.
    poll = setInterval(hello, intervalMs);
    timer = setTimeout(() => finish(null), timeoutMs);
  });
}

/**
 * Передаёт поручение телу вкладки и ждёт подтверждения.
 *
 * @param {string} prompt - подготовленное панелью поручение.
 * @param {string} origin - origin родительского окна.
 * @returns {Promise<void>} завершение после принятия хостом.
 */
function sendThroughHost(prompt, origin) {
  if (typeof prompt !== "string" || prompt === "") {
    return Promise.reject(new Error("Пустое поручение"));
  }
  return new Promise((resolve, reject) => {
    const id = newId();
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };
    const onMessage = (event) => {
      if (event.source !== window.parent || event.origin !== origin) return;
      const data = event.data;
      if (data === null || typeof data !== "object" || data.id !== id) return;
      if (data.type === SENT) {
        cleanup();
        resolve();
      } else if (data.type === FAILED) {
        cleanup();
        reject(new Error(typeof data.error === "string" && data.error !== "" ? data.error : "Хост отклонил поручение"));
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Хост не подтвердил передачу поручения"));
    }, 15000);
    window.addEventListener("message", onMessage);
    window.parent.postMessage({ type: SEND, id, prompt, protocol: PROTOCOL }, origin);
  });
}

/**
 * Создаёт идентификатор запроса для сопоставления ответа.
 *
 * @returns {string} уникальный идентификатор.
 */
function newId() {
  if (typeof crypto?.randomUUID === "function") return crypto.randomUUID();
  return "req-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);
}
