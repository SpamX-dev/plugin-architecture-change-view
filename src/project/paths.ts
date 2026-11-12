import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { errorDetails } from "../runtime/errors.js";

/** Зарезервированное хранилище данных, исключаемое из анализа исходников. */
export const STATE_DIRECTORY = ".archiview";

/** Source enumeration and repository discovery skip dependencies, metadata and generated files. */
const EXCLUDED = new Set([
  STATE_DIRECTORY,
  ".git", ".hg", ".svn", "node_modules", "target", "dist", "build", "coverage",
  ".venv", "venv", "__pycache__", ".next", ".nuxt", ".cache", "obj",
]);
export function excludedProjectPath(relative: string) {
  return relative.split(/[\\/]/).some((part) => EXCLUDED.has(process.platform === "win32" ? part.toLowerCase() : part));
}

/** Выбирает папку данных относительно проекта; абсолютный внешний путь сохраняется. */
export function projectStateDirectory(root: string, directory = STATE_DIRECTORY) {
  const target = path.resolve(root, directory);
  if (within(root, target) && !within(path.join(root, STATE_DIRECTORY), target)) {
    throw new Error("State storage must be under .archiview or outside source project");
  }
  return target;
}

/** Проверяет вложенность разрешённых абсолютных путей, включая сам каталог. */
export function within(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
}

/** Resolves existing components before checking the location of a pending write. */
async function physicalPath(target: string): Promise<string> {
  let ancestor = target;
  while (true) {
    try {
      await lstat(ancestor);
      break;
    } catch (cause) {
      const parent = path.dirname(ancestor);
      if (errorDetails(cause).code !== "ENOENT" || parent === ancestor) throw cause;
      ancestor = parent;
    }
  }
  // A dangling link exists according to lstat; its realpath error must reach the caller.
  return path.resolve(await realpath(ancestor), path.relative(ancestor, target));
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
  const destination = await physicalPath(target);
  if (local) {
    if (path.relative(target, destination) !== "") throw new Error("Local state storage cannot use directory links");
    return;
  }
  const boundary = target === directory ? destination : await physicalPath(directory);
  const project = await realpath(root);
  if (within(project, boundary) || within(project, destination)) throw new Error("External state storage resolves inside source project");
  if (!within(boundary, destination)) throw new Error("Path resolves outside external state storage");
}
