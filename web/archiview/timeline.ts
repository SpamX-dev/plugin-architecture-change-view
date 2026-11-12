import type { TimelineEntry, ComparisonView } from "./types.js";
import { byId, el } from "./dom.js";

/** Хронология различает изменения, снятые в пределах одной минуты. */
export function timelineDate(value: string | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  return new Intl.DateTimeFormat("ru-RU", { year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(value));
}

/** Подписи отражают пользовательские состояния без внутренних имён снимков. */
export function timelineLabel(entry: TimelineEntry) {
  if (entry.id === "current" || entry.kind === "current") return "Текущее состояние";
  if (entry.kind === "git") return entry.isHead ? "HEAD" : "Revision " + (entry.revision ?? entry.id.replace(/^git-/, "")).slice(0, 8);
  if (entry.kind === "change") return "Изменение " + timelineDate(entry.capturedAt);
  return entry.label ?? entry.id;
}

/**
 * Один список выбирает просматриваемое состояние. Текущее и самые свежие
 * изменения идут первыми; базу сравнения определяет сервер. Сохранённые вручную
 * снимки доступны здесь же, а подгрузка старых коммитов не меняет выбор.
 */
export function renderTimeline(view: ComparisonView, target: string) {
  const picker = byId("timeline");
  picker.replaceChildren();
  const entries = view.timeline ?? [{ id: "current", kind: "current", label: "Текущее состояние" }];
  const saved = (view.baselines ?? []).filter(entry => entry.kind === "saved" && !entries.some(item => item.id === entry.id))
    .sort((a, b) => (b.capturedAt ?? "").localeCompare(a.capturedAt ?? ""));
  const options = [...entries].reverse().concat(saved);
  // После нового коммита прежняя локальная точка исчезает из активной истории,
  // но её открытый просмотр должен сохранять видимое выбранное значение.
  if (view.target && !options.some(entry => entry.id === target)) options.push(view.target);
  for (const entry of options) {
    const label = view.published && entry.id === "current" ? "Сохранённое состояние" : timelineLabel(entry);
    const option = el("option", "", label);
    option.value = entry.id;
    option.selected = entry.id === target;
    option.title = [label, entry.kind === "current" ? "Сжатый результат" : entry.subject, entry.revision].filter(Boolean).join("\n");
    picker.append(option);
  }
  if (view.historyHasMore) {
    const more = el("option", "", "Загрузить ранние коммиты…");
    more.value = "load-earlier";
    picker.append(more);
  }
  picker.title = picker.selectedOptions[0]?.title ?? "Хронология";
}
