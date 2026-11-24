import { byId } from "./dom.js";

/**
 * Управляет только шириной навигации: pointer capture удерживает перетаскивание
 * за пределами границы, клавиатура предоставляет те же действия. Предпочтение
 * сохраняется локально; узкий экран ограничивает размер, не стирая выбранную ширину.
 */
export function initializeTreeWidth() {
  const shell = byId("app-shell");
  const separator = byId("tree-resizer");
  const mobile = matchMedia("(max-width: 800px)");
  const storageKey = "archiview.tree-width";
  const defaultWidth = 420;
  const minimum = 260;
  const documentMinimum = 420;
  let preferred = defaultWidth;
  let drag: { pointerId: number; x: number; width: number; preferred: number } | null = null;
  try {
    const saved = localStorage.getItem(storageKey);
    const width = saved === null ? NaN : Number(saved);
    if (Number.isFinite(width) && width >= minimum) preferred = Math.min(800, width);
  } catch { /* Запрет браузерного хранилища не мешает регулировке в текущей вкладке. */ }

  /** Сохраняет место документу и отражает фактические пределы в доступном разделителе. */
  function applyWidth(value: number) {
    const maximum = Math.max(minimum, Math.min(800, shell.clientWidth - separator.offsetWidth - documentMinimum));
    const width = Math.round(Math.max(minimum, Math.min(maximum, value)));
    shell.style.setProperty("--tree-width", width + "px");
    separator.setAttribute("aria-valuemax", String(maximum));
    separator.setAttribute("aria-valuenow", String(width));
    separator.setAttribute("aria-valuetext", width + " пикселей");
    return width;
  }

  /** Записывает только явное предпочтение пользователя, не временное ограничение окна. */
  function rememberWidth() {
    try { localStorage.setItem(storageKey, String(preferred)); } catch {}
  }

  /** Снимает захват и визуальное состояние; отмена возвращает размер до жеста. */
  function finishDrag(commit = true) {
    if (!drag) return;
    const previous = drag;
    drag = null;
    if (!commit) { preferred = previous.preferred; applyWidth(preferred); }
    document.body.classList.remove("resizing-tree");
    if (separator.hasPointerCapture(previous.pointerId)) separator.releasePointerCapture(previous.pointerId);
    if (commit) rememberWidth();
  }

  separator.addEventListener("pointerdown", (event) => {
    if (mobile.matches || event.button !== 0 || !event.isPrimary || drag) return;
    drag = { pointerId: event.pointerId, x: event.clientX,
      width: byId("module-sidebar").getBoundingClientRect().width, preferred };
    separator.setPointerCapture(event.pointerId);
    separator.focus({ preventScroll: true });
    document.body.classList.add("resizing-tree");
    event.preventDefault();
  });
  separator.addEventListener("pointermove", (event) => {
    if (drag && event.pointerId === drag.pointerId) preferred = applyWidth(drag.width + event.clientX - drag.x);
  });
  separator.addEventListener("pointerup", (event) => {
    if (event.pointerId === drag?.pointerId) finishDrag();
  });
  separator.addEventListener("pointercancel", () => finishDrag(false));
  separator.addEventListener("lostpointercapture", () => finishDrag());
  separator.addEventListener("dblclick", () => {
    if (mobile.matches) return;
    preferred = applyWidth(defaultWidth); rememberWidth();
  });
  separator.addEventListener("keydown", (event) => {
    if (mobile.matches || event.altKey || event.ctrlKey || event.metaKey) return;
    if (event.key === "Escape" && drag) { event.preventDefault(); finishDrag(false); return; }
    if (drag) return;
    const width = Number(separator.getAttribute("aria-valuenow"));
    const step = event.shiftKey ? 48 : 16;
    const targets: Record<string, number> = { ArrowLeft: width - step, ArrowRight: width + step,
      Home: minimum, End: Number(separator.getAttribute("aria-valuemax")), Enter: defaultWidth };
    if (!Object.hasOwn(targets, event.key)) return;
    event.preventDefault();
    preferred = applyWidth(targets[event.key]); rememberWidth();
  });
  window.addEventListener("blur", () => finishDrag());
  window.addEventListener("resize", () => {
    finishDrag(false);
    if (!mobile.matches) applyWidth(preferred);
  });
  if (!mobile.matches) applyWidth(preferred);
}
