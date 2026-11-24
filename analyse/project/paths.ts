import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { errorDetails } from "../../node-errors.js";

import { STATE_DIRECTORY, within } from "../../framework/project/paths.js";

export { excludedProjectPath, projectStateDirectory, STATE_DIRECTORY, within } from "../../framework/project/paths.js";

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
