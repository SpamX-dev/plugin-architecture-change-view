import { execFile } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { errorDetails } from "../runtime/errors.js";
import { excludedProjectPath, within } from "./paths.js";

const git = promisify(execFile);
const relativePath = (root: string, directory: string) => path.relative(root, directory).split(path.sep).join("/") || ".";
const internalDirectory = (name: string) => [".codex", ".agents"].includes(process.platform === "win32" ? name.toLowerCase() : name);

async function entry(candidate: string) {
  try { return await lstat(candidate); }
  catch (cause) { if (errorDetails(cause).code !== "ENOENT") throw cause; }
}

/** A linked worktree or initialized submodule has a regular .git file instead of a directory. */
async function isRepositoryRoot(directory: string) {
  const marker = await entry(path.join(directory, ".git"));
  if (!marker || marker.isSymbolicLink() || !marker.isDirectory() && !marker.isFile()) return false;
  const top = await gitTopLevel(directory);
  return top !== null && path.relative(top, directory) === "";
}

async function gitTopLevel(directory: string) {
  try {
    const { stdout } = await git("git", ["rev-parse", "--show-toplevel"], {
      cwd: directory, windowsHide: true, timeout: 15000,
    });
    return await realpath(stdout.trim());
  } catch (cause) {
    const error = errorDetails(cause);
    if (error.code === "ENOENT") throw new Error("Для ArchiView требуется установленный Git");
    if (/not a git repository|invalid gitfile format/i.test(String(error.stderr))) return null;
    throw cause;
  }
}

/** Find checked-out repositories, including nested checkouts, without following directory links. */
export async function discoverWorkspaceRepositories(workspace: string): Promise<string[]> {
  const root = await realpath(workspace);
  const pending = [root];
  const repositories: string[] = [];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true }).catch((cause: unknown) => {
      const { code } = errorDetails(cause);
      if (directory !== root && (code === "ENOENT" || code === "ENOTDIR")) return [];
      throw cause;
    });
    for (const child of entries) {
      if (child.name === ".git" && !child.isSymbolicLink() && await isRepositoryRoot(directory)) {
        repositories.push(relativePath(root, directory));
      } else if (child.isDirectory() && !child.isSymbolicLink() && !excludedProjectPath(child.name) && !internalDirectory(child.name)) {
        pending.push(path.join(directory, child.name));
      }
    }
  }
  // A selected subtree of an enclosing checkout can also contain its own nested checkouts.
  if (!repositories.includes(".") && await gitTopLevel(root)) repositories.push(".");
  return repositories.sort();
}

function checkedTarget(root: string, relative: string) {
  if (path.isAbsolute(relative) || path.win32.isAbsolute(relative) || /^[a-z]:/i.test(relative))
    throw new Error("source path must be relative");
  const target = path.resolve(root, relative);
  if (!within(root, target)) throw new Error("source path is outside project");
  if (excludedProjectPath(path.relative(root, target))) throw new Error("path is excluded from project sources");
  return target;
}

/** Revalidate a panel selection before passing its canonical directory to any repository session. */
export async function resolveWorkspaceRepository(workspace: string, repository: string): Promise<string> {
  const root = await realpath(workspace);
  const target = checkedTarget(root, repository);
  if (relativePath(root, target) !== repository || repository.split("/").some(internalDirectory))
    throw new Error("Invalid repository path: " + repository);
  const physical = await realpath(target);
  if (!within(root, physical) || relativePath(root, physical) !== repository ||
      !(repository === "." ? await gitTopLevel(root) : await isRepositoryRoot(physical))) {
    throw new Error("Not a repository in the selected workspace: " + repository);
  }
  return physical;
}

/** Check only the ancestors of paths actually listed by Git or the contract map. */
export function repositoryDirectoryOwnership(root: string) {
  const states = new Map<string, Promise<boolean>>([[".", Promise.resolve(true)]]);
  function owns(directory: string): Promise<boolean> {
    const cached = states.get(directory);
    if (cached) return cached;
    const result = owns(path.posix.dirname(directory)).then(async (parentOwned) => {
      if (!parentOwned) return false;
      const candidate = checkedTarget(root, directory);
      const info = await entry(candidate);
      if (!info) return true; // Its parent owns any planned path or deleted tracked file.
      if (info.isSymbolicLink() || !info.isDirectory()) return false;
      return !await isRepositoryRoot(candidate);
    });
    states.set(directory, result);
    return result;
  }
  return owns;
}

/** A new file uses its nearest existing ancestor. The chat's selected root is the upper bound. */
export async function locateSourceRepository(workspace: string, relative: string) {
  const workspaceRoot = await realpath(workspace);
  const target = checkedTarget(workspaceRoot, relative);
  let existing = target;
  let info = await entry(existing);
  while (!info) {
    existing = path.dirname(existing);
    info = await entry(existing);
  }
  const physical = await realpath(existing);
  if (!within(workspaceRoot, physical)) throw new Error("source path resolves outside project");
  if (excludedProjectPath(path.relative(workspaceRoot, physical))) throw new Error("path is excluded from project sources");
  if (path.relative(physical, existing) !== "") throw new Error("source path uses a link");
  if (info.isSymbolicLink() || !info.isFile() && !info.isDirectory()) throw new Error("Expected a source file or directory");
  const existingDirectory = info.isDirectory() ? physical : path.dirname(physical);
  const requested = path.join(physical, path.relative(existing, target));
  const targetDirectory = (existing === target ? info.isDirectory() : /[\\/]$/.test(relative))
    ? requested : path.dirname(requested);
  let root = existingDirectory;
  while (!await isRepositoryRoot(root)) {
    if (root === workspaceRoot) {
      const repositories = await discoverWorkspaceRepositories(workspaceRoot);
      if (repositories.length && !repositories.includes(".")) {
        throw new Error("Source path is outside the workspace repositories. Choose a repository: " + repositories.join(", "));
      }
      if (!repositories.includes(".")) throw new Error("Для ArchiView требуется рабочее дерево Git");
      break;
    }
    root = path.dirname(root);
  }
  return { workspaceRoot, root, repository: relativePath(workspaceRoot, root),
    directory: relativePath(root, targetDirectory), existingDirectory: relativePath(root, existingDirectory) };
}
