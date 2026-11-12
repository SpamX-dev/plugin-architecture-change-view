import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { within } from "../project/paths.js";
import { readSnapshotRoot } from "../project/identity.js";
import { discoverWorkspaceRepositories, resolveWorkspaceRepository } from "../project/workspace.js";
import { createArchiViewSession } from "./session.js";
import { ApplicationError } from "./errors.js";
import type { SessionOperations } from "./api.js";

/** Route a panel request within its host-bound folder. The selected repository belongs to the request. */
export async function createWorkspaceSession({ root: folder, stateDirectory, sharedStateDirectory = false }: {
  root: string; stateDirectory?: string; sharedStateDirectory?: boolean;
}) {
  const root = await realpath(folder);
  const orderedRepositories = async () => {
    const discovered = await discoverWorkspaceRepositories(root);
    return discovered.includes(".") ? [".", ...discovered.filter((candidate) => candidate !== ".")] : discovered;
  };
  let repositories = await orderedRepositories();
  let hasRepositories = repositories.length > 0;
  const sessions = new Map<string, ReturnType<typeof createArchiViewSession>>();

  async function createSession(project: string, repository: string) {
    const configured = stateDirectory && path.resolve(project, stateDirectory);
    let directory = configured;
    if (configured && !within(project, configured) && (repository !== "." || sharedStateDirectory)) {
      // A pre-existing unpartitioned store keeps serving its original physical checkout.
      const origin = await readSnapshotRoot(project, configured);
      if (!origin || !path.isAbsolute(origin) || path.relative(project, origin) !== "") {
        directory = path.join(configured, "repositories", createHash("sha256").update(project).digest("hex"));
      }
    }
    return createArchiViewSession({ root: project, stateDirectory: directory });
  }

  async function open(repository: string) {
    if (!(hasRepositories ? repositories.includes(repository) : repository === ".")) {
      throw new ApplicationError("REPOSITORY_UNAVAILABLE", "Репозиторий не входит в выбранную рабочую папку");
    }
    // Revalidate the physical path even for a cached session: it can be moved or replaced.
    const project = repositories.length ? await resolveWorkspaceRepository(root, repository) : await realpath(root);
    if (path.relative(path.resolve(root, repository), project) !== "") throw new ApplicationError("NOT_FOUND", "Рабочая папка перемещена");
    let current = sessions.get(project);
    if (!current) {
      current = createSession(project, repository);
      sessions.set(project, current);
      current.catch(() => { if (sessions.get(project) === current) sessions.delete(project); });
    }
    return current;
  }

  // An unselected workspace can still open its healthy repositories when a sibling's history cannot be read.
  async function firstAvailable<T>(operation: (repository: string) => Promise<T>) {
    let firstError;
    for (const repository of repositories.length ? repositories : ["."]) {
      try { return await operation(repository); }
      catch (cause) { firstError ??= cause; }
    }
    throw firstError;
  }

  const session = (repository?: string) => repository === undefined ? firstAvailable(open) : open(repository);
  function selected(repository?: string) {
    if (repository === undefined && repositories.some((candidate) => candidate !== ".")) {
      throw new ApplicationError("INVALID_ARGUMENT", "Укажите репозиторий для операции с выбранным сравнением");
    }
    return open(repository ?? ".");
  }
  const operations: SessionOperations = {
    async getComparison(args = {}) {
      repositories = await orderedRepositories();
      hasRepositories ||= repositories.length > 0;
      async function compare(repository: string) {
        const view = await (await open(repository)).getComparison(args);
        return repositories.some((candidate) => candidate !== ".")
          ? { ...view, workspace: { root, repositories: [...repositories], repository } } : view;
      }
      if (args.repository !== undefined) return compare(args.repository);
      if ((args.target ?? "current") !== "current" || (args.baseline ?? "auto") !== "auto") return compare(repositories[0] ?? ".");
      return firstAvailable(compare);
    },
    async getModule(args) { return (await selected(args.repository)).getModule(args); },
    async prepareAnalysis(args) { return (await selected(args.repository)).prepareAnalysis(args); },
    async getAnalysis(args) { return (await selected(args.repository)).getAnalysis(args); },
    async buildReview(args) { return (await selected(args.repository)).buildReview(args); },
    async saveSnapshot(args) { return (await selected(args.repository)).saveSnapshot(args); },
  };
  return { ...operations, session, root, get showWorkspace() { return repositories.some((candidate) => candidate !== "."); } };
}
