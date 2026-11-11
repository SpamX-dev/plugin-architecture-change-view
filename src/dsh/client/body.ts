/**
 * Тело вкладки ArchiView в правой панели dsh.
 *
 * Показывает страницу, которую отдают маршруты плагина (`src/dsh/routes.ts`),
 * в обычном iframe. Такой способ не требует переписывать интерфейс: страница
 * остаётся тем же `web/archiview`, что и в браузере, и получает базу API из
 * метатега, который вставляет маршрут.
 *
 * Адрес страницы не хранится здесь константой: префикс маршрутов сообщает хост
 * через внедрение в документ (см. `panel-contract.ts`), поэтому настройка
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
import { panelPageUrl, resolveClientPrefix } from "../panel-contract.js";
import { listenToFrame } from "./frame-bridge.js";

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
export function PanelBody({ sessionId, sendPrompt }: import("./types.js").PanelProps = {}) {
  const frameRef = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    const frame = frameRef.current;
    if (frame) return listenToFrame(frame, { sessionId, sendPrompt });
  }, [sendPrompt, sessionId]);

  return createElement("iframe", {
    ref: frameRef,
    src: panelPageUrl(resolveClientPrefix(), sessionId),
    title: "ArchiView",
    style: { display: "block", width: "100%", height: "100%", border: "0" },
  });
}
