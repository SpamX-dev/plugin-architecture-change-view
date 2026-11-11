import type { PanelBridge } from "./types.js";
import { isRecord } from "./types.js";

declare global { interface Window { openai?: { sendFollowUpMessage?: (request: { prompt: string }) => Promise<unknown> } } }

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

export function legacyPromptBridge(): PanelBridge | null {
  const legacyHost = window.openai;
  const legacy = legacyHost?.sendFollowUpMessage;
  return typeof legacy === "function" ? {
    async send(prompt: string) { await legacy.call(legacyHost, { prompt }); },
  } : null;
}

/** The HTTP entry selects the standalone or dsh channel before mounting its UI. */
export async function connectPanel(host: "web" | "dsh" = window.parent !== window && document.querySelector('meta[name="archiview-base"]') ? "dsh" : "web"): Promise<PanelBridge | null> {
  if (host === "dsh") return window.parent === window ? null : connectDshBridge();
  return legacyPromptBridge();
}

/**
 * Подключается к телу вкладки dsh по postMessage.
 *
 * Хост отвечает только на приветствие и только из родительского окна с тем же
 * origin. Без подтверждения родительского окна отправка остаётся недоступной.
 *
 * @returns {Promise<{ send?: (prompt: string) => Promise<void> } | null>} мост или `null`.
 */
async function connectDshBridge(): Promise<PanelBridge | null> {
  const origin = window.location.origin;
  if (origin === "null") return null;
  const host = await waitForHost(origin);
  if (host === null) return null;
  if (!isRecord(host.capabilities) || host.capabilities.send !== true) return {};
  return { send: (prompt) => sendThroughHost(prompt, origin) };
}

/**
 * Ждёт ответ хоста на приветствие, повторяя его до истечения срока.
 *
 * @param {string} origin - ожидаемый origin родительского окна.
 * @returns {Promise<object | null>} сообщение хоста или `null`.
 */
function waitForHost(origin: string): Promise<Record<string, unknown> | null> {
  const timeoutMs = 3000;
  const intervalMs = 350;
  return new Promise<Record<string, unknown> | null>((resolve) => {
    let poll: ReturnType<typeof setInterval> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const finish = (value: Record<string, unknown> | null) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(value);
    };
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== window.parent || event.origin !== origin) return;
      const data = event.data;
      if (!isRecord(data) || data.type !== HOST) return;
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
function sendThroughHost(prompt: string, origin: string): Promise<void> {
  if (typeof prompt !== "string" || prompt === "") {
    return Promise.reject(new Error("Пустое поручение"));
  }
  return new Promise<void>((resolve, reject) => {
    const id = newId();
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener("message", onMessage);
    };
    const onMessage = (event: MessageEvent<unknown>) => {
      if (event.source !== window.parent || event.origin !== origin) return;
      const data = event.data;
      if (!isRecord(data) || data.id !== id) return;
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
