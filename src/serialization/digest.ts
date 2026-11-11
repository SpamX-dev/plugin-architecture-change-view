import { createHash } from "node:crypto";

/** Канонический JSON сортирует ключи словарей, сохраняя порядок массивов. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map((v) => canonical(v ?? null)).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).filter((key) => (value as Record<string, unknown>)[key] !== undefined).sort()
    .map((key) => JSON.stringify(key) + ":" + canonical((value as Record<string, unknown>)[key])).join(",") + "}";
  return JSON.stringify(value ?? null);
}

/** Все внешние отпечатки используют одинаковые байты UTF-8 и префикс алгоритма. */
export function digest(value: unknown) {
  return "sha256:" + createHash("sha256").update(canonical(value)).digest("hex");
}
