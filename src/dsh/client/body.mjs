/**
 * Тело вкладки ArchiView в правой панели dsh.
 *
 * Показывает страницу, которую отдают маршруты плагина (`src/dsh/routes.mjs`),
 * в обычном iframe. Такой способ не требует переписывать интерфейс: страница
 * остаётся тем же `web/archiview`, что и в браузере, и получает базу API из
 * метатега, который вставляет маршрут.
 *
 * Адрес страницы не хранится здесь константой: префикс маршрутов сообщает хост
 * через внедрение в документ (см. `panel-contract.mjs`), поэтому настройка
 * `config.prefix` меняет и адрес iframe. Значение из документа принимается
 * только как локальный путь: сетевая ссылка (`//host/path`), обратный слэш и
 * служебные символы откатываются к стандартному префиксу, поэтому iframe не
 * может уйти на чужой origin. Без внедрения действует тот же стандартный
 * префикс — вкладка остаётся рабочей, а не падает.
 *
 * Через тот же iframe идёт и явное поручение анализа: страница присылает
 * `archiview:send`, тело передаёт текст в чат вкладки и отвечает `archiview:sent`
 * либо `archiview:send-failed`. Других сообщений мост не принимает, поэтому
 * навигация панели не может создать ход модели.
 *
 * @module plugin-architecture-change-view/dsh/client/body
 */

import { createElement, useEffect, useRef } from "react";
import { panelPageUrl, resolveClientPrefix } from "../panel-contract.mjs";

/** Приветствие страницы: сообщает, что родитель — хост ArchiView. */
const HELLO = "archiview:hello";
/** Ответ хоста: какие возможности доступны странице. */
const HOST = "archiview:host";
/** Поручение анализа из страницы в чат. */
const SEND = "archiview:send";
/** Подтверждение принятия поручения хостом. */
const SENT = "archiview:sent";
/** Отказ или ошибка передачи. */
const FAILED = "archiview:send-failed";

/**
 * Тело вкладки: страница панели во всю площадь вкладки.
 *
 * `sessionId` — стандартное свойство сессионного слота: хост по нему разрешает
 * рабочий каталог проекта, поэтому панель показывает проект именно этого чата.
 * `sendPrompt` передаёт поручение в этот же чат; без него мост остаётся
 * доступным только для просмотра.
 *
 * @param {object} [props] - свойства, переданные слотом.
 * @param {string} [props.sessionId] - идентификатор чата вкладки.
 * @param {(sessionId: string, text: string) => Promise<void>} [props.sendPrompt]
 *   отправка поручения в чат.
 * @returns {import("react").ReactElement} iframe со страницей ArchiView.
 */
export function PanelBody({ sessionId, sendPrompt } = {}) {
  const frameRef = useRef(null);

  useEffect(() => {
    const frame = frameRef.current;
    if (frame === null) return undefined;
    const origin = window.location.origin;
    const windowOf = () => frame.contentWindow;
    const post = (message) => {
      const target = windowOf();
      if (target !== null) target.postMessage(message, origin);
    };
    const canSend = () => typeof sendPrompt === "function" && typeof sessionId === "string" && sessionId !== "";
    const hostMessage = () => ({ type: HOST, protocol: 1, capabilities: { send: canSend() } });

    /** Отвечает на приветствие и выполняет ровно одно поручение анализа. */
    const onMessage = async (event) => {
      if (event.source !== windowOf()) return;
      if (event.origin !== origin) return;
      const data = event.data;
      if (data === null || typeof data !== "object") return;
      if (data.type === HELLO) {
        post(hostMessage());
        return;
      }
      if (data.type !== SEND || typeof data.id !== "string") return;
      try {
        if (!canSend()) throw new Error("Хост не умеет передавать поручения");
        await sendPrompt(sessionId, data.prompt);
        post({ type: SENT, id: data.id });
      } catch (error) {
        post({ type: FAILED, id: data.id, error: error?.message ?? "Не удалось передать поручение" });
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [sendPrompt, sessionId]);

  // Страница могла отправить приветствие до подписки: объявляем хост после
  // загрузки iframe. Повторный ответ безвреден — страница принимает первый.
  const announce = () => {
    const target = frameRef.current?.contentWindow;
    if (target === null || target === undefined) return;
    target.postMessage({
      type: HOST,
      protocol: 1,
      capabilities: { send: typeof sendPrompt === "function" && typeof sessionId === "string" && sessionId !== "" },
    }, window.location.origin);
  };

  return createElement("iframe", {
    ref: frameRef,
    src: panelPageUrl(resolveClientPrefix(), sessionId),
    title: "ArchiView",
    onLoad: announce,
    style: { display: "block", width: "100%", height: "100%", border: "0" },
  });
}
