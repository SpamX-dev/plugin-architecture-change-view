/** Возвращает цепочку каталогов выбранного модуля от корня проекта. */
export function ancestors(directory: string) {
  if (directory === ".") return ["."];
  const parts = directory.split("/");
  return [".", ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))];
}
