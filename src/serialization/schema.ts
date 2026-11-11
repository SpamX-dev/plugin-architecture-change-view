/** Минимальный словарь валидаторов: каждая ошибка содержит точный путь поля. */
export const fail = (at: string, message: string): never => { throw new Error(at + ": " + message); };
export type Validator = (v: unknown, at: string) => void;
export const string: Validator = (v, at) => typeof v === "string" && v.trim() ? undefined : fail(at, "ожидается непустая строка");
export const object: Validator = (v, at) => v && typeof v === "object" && !Array.isArray(v) ? undefined : fail(at, "ожидается словарь");
export const enumeration = (...values: unknown[]): Validator => (v, at) => values.includes(v) ? undefined : fail(at, "допустимо: " + values.join(", "));
export const nullable = (check: Validator): Validator => (v, at) => v === null ? undefined : check(v, at);
export const array = (check: Validator, min = 0): Validator => (v, at) => {
  if (!Array.isArray(v) || v.length < min) fail(at, "ожидается массив, минимум " + min);
  (v as unknown[]).forEach((item, i) => check(item, at + "[" + i + "]"));
};
export const shape = (required: Record<string, Validator>, optional: Record<string, Validator> = {}): Validator => (v, at) => {
  object(v, at);
  for (const [key, check] of Object.entries(required)) check((v as Record<string, unknown>)[key], at + "." + key);
  for (const key of Object.keys(v as object)) {
    if (Object.hasOwn(required, key)) continue;
    if (!Object.hasOwn(optional, key)) fail(at + "." + key, "неизвестное поле");
    optional[key]((v as Record<string, unknown>)[key], at + "." + key);
  }
};
export const strings = array(string);
export const references = array(shape({ title: string, uri: string }));
export const extensions: Validator = (v, at) => {
  object(v, at);
  for (const key of Object.keys(v as object)) if (!/^[^.\s]+\.[^\s]+$/.test(key)) fail(at, "расширению нужно пространство имён");
};
