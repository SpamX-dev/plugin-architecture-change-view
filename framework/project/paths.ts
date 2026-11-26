import path from "node:path";
import { STATE_DIRECTORY } from "./storage-paths.js";

export { STATE_DIRECTORY };

const metadata = new Set([STATE_DIRECTORY, ".git", ".hg", ".svn"]);
const excludedSources = new Set([
  ...metadata, "node_modules", "target", "dist", "build", "coverage",
  ".venv", "venv", "__pycache__", ".next", ".nuxt", ".cache", "obj",
]);

function hasDirectory(relative: string, names: Set<string>) {
  return relative.split(/[\\/]/).some(part => names.has(process.platform === "win32" ? part.toLowerCase() : part));
}

/** Git comparisons retain ordinary files under source-inventory exclusions such as build/. */
export function isProjectMetadataPath(relative: string) {
  return hasDirectory(relative, metadata);
}

export function excludedProjectPath(relative: string) {
  return hasDirectory(relative, excludedSources);
}

export function within(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(".." + path.sep));
}

/** A repository stores its data under .archiview or in an external directory. */
export function projectStateDirectory(root: string, directory = STATE_DIRECTORY) {
  const target = path.resolve(root, directory);
  if (within(root, target) && !within(path.join(root, STATE_DIRECTORY), target)) {
    throw new Error("State storage must be under .archiview or outside source project");
  }
  return target;
}
