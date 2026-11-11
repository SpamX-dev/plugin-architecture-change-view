import { realpath } from "node:fs/promises";
import path from "node:path";
import { errorDetails } from "../runtime/errors.js";

/** Зарезервированное хранилище данных, исключаемое из анализа исходников. */
export const STATE_DIRECTORY = ".archiview";

/** Выбирает папку данных относительно проекта; абсолютный внешний путь сохраняется. */
export function projectStateDirectory(root: string, directory = STATE_DIRECTORY) {
  const target = path.resolve(root, directory);
  if (within(root, target) && !within(path.join(root, STATE_DIRECTORY), target)) {
    throw new Error("State storage must be under .archiview or outside source project");
  }
  return target;
}

/** Проверяет вложенность разрешённых абсолютных путей, включая сам каталог. */
function within(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
}

/**
 * Разрешает данные только в зарезервированной папке проекта либо во внешнем
 * хранилище. Ссылки не могут перенаправить локальные данные в исходники или наружу.
 */
export async function assertStateLocation(root: string, directory: string, target = directory) {
  const local = within(root, directory);
  if (local && !within(path.join(root, STATE_DIRECTORY), directory)) {
    throw new Error("State storage inside source project must be under .archiview");
  }
  if (!within(directory, target)) throw new Error("Path escapes state storage");
  let ancestor = target;
  while (true) {
    try {
      const resolved = await realpath(ancestor);
      const destination = path.resolve(resolved, path.relative(ancestor, target));
      if (local && path.relative(target, destination) !== "") throw new Error("Local state storage cannot use directory links");
      if (!local && within(root, destination)) throw new Error("External state storage resolves inside source project");
      return;
    } catch (errorCause) { const error = errorDetails(errorCause);
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}
