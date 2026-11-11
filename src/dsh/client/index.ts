/**
 * Браузерная половина плагина ArchiView для dsh.
 *
 * Модуль регистрирует в правой панели тип вкладки ArchiView и её тело. Тип
 * объявлен в band `extension` — это штатная полоса для типов из другого
 * пакета: она выше встроенных и позволяет открывать страницу плагина, не
 * занимая чужой `kind`.
 *
 * Клиентская половина ничего не читает из проекта и не вызывает прикладной
 * сервис: страницу отдаёт маршрут хоста, а тело вкладки только показывает её в
 * iframe. Поэтому здесь нет ни сетевого клиента, ни операций просмотра.
 *
 * @module plugin-architecture-change-view/dsh/client
 */

import { createElement } from "react";
import { PanelBody } from "./body.js";
import { createPromptSender } from "./prompt.js";

/**
 * Сервисы клиента, без которых регистрация невозможна: слоты правой панели и
 * реестр типов вкладок.
 */
export const inject = ["slots", "sidebarRightTabs"];

/** Идентификатор реализации типа вкладки; он же ключ тела в слоте. */
export const TAB_ID = "plugin-architecture-change-view/archiview";

/** Дискриминатор типа вкладки, которым открывается страница. */
export const TAB_KIND = "archiview";

/**
 * Регистрирует вкладку ArchiView в клиенте dsh.
 *
 * Обе регистрации обёрнуты в `ctx.effect`, поэтому живут ровно столько же,
 * сколько плагин: выгрузка снимает и тип, и тело.
 *
 * @param {import("@deepseek-ai/cordis").Context} ctx - контекст клиента.
 * @returns {void}
 */
export function apply(ctx: import("./types.js").ClientContext) {
  // Отправитель замыкается на контекст плагина: тело вкладки получает только
  // функцию, поэтому не ищет сервисы само и не знает их имён.
  const sendPrompt = createPromptSender(ctx);
  const Body = (props: import("./types.js").PanelProps) => createElement<import("./types.js").PanelProps>(PanelBody, { ...props, sendPrompt });

  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: TAB_KIND,
    priority: "extension",
    title: () => "ArchiView",
    guide: [{
      id: TAB_ID + "/guide",
      order: 40,
      title: () => "ArchiView",
      description: () => "Архитектура проекта и контракты модулей",
    }],
  }), "ui-archiview: тип вкладки");

  ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
    name: "sidebar.right.pane.tab",
    key: TAB_ID,
  }, Body)), "ui-archiview: тело вкладки");
}
