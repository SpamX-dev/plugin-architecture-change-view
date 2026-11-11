import type { PanelProps } from "./types.js";

/** Bind one iframe to the chat selected by the dsh slot for this subscription. */
export function listenToFrame(frame: HTMLIFrameElement, { sessionId, sendPrompt }: PanelProps) {
  const origin = window.location.origin;
  const onMessage = async (event: MessageEvent<unknown>) => {
    const source = frame.contentWindow;
    if (!source || event.source !== source || event.origin !== origin) return;
    if (!event.data || typeof event.data !== "object") return;
    const data = event.data as Record<string, unknown>;
    const sameChat = typeof sessionId === "string" && sessionId !== "" && data.sessionId === sessionId;
    if (data.type === "archiview:hello") {
      source.postMessage({ type: "archiview:host", protocol: 2, sessionId,
        capabilities: { send: data.protocol === 2 && sameChat && typeof sendPrompt === "function" } }, origin);
      return;
    }
    if (data.type !== "archiview:send" || typeof data.id !== "string") return;
    const reply = { id: data.id, sessionId: data.sessionId, protocol: 2 };
    try {
      if (data.protocol !== 2 || !sameChat) throw new Error("Чат поручения не совпадает с чатом вкладки");
      if (!sendPrompt || typeof data.prompt !== "string") throw new Error("Хост не умеет передавать поручения");
      await sendPrompt(sessionId, data.prompt);
      source.postMessage({ type: "archiview:sent", ...reply }, origin);
    } catch (error) {
      source.postMessage({ type: "archiview:send-failed", ...reply,
        error: error instanceof Error ? error.message : "Не удалось передать поручение" }, origin);
    }
  };
  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}
