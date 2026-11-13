import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { within } from "../project/paths.js";
import { readSnapshotRoot } from "../project/identity.js";
import { discoverWorkspaceRepositories, resolveWorkspaceRepository } from "../project/workspace.js";
import { createArchiViewSession } from "./session.js";
import { createPublishedView } from "./published-view.js";
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
  if (!repositories.length) throw new ApplicationError("REPOSITORY_UNAVAILABLE", "Для ArchiView требуется рабочее дерево Git");
  const sessions = new Map<string, ReturnType<typeof createArchiViewSession>>();
  const publishedViews = new Map<string, NonNullable<Awaited<ReturnType<typeof createPublishedView>>>>();

  async function sessionOptions(project: string, repository: string) {
    const configured = stateDirectory && path.resolve(project, stateDirectory);
    let directory = configured;
    if (configured && !within(project, configured) && (repository !== "." || sharedStateDirectory)) {
      // A pre-existing unpartitioned store keeps serving its original physical checkout.
      const origin = await readSnapshotRoot(project, configured);
      if (!origin || !path.isAbsolute(origin) || path.relative(project, origin) !== "") {
        directory = path.join(configured, "repositories", createHash("sha256").update(project).digest("hex"));
      }
    }
    return { root: project, stateDirectory: directory };
  }

  async function projectPath(repository: string) {
    if (!repositories.includes(repository)) {
      throw new ApplicationError("REPOSITORY_UNAVAILABLE", "Репозиторий не входит в выбранную рабочую папку");
    }
    // Revalidate the physical path even for a cached session: it can be moved or replaced.
    const project = await resolveWorkspaceRepository(root, repository);
    if (path.relative(path.resolve(root, repository), project) !== "") throw new ApplicationError("NOT_FOUND", "Рабочая папка перемещена");
    return project;
  }

  function liveSession(project: string, repository: string, deferPublication: boolean) {
    let current = sessions.get(project);
    if (!current) {
      current = sessionOptions(project, repository).then(options => createArchiViewSession({ ...options, deferPublication }));
      sessions.set(project, current);
      current.catch(() => { if (sessions.get(project) === current) sessions.delete(project); });
    }
    return current;
  }

  async function open(repository: string, deferPublication = true) {
    return liveSession(await projectPath(repository), repository, deferPublication);
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

  const session = (repository?: string, deferPublication = true) => repository === undefined
    ? firstAvailable(id => open(id, deferPublication)) : open(repository, deferPublication);
  function selection(repository?: string) {
    if (repository === undefined && repositories.some((candidate) => candidate !== ".")) {
      throw new ApplicationError("INVALID_ARGUMENT", "Укажите репозиторий для операции с выбранным сравнением");
    }
    return repository ?? ".";
  }

  // An immutable view can only be used in the checkout which served it.
  // A stale panel request must not start a publisher in another checkout.
  async function viewSession(repository: string | undefined, view: string) {
    const project = await projectPath(selection(repository));
    const session = sessions.get(project);
    if (view.startsWith("published-") || !session) throw new ApplicationError("STALE_VIEW", "Обновите сравнение");
    return session;
  }
  const operations: SessionOperations = {
    async getComparison(args = {}) {
      if (!repositories.includes(".") || (args.repository !== undefined && !repositories.includes(args.repository))) {
        repositories = await orderedRepositories();
      }
      if (!repositories.length) throw new ApplicationError("REPOSITORY_UNAVAILABLE", "В рабочей папке нет репозиториев Git");
      async function compare(repository: string) {
        const project = await projectPath(repository);
        let published;
        if (args.published && (args.target ?? "current") === "current" && (args.baseline ?? "auto") === "auto") {
          published = await createPublishedView(await sessionOptions(project, repository));
          if (published) {
            publishedViews.delete(published.comparison.id);
            publishedViews.set(published.comparison.id, published);
            while (publishedViews.size > 8) publishedViews.delete(publishedViews.keys().next().value!);
          }
        }
        const view = published?.comparison ?? await (await liveSession(project, repository, true)).getComparison(args);
        return repositories.some((candidate) => candidate !== ".")
          ? { ...view, workspace: { root, repositories: [...repositories], repository } } : view;
      }
      if (args.repository !== undefined) return compare(args.repository);
      if ((args.target ?? "current") !== "current" || (args.baseline ?? "auto") !== "auto") return compare(repositories[0] ?? ".");
      return firstAvailable(compare);
    },
    async waitForChanges(args, signal) {
      return (await open(selection(args.repository))).waitForChanges(args, signal);
    },
    async getReviewStatuses(args) { return (await viewSession(args.repository, args.view)).getReviewStatuses(args); },
    async getModule(args) {
      if (args.view.startsWith("published-")) {
        const project = await projectPath(selection(args.repository));
        const published = publishedViews.get(args.view);
        if (published?.comparison.root !== project) throw new ApplicationError("STALE_VIEW", "Обновите сравнение");
        return published.getModule(args);
      }
      return (await viewSession(args.repository, args.view)).getModule(args);
    },
    async prepareAnalysis(args) { return (await viewSession(args.repository, args.view)).prepareAnalysis(args); },
    async getAnalysis(args) { return (await open(selection(args.repository))).getAnalysis(args); },
    async buildReview(args) { return (await viewSession(args.repository, args.view)).buildReview(args); },
    async saveSnapshot(args) { return (await viewSession(args.repository, args.view)).saveSnapshot(args); },
  };
  async function close() {
    await Promise.allSettled([...sessions.values()].map(async promise => (await promise).close()));
  }
  return { ...operations, session, root, close, get showWorkspace() { return repositories.some((candidate) => candidate !== "."); } };
}
