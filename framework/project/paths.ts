import path from "node:path";

export const STATE_DIRECTORY = ".archiview";

/** Metadata, dependencies and generated content are outside a source tree. */
const EXCLUDED = new Set([
  STATE_DIRECTORY,
  ".git", ".hg", ".svn", "node_modules", "target", "dist", "build", "coverage",
  ".venv", "venv", "__pycache__", ".next", ".nuxt", ".cache", "obj",
]);

export function excludedProjectPath(relative: string) {
  return relative.split(/[\\/]/).some(part => EXCLUDED.has(process.platform === "win32" ? part.toLowerCase() : part));
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
