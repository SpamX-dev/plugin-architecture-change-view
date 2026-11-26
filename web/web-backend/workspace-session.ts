import { realpath } from "node:fs/promises";
import path from "node:path";
import { repositoryStateDirectory } from "./state-directory.js";
import { discoverWorkspaceRepositories, resolveWorkspaceRepository } from "../../analyse/project/workspace.js";
import { createArchiViewSession } from "./session.js";
import { createPublishedView } from "../../module-operations/published-view.js";
import { ApplicationError } from "../../module-operations/errors.js";
import type { SessionOperations } from "../../module-operations/api.js";
import { listModules, type ModuleSelection } from "../../module-operations/module-access.js";

/** The workspace overview composes one repository-scoped query per checkout. */
export async function listWorkspaceModules(workspace: string, selection: ModuleSelection = {}) {
  if (selection.repository !== undefined) return listModules(workspace, selection);
  const repositories = await discoverWorkspaceRepositories(workspace);
  if (!repositories.length) throw new ApplicationError("REPOSITORY_UNAVAILABLE", "В выбранной папке нет репозитория Git");
  const projects = [];
  for (const repository of repositories) {
    const result = await listModules(workspace, { ...selection, repository });
    projects.push(...result.projects);
  }
  return { projects };
}

/** Route a panel request within its host-bound folder. The selected repository belongs to the request. */
export async function createWorkspaceSession({ root: folder, stateDirectory, sharedStateDirectory = false, initialRepository }: {
  root: string; stateDirectory?: string; sharedStateDirectory?: boolean; initialRepository?: string;
}) {
  const root = await realpath(folder);
  const orderedRepositories = async () => {
    const discovered = await discoverWorkspaceRepositories(root);
    return discovered.includes(".") ? [".", ...discovered.filter((candidate) => candidate !== ".")] : discovered;
  };
  let repositories = await orderedRepositories();
  if (!repositories.length) throw new ApplicationError("REPOSITORY_UNAVAILABLE", "Для ArchiView требуется рабочее дерево Git");
  if (initialRepository !== undefined && !repositories.includes(initialRepository))
    throw new ApplicationError("REPOSITORY_UNAVAILABLE", "Репозиторий не входит в выбранную рабочую папку");
  const sessions = new Map<string, ReturnType<typeof createArchiViewSession>>();
  const publishedViews = new Map<string, NonNullable<Awaited<ReturnType<typeof createPublishedView>>>>();

  function sessionOptions(project: string, repository: string) {
    return { root: project, stateDirectory, sharedStateDirectory: repository !== "." || sharedStateDirectory };
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
      current = createArchiViewSession({ ...sessionOptions(project, repository), workspaceRoot: root, deferPublication });
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

  const session = (repository = initialRepository, deferPublication = true) => repository === undefined
    ? firstAvailable(id => open(id, deferPublication)) : open(repository, deferPublication);
  function selection(repository = initialRepository) {
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
  async function readableView(args: { repository?: string; view: string }) {
    if (!args.view.startsWith("published-")) return viewSession(args.repository, args.view);
    const project = await projectPath(selection(args.repository));
    const published = publishedViews.get(args.view);
    if (published?.comparison.root !== project) throw new ApplicationError("STALE_VIEW", "Обновите сравнение");
    return published;
  }
  const operations: SessionOperations = {
    async getReviewSettings(args) { return (await open(selection(args.repository))).getReviewSettings(args); },
    async setReviewSetting(args) { return (await open(selection(args.repository))).setReviewSetting(args); },
    async getComparison(args = {}) {
      const selected = args.repository ?? initialRepository;
      if (!repositories.includes(".") || (selected !== undefined && !repositories.includes(selected))) {
        repositories = await orderedRepositories();
      }
      if (!repositories.length) throw new ApplicationError("REPOSITORY_UNAVAILABLE", "В рабочей папке нет репозиториев Git");
      async function compare(repository: string) {
        const project = await projectPath(repository);
        let published;
        if (args.published && (args.target ?? "current") === "current" && (args.baseline ?? "auto") === "auto") {
          const options = sessionOptions(project, repository);
          const directory = await repositoryStateDirectory(project, stateDirectory, options.sharedStateDirectory);
          published = await createPublishedView({ root: project, stateDirectory: directory });
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
      if (selected !== undefined) return compare(selected);
      if ((args.target ?? "current") !== "current" || (args.baseline ?? "auto") !== "auto") return compare(repositories[0] ?? ".");
      return firstAvailable(compare);
    },
    async waitForChanges(args, signal) {
      return (await open(selection(args.repository))).waitForChanges(args, signal);
    },
    async updateFinding(args) { return (await viewSession(args.repository, args.view)).updateFinding(args); },
    async getReviewStatuses(args) { return (await viewSession(args.repository, args.view)).getReviewStatuses(args); },
    async getModule(args) { return (await readableView(args)).getModule(args); },
    async getRelations(args) { return (await readableView(args)).getRelations(args); },
    async getDependencyCycles(args) { return (await readableView(args)).getDependencyCycles(args); },
    async getRelationSource(args) { return (await readableView(args)).getRelationSource(args); },
    async buildRelations(args) { return (await viewSession(args.repository, args.view)).buildRelations(args); },
    async changeClause(args) { return (await viewSession(args.repository, args.view)).changeClause(args); },
    async changePrototype(args) { return (await viewSession(args.repository, args.view)).changePrototype(args); },
    async getFileDiff(args) { return (await readableView(args)).getFileDiff(args); },
    async listHarnesses(args) { return (await open(selection(args.repository))).listHarnesses(args); },
    async deliverFindingFix(args) { return (await open(selection(args.repository))).deliverFindingFix(args); },
    async deliverAnalysis(args) { return (await open(selection(args.repository))).deliverAnalysis(args); },
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
