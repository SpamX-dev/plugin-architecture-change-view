import type { HarnessOption } from "../../../module-operations/analysis-record.js";
import { errorMessage } from "../view-model/types.js";

interface MenuActions {
  list(): Promise<{ harnesses: HarnessOption[] }>;
  choose(id: string): void;
  copy(): void;
  current(): boolean;
  prefix?: string;
}
let closeOpen: (() => void) | undefined;

/** Capture the selection on opening. A late list response must never retarget an action. */
export function bindHarnessMenu(trigger: HTMLButtonElement, menu: HTMLElement, hosts: HTMLElement,
  copy: HTMLButtonElement, selection: () => MenuActions | undefined) {
  let active: MenuActions | undefined;
  let listeners: AbortController | undefined;
  function close() {
    listeners?.abort();
    active = undefined;
    if (closeOpen === close) closeOpen = undefined;
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  }
  function notice(message: string) {
    const row = document.createElement("p");
    row.textContent = message;
    hosts.replaceChildren(row);
  }
  function choose(context: MenuActions, id?: string) {
    if (active !== context || !trigger.isConnected || !context.current()) return close();
    close();
    trigger.focus();
    if (id === undefined) context.copy();
    else context.choose(id);
  }
  trigger.onclick = async () => {
    if (active) return close();
    const context = selection();
    if (!context) return;
    closeOpen?.();
    active = context;
    closeOpen = close;
    listeners = new AbortController();
    document.addEventListener("pointerdown", event => {
      if (event.target instanceof Node && !trigger.parentElement?.contains(event.target)) close();
    }, { signal: listeners.signal });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape") { close(); trigger.focus(); }
    }, { signal: listeners.signal });
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    notice("Ищем доступные harness…");
    copy.onclick = () => choose(context);
    try {
      const { harnesses } = await context.list();
      if (active !== context) return;
      if (!trigger.isConnected || !context.current()) return close();
      if (!harnesses.length) return notice("Нет подключённых harness");
      hosts.replaceChildren(...harnesses.map(host => {
        const item = document.createElement("button");
        item.type = "button";
        const label = harnesses.filter(option => option.name === host.name).length > 1 ?
          host.name + " · " + host.id.slice(-6) : host.name;
        item.textContent = (context.prefix ?? "") + label + (host.reason ? " · " + host.reason : "");
        item.disabled = !!host.reason;
        item.onclick = () => choose(context, host.id);
        return item;
      }));
    } catch (error) { if (active === context) notice("Не удалось получить список: " + errorMessage(error)); }
  };
  return () => { if (active && (trigger.disabled || !active.current())) close(); };
}
