import type { ComparisonView, ModuleDetail, SessionOperations, FindingFixArgs, ComparisonArgs, FileDiffArgs, ModuleArgs, SnapshotArgs } from "../../module-operations/api.js";
import { fileDiff } from "../../module-operations/file-diff.js";
import * as relations from "../../module-operations/relations.js";
import type { Comparison, Snapshot, GitRevision } from "../../framework/snapshots/types.js";
import type { PublishedComparison } from "../../framework/static-report/types.js";
import type { SessionView } from "../../module-operations/session-view.js";
import { errorDetails } from "../../node-errors.js";
/** Прикладная сессия проекта: снимки и операции просмотра без зависимости от транспорта. */
import { followsAnalysis } from "../../analyse/module-review/analysis-timeline.js";
import { DecisionConflict, FindingDecisions } from "../../analyse/module-review/dispositions.js";
import { currentAnalysisEntries, analysisSummary } from "../../module-operations/module-view.js";
import { observeModules } from "../../analyse/module-review/module-observations.js";
import { RepositoryWatch } from "./repository-watch.js";
import { repositoryStateDirectory } from "./state-directory.js";
import { GitTreeReader } from "../../analyse/git-changes/git-tree.js";
import { projectReviewSettings } from "./project-review-settings.js";
import { realpath } from "node:fs/promises";
import { ApplicationError } from "../../module-operations/errors.js";
import { captureGitHead, captureWorkingTree, listGitRevisions, readGitHeadRevision } from "../../analyse/git-changes/capture.js";
import { compareGitFiles, compareRepositorySnapshots } from "../../analyse/git-changes/comparison.js";
import { snapshotDigest } from "../../framework/snapshots/identity.js";
import { openProjectHistory } from "../../analyse/module-review/legacy-history.js";
import { ReviewStore } from "../../analyse/module-review/review-store.js";
import { ReportStore, StalePublicationError } from "../../analyse/module-review/report-store.js";
import { createReportModel } from "../../analyse/module-review/model.js";
import { ChangeHistory } from "../../analyse/git-changes/change-history.js";
import { digest } from "../../framework/serialization/digest.js";
import { AnalysisRequests } from "./analysis-service/analysis.js";
import { AgentTurns } from "./analysis-service/turns.js";
import { metadata, moduleDetail, moduleSummary, reviewSummary } from "../../module-operations/module-view.js";
import { createContractEditor } from "../../module-operations/contract-editor.js";
import { changeExistingPrototype, createPrototypes } from "../../module-operations/prototypes.js";

/** Открывает хранилища одного проекта; вызывается лениво при первом запросе данных. */
export async function createArchiViewSession({ root: requestedRoot, stateDirectory, sharedStateDirectory, workspaceRoot, deferPublication = true }: { root: string; stateDirectory?: string; sharedStateDirectory?: boolean; workspaceRoot?: string; deferPublication?: boolean }) {
  const root = await realpath(requestedRoot);
  const { store, migration } = await openProjectHistory(root, await repositoryStateDirectory(root, stateDirectory, sharedStateDirectory));
  const reviews = new ReviewStore(store);
  const reports = new ReportStore(store);
  const changes = new ChangeHistory(store);
  const decisions = new FindingDecisions(root, store.directory);
  const analysis = new AnalysisRequests(store, reports, workspaceRoot ?? root);
  const settings = projectReviewSettings(root, store.directory);
  const reader = new GitTreeReader(root, store.snapshotRoot);
  const watcher = new RepositoryWatch(root, store.directory);
  const editor = createContractEditor(root);
  const captureOptions = { snapshotRoot: store.snapshotRoot };
  const gitSnapshots = new Map<string, Snapshot | null>();
  function launchSnapshot(working: Snapshot): Snapshot {
    return { ...working, id: "launch-" + working.fingerprint, kind: "launch", label: "Начальное состояние" };
  }
  let launch: Snapshot | undefined;
  let gitHead: Snapshot | null = null;
  let initialBaseline: Snapshot | null = null;
  let startupComparison: Comparison | undefined;
  let publishedSnapshots: Snapshot[] = [];
  if (!deferPublication) await reports.withLivePublication(async () => {
    const startup = await captureLiveState();
    launch = launchSnapshot(startup.working);
    gitHead = startup.head;
    const observed = await liveTree(gitHead?.revision ?? null);
    if (launch.complete && observed.complete) attachVersions(launch, observed);
    // Открытие проекта публикует структуру даже до первого запроса браузера.
    // База выбирается тем же правилом, что и первое сравнение, и не продвигается.
    const published = await reports.publishedComparison();
    initialBaseline = gitHead;
    // Уже прочитанные опубликованные снимки остаются доступными по точному id.
    // Перечень сохранённых баз не должен заново читать всю историю отчётов.
    publishedSnapshots = published ? [published.baseline, published.current].filter((snapshot): snapshot is Snapshot => snapshot !== null) : [];
    const options = { emptyTree: !initialBaseline };
    const startupView = await compareRepositorySnapshots(root, initialBaseline, launch, options);
    if (startupView.complete) {
      const publication = await reports.rebuild(initialBaseline, launch, startupView.modules);
      startupComparison = await compareGitFiles(root, initialBaseline, launch, options);
      publishedSnapshots = publication.comparison ? [publication.comparison.baseline, publication.comparison.current].filter((snapshot): snapshot is Snapshot => snapshot !== null) : [];
    }
  });
  const views = new Map<string, SessionView>();
  /** Исторические коммиты читаются по выбору; список не загружает исходники всей истории. */
  async function gitSnapshot(revision: string, headRevision: string | null) {
    if (!gitSnapshots.has(revision)) gitSnapshots.set(revision,
      await captureGitHead(root, { ...captureOptions, revision }));
    const snapshot = gitSnapshots.get(revision);
    return snapshot ? { ...snapshot, label: revision === headRevision ? "HEAD" : "Revision " + revision.slice(0, 7), isHead: revision === headRevision } : null;
  }

  /** Размер страницы ограничен, но ранние коммиты доступны последующими страницами. */
  async function revisionHistory(limit: number) {
    let revisions: GitRevision[] = [], before: string | null | undefined, page;
    do {
      page = await listGitRevisions(root, { limit: Math.min(500, limit - revisions.length), ...(before ? { before } : {}) });
      revisions = [...page.revisions, ...revisions];
      before = page.nextBefore;
    } while (page.hasMore && before && revisions.length < limit);
    return { revisions, hasMore: page.hasMore };
  }

  /**
   * Проверяет привязку рабочего снимка одним чтением HEAD, без повторного анализа
   * всех исходников коммита. Редкая смена HEAD повторяет пару ограниченное число раз.
   */
  async function captureLiveState(historyLimit: number | null = null) {
    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      let history;
      try { history = historyLimit === null ? null : await revisionHistory(historyLimit); }
      catch (errorCause) { const error = errorDetails(errorCause);
        if (error.message.includes("outside the current first-parent history")) {
          if (attempt < 2) continue;
          if (result) break;
        }
        throw error;
      }
      const headRevision = history ? history.revisions.at(-1)?.revision ?? null : await readGitHeadRevision(root);
      const head = headRevision ? await gitSnapshot(headRevision, headRevision) : null;
      const working = await captureWorkingTree(root, captureOptions);
      result = { history, head, working };
      if (await readGitHeadRevision(root) === headRevision) return result;
    }
    if (!result) throw new Error("Не удалось получить рабочее состояние");
    const working = { ...result.working, complete: false,
      diagnostics: [...result.working.diagnostics, "HEAD изменялся во время построения снимка; обновите сравнение."] };
    working.digest = snapshotDigest(working);
    working.id = "working-" + working.digest.slice(7);
    return { ...result, working };
  }

  /** Формирует сравнение и хронологию, сохраняя исходную семантику публикации текущего состояния. */
  function getComparison(args: ComparisonArgs = {}): Promise<ComparisonView> {
    const target = args.target ?? "current";
    if ((!args.baseline || args.baseline === "auto") && (target === "current" || /^git-(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(target))) {
      return reports.withLivePublication(async () => {
        let watchCursor: string | undefined, watchError: string | undefined;
        if (args.watch && target === "current") {
          // Subscribe before reading Git so a save during the initial capture remains observable.
          try { watchCursor = await watcher.current(); }
          catch (error) { watchError = errorDetails(error).message; }
        }
        const view = await loadGitTree(target, args.historyLimit ?? 50);
        return { ...view, watchCursor, watchError };
      });
    }
    return reports.withLivePublication(() => loadComparison(args));
  }

  async function liveTree(head: string | null) {
    await reports.prepareLocalState();
    const snapshot = await reader.working(head);
    snapshot.baseRevision = head;
    await observeModules(store, snapshot);
    snapshot.digest = snapshotDigest(snapshot);
    snapshot.id = "working-" + snapshot.digest.slice(7);
    return snapshot;
  }

  function attachVersions(full: Snapshot, tree: Snapshot) {
    const modules = new Map(tree.modules.map(module => [module.directory, module]));
    const signature = (m: Snapshot["modules"][number]) => digest([m.document, m.files.map(f => [f.path, f.hash, f.mode])]);
    if (full.modules.length !== modules.size) throw new ApplicationError("STALE_VIEW", "Состав модулей изменился, обновите дерево");
    for (const module of full.modules) {
      const observed = modules.get(module.directory);
      if (!observed || signature(module) !== signature(observed))
        throw new ApplicationError("STALE_VIEW", "Файлы изменились, обновите дерево");
    }
    full.baseRevision = tree.baseRevision;
    full.observations = tree.observations;
    full.digest = snapshotDigest(full);
    if (full.kind === "working") full.id = "working-" + full.digest.slice(7);
  }

  async function loadGitTree(targetId: string, limit: number): Promise<ComparisonView> {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new ApplicationError("INVALID_ARGUMENT", "Некорректный размер истории");
    const history = await revisionHistory(limit);
    const head = history.revisions.at(-1)?.revision ?? null;
    const current = targetId === "current" ? await liveTree(head) : await reader.revision(targetId.slice(4));
    const selected = current.revision && history.revisions.find(item => item.revision === current.revision);
    const parent = !current.revision ? head : selected ? selected.parentRevision :
      (await listGitRevisions(root, { limit: 1, before: current.revision })).revisions.at(-1)?.revision;
    const baseline = parent ? { ...await reader.revision(parent), ...(parent === head ? { label: "HEAD", isHead: true } : {}) } : null;
    const comparison = await compareRepositorySnapshots(root, baseline, current, { emptyTree: !baseline });
    const id = digest([root, targetId, comparison.id]).slice(7, 31);
    let model: ReturnType<typeof createReportModel> | undefined;
    const view: SessionView = {
      ...comparison, id, target: { id: targetId }, gitTree: true,
      currentSnapshot: current, baselineSnapshot: baseline, reviews: [], reviewDiagnostics: [],
      get reportModel() { return model ??= createReportModel(baseline, current); },
    };
    views.set(id, view);
    while (views.size > 8) views.delete(views.keys().next().value!);

    const timeline = [
      ...history.revisions.map(revision => ({ ...revision, label: revision.isHead ? "HEAD" : revision.label })),
      { id: "current", kind: "current", label: "Текущее состояние", capturedAt: current.capturedAt },
    ];
    return structuredClone({
      schema_version: view.schema_version, id, root, before: view.before, after: view.after,
      complete: view.complete, counts: view.counts, diagnostics: view.diagnostics, reviewDiagnostics: [],
      separateAnalysis: true, modules: view.modules.map(moduleSummary), timeline,
      target: timeline.find(entry => entry.id === targetId) ?? metadata(current),
      baselines: [...history.revisions, ...await store.savedMetadata()], historyHasMore: history.hasMore,
    });
  }

  function findView(id: string) {
    const view = views.get(id);
    if (!view) throw new ApplicationError("STALE_VIEW", "Обновите сравнение");
    return view;
  }

  async function ensureReviews(view: SessionView, loaded?: SessionView["reviews"]) {
    if (!view.gitTree) return;
    view.reviewLoad ??= (async () => {
      const entries = loaded ?? await reports.readReviews();
      const model = view.reportModel;
      const statuses = model.aggregateTreeStatuses(entries);
      for (const module of view.modules) {
        const id = module.moduleId ?? "directory:" + module.directory;
        module.reviewStatus = statuses.get(id);
        module.review = reviewSummary(entries.filter(e => e.module_id === id), model);
      }
      view.reviews = entries;
    })().catch(cause => { view.reviewLoad = undefined; throw cause; });
    await view.reviewLoad;
  }

  function selectedAnalyses(entries: SessionView["reviews"], view: SessionView) {
    return currentAnalysisEntries(entries, view.reportModel, view.currentSnapshot, entry => followsAnalysis(entry, view.currentSnapshot, reader));
  }

  async function loadAnalysisSummaries(view: SessionView, entries = view.reviews) {
    const byModule = new Map<string, typeof entries>();
    for (const entry of entries) {
      const group = byModule.get(entry.module_id);
      if (group) group.push(entry);
      else byModule.set(entry.module_id, [entry]);
    }
    for (const module of view.modules) {
      const reviews = byModule.get(module.moduleId ?? "");
      module.analyses = reviews ? await analysisSummary(await selectedAnalyses(reviews, view), decisions) : {};
      module.descendantsNeedAnalysis = false;
    }
    const directories = new Map(view.modules.map(module => [module.directory, module]));
    for (const module of view.modules) {
      if (!module.after || module.analyses?.grasp && module.analyses.implementation) continue;
      let directory = module.directory;
      while (directory !== ".") {
        directory = directory.includes("/") ? directory.slice(0, directory.lastIndexOf("/")) : ".";
        const parent = directories.get(directory);
        if (parent) parent.descendantsNeedAnalysis = true;
      }
    }
  }

  async function getReviewStatuses({view:id}: {view:string}) {
    const view = findView(id);
    const entries = await reports.readReviews();
    await ensureReviews(view, entries);
    await loadAnalysisSummaries(view, entries);
    return structuredClone({ modules: view.modules.map(({key, review, reviewStatus, analyses, descendantsNeedAnalysis}) => ({key, review, reviewStatus, analyses, descendantsNeedAnalysis})), diagnostics: view.reviewDiagnostics });
  }

  /** Full evidence is only collected for an explicit action on the immutable tree. */
  async function evidenceView(view: SessionView): Promise<SessionView> {
    if (!view.gitTree) return view;
    const base = view.baselineSnapshot;
    const baseline = base?.revision ? await gitSnapshot(base.revision, null) : null;
    let current: Snapshot;
    if (view.currentSnapshot.revision) current = (await gitSnapshot(view.currentSnapshot.revision, null))!;
    else {
      const head = await readGitHeadRevision(root);
      if (head !== (base?.revision ?? null)) throw new ApplicationError("STALE_VIEW", "HEAD изменился, обновите дерево");
      const tree = await liveTree(head);
      if (tree.digest !== view.currentSnapshot.digest) throw new ApplicationError("STALE_VIEW", "Рабочее дерево изменилось");
      current = await captureWorkingTree(root, captureOptions);
      attachVersions(current, tree);
      if (await readGitHeadRevision(root) !== head) throw new ApplicationError("STALE_VIEW", "HEAD изменился");
    }
    if (!current.complete || baseline?.complete === false) {
      throw new ApplicationError("INCOMPLETE_VIEW", "Не удалось получить полные входные данные для анализа");
    }
    return {...view, currentSnapshot:current, baselineSnapshot:baseline, reportModel:createReportModel(baseline,current)};
  }

  async function loadComparison(args: ComparisonArgs): Promise<ComparisonView> {
    const historyLimit = Number(args.historyLimit ?? 50);
    if (!Number.isSafeInteger(historyLimit) || historyLimit < 1) throw new ApplicationError("INVALID_ARGUMENT", "Некорректный размер истории");
    const live = await captureLiveState(historyLimit);
    if (live.working.complete) attachVersions(live.working, await liveTree(live.head?.revision ?? null));
    const gitHistory = live.history!;
    const revisions = gitHistory.revisions;
    const headRevision = revisions.at(-1)?.revision ?? null;
    const previousHead = gitHead?.revision;
    gitHead = live.head;
    function retainedBaseline(published: PublishedComparison | null) {
      const base = published ? published.baseline : initialBaseline;
      // New and legacy snapshots can both identify the base that followed HEAD.
      if (gitHead && base?.kind === "git" && (base.isHead ?? base.revision === previousHead)) return gitHead;
      return base;
    }
    const working = live.working;
    // Наблюдение уже проверяет всю локальную историю: используем тот же
    // результат, чтобы не читать исходники каждого события второй раз.
    const localHistory = await changes.list(headRevision);
    const saved = [...await store.list(), ...publishedSnapshots];
    if (!launch) {
      launch = launchSnapshot(working);
      initialBaseline = gitHead ?? saved[0] ?? launch;
    }
    const known = new Map([...saved, ...localHistory.changes, launch,
      ...(initialBaseline ? [initialBaseline] : [])].map((snapshot) => [snapshot.id, snapshot]));
    let checkedExternalPublication = false;
    const resolve = async (id: string) => {
      if (id === "initial") return null;
      if (/^git-[a-f0-9]{40,64}$/.test(id)) return gitSnapshot(id.slice(4), headRevision);
      const snapshot = known.get(id) ?? (/^change-[a-f0-9]{64}$/.test(id) ? await changes.get(id) : null);
      if (snapshot) return snapshot;
      // Другой процесс мог опубликовать новый точный id после старта сервера.
      // Полное чтение требуется только для такого явного неизвестного селектора.
      if (!checkedExternalPublication && /^(?:(?:working|launch|change)-[a-f0-9]{64}|saved-[a-f0-9]{24})$/.test(id)) {
        checkedExternalPublication = true;
        const external = await reports.publishedComparison();
        if (external) {
          for (const item of [external.baseline, external.current].filter((snapshot): snapshot is Snapshot => snapshot !== null)) {
            known.set(item.id, item);
            saved.push(item);
          }
        }
      }
      return known.get(id) ?? null;
    };
    const targetId = args.target ?? "current";
    const current = targetId === "current" ? working : await resolve(targetId);
    if (!current) throw new ApplicationError("NOT_FOUND", "Состояние не найдено");
    const selected = args.baseline;
    let baseline = retainedBaseline(null);
    let usePublishedBaseline = false;
    // Компактная хронология явно запрашивает auto, чтобы прежний ручной
    // выбор базы не скрывал текущие правки после удаления этого выбора из UI.
    // API без параметра продолжает использовать опубликованную базу.
    if (selected && selected !== "auto") baseline = await resolve(selected);
    else if (targetId === "current" && selected === "auto" && gitHead) baseline = gitHead;
    else if (targetId !== "current" && current.kind === "git") {
      const revision = revisions.find((entry) => entry.revision === current.revision);
      const parent = revision ? revision.parentRevision :
        (await listGitRevisions(root, { limit: 1, before: current.revision })).revisions.at(-1)?.revision;
      baseline = parent ? await gitSnapshot(parent, headRevision) : null;
    } else if (targetId !== "current" && current.kind === "change") {
      baseline = current.baseRevision ? await gitSnapshot(current.baseRevision, headRevision) : null;
    } else usePublishedBaseline = true;
    if (!baseline && selected && !["initial", "auto"].includes(selected)) throw new ApplicationError("NOT_FOUND", "База сравнения не найдена");
    const { history, liveReports } = targetId === "current"
      ? await reports.refreshWorking(working, usePublishedBaseline ? retainedBaseline : () => baseline)
      : { history: await reports.list(), liveReports: [] };
    if (usePublishedBaseline) baseline = retainedBaseline(history.comparison);
    if (history.comparison) {
      initialBaseline = history.comparison.baseline;
      publishedSnapshots = [initialBaseline, history.comparison.current].filter((snapshot): snapshot is Snapshot => snapshot !== null);
    }
    const model = createReportModel(baseline, current);
    const comparison = await compareRepositorySnapshots(root, baseline, current);
    const view: SessionView = { ...comparison, currentSnapshot: current, baselineSnapshot: baseline, reviews: [], reviewDiagnostics: [], reportModel: model };
    // Two checkouts can have identical portable snapshots but own different live views.
    view.id = digest({ project: root, comparison: view.id, target: targetId }).slice(7, 31);
    view.reviewDiagnostics = [...history.diagnostics, ...localHistory.diagnostics ?? []];
    view.reviews = [...history.entries].sort((a, b) => (b.registration_order ?? 0) - (a.registration_order ?? 0));
    const statuses = model.aggregateTreeStatuses(history.entries);
    for (const module of view.modules) {
      const matching = view.reviews.filter((bundle) => module.moduleId ? bundle.report.module.id === module.moduleId :
        (bundle.report.module.current_path ?? bundle.report.module.baseline_path) === module.directory);
      module.review = reviewSummary(matching, model);
      const moduleId = module.moduleId ?? "directory:" + module.directory;
      module.reviewStatus = statuses.get(moduleId) ?? null;
      const technical = targetId === "current" ? liveReports.find((report) => report.module_id === moduleId) :
        model.createTechnicalReport(digest(store.snapshotRoot), module);
      module.structure = { automatic: true, complete: view.complete,
        checkHash: technical?.check_hash ?? null, diagnostics: technical?.structure.diagnostics ?? [] };
    }
    await loadAnalysisSummaries(view);
    views.set(view.id, view);
    while (views.size > 8) views.delete(views.keys().next().value!);
    const localChanges = new Map([...saved.filter((entry) => entry.kind === "change" && (entry.baseRevision ?? null) === headRevision),
      ...localHistory.changes].map((entry) => [entry.id, entry]));
    const timeline = [...revisions.map((entry) => ({ ...entry, isHead: entry.revision === headRevision,
      label: entry.revision === headRevision ? "HEAD" : "Revision " + entry.revision.slice(0, 7) })),
      ...[...localChanges.values()].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || ("sequence" in a ? a.sequence as number : 0) - ("sequence" in b ? b.sequence as number : 0)).map(metadata),
      { id: "current", kind: "current", label: "Текущее состояние", description: "Сжатый результат", capturedAt: working.capturedAt }];
    const target = targetId === "current" ? timeline[timeline.length - 1] : timeline.find((entry) => entry.id === targetId) ?? metadata(current);
    const bases = [...timeline.filter((entry) => entry.kind !== "current"),
      ...saved.filter((entry) => entry.kind === "saved").map(metadata), ...(baseline ? [metadata(baseline)] : [])];
    view.target = target;
    return structuredClone({ schema_version: view.schema_version, id: view.id, root, complete: view.complete,
      before: view.before, after: view.after, counts: view.counts, diagnostics: view.diagnostics, reviewDiagnostics: view.reviewDiagnostics,
      timeline, target, historyHasMore: gitHistory.hasMore,
      baselines: [{ id: "initial", label: "Первый анализ · без базы", kind: "initial" }, ...new Map(bases.map((entry) => [entry.id, entry])).values()],
      modules: view.modules.map(moduleSummary) } satisfies ComparisonView);
  }

  /** Возвращает детали и доказательства из выбранного неизменяемого представления. */
  async function getModule(args: ModuleArgs): Promise<ModuleDetail> {
    const { view, module } = selectedModule(args);
    if (args.analysis !== false && !args.currentOnly) await ensureReviews(view);
    let matching: SessionView["reviews"] = [];
    if (args.analysis !== false) {
      if (args.currentOnly && module.moduleId) matching = await reports.readModuleReviews(module.moduleId);
      else matching = view.reviews.filter(bundle => module.moduleId ? bundle.module_id === module.moduleId :
        (bundle.report.module.current_path ?? bundle.report.module.baseline_path) === module.directory);
    }
    const current = matching.length ? await selectedAnalyses(matching, view) : [];
    const detail = moduleDetail(module, args.currentOnly ? current : matching, matching.length ? view.reportModel : undefined, view.modules, root, reports.work);
    if (args.analysis !== false) detail.analyses = await analysisSummary(current, decisions, detail.reviews);
    if (view.target?.id === "current" && module.after) {
      detail.deletedClauses = editor.deletedClauses(module.after);
      const last = detail.deletedClauses.at(-1);
      if (last) detail.deletedClause = { section: last.section, clauseId: last.clauseId, undoToken: last.undoToken };
    }
    return detail;
  }

  async function getFileDiff(args: FileDiffArgs) {
    const { view, module } = selectedModule(args);
    return fileDiff(module, view.baselineSnapshot, view.currentSnapshot, args.file, view.gitTree ? { liveRoot: root } : { repository: root });
  }

  /** Выбирает точный view; неизвестный id требует обновления клиентом. */
  function selectedModule(args: ModuleArgs) {
    const view = views.get(args.view);
    if (!view) throw new ApplicationError("STALE_VIEW", "Обновите сравнение");
    const module = view.modules.find((entry) => entry.key === args.path);
    if (!module) throw new ApplicationError("NOT_FOUND", "Модуль не найден");
    return { view, module };
  }

  /** Экспортирует входы анализа выбранного представления без запуска агента. */
  async function prepareAnalysis(args: ModuleArgs) {
    const { view, module } = selectedModule(args);
    if (!view.complete || !(module.after ?? module.before)?.document.contract || !module.moduleId)
      throw new ApplicationError("INCOMPLETE_VIEW", "Нужны полный снимок и корректный контракт модуля");
    if (args.analysisType && !module.after) throw new ApplicationError("INVALID_ARGUMENT", "Модуль отсутствует в выбранном срезе.");
    if (args.analysisType === "grasp") return analysis.create(view, module, "grasp");
    return reports.withLivePublication(async () => analysis.create(await evidenceView(view), module, args.analysisType, view.after));
  }

  /** Читает сохранённый статус запроса, не подменяя его запуском модели. */
  async function getAnalysis(args: { id: string }) {
    if (!/^[a-f0-9-]{36}$/.test(args.id)) throw new ApplicationError("INVALID_ARGUMENT", "Некорректный идентификатор анализа");
    return analysis.status(args.id);
  }

  /** Перестраивает технический отчёт только для пары, опубликованной как текущая. */
  async function buildReview(args: ModuleArgs) {
    const { view, module } = selectedModule(args);
    if (!view.complete) throw new ApplicationError("INCOMPLETE_VIEW", "Неполный обход не позволяет сохранить проверку");
    if (view.gitTree && view.target?.id === "current") {
      await reports.withLivePublication(async () => {
        const full = await evidenceView(view);
        await reports.rebuild(full.baselineSnapshot, full.currentSnapshot, full.modules);
      });
    } else if (view.target?.id === "current") {
      // Проверка пары и её публикация выполняются под одной блокировкой хранилища.
      // Новый current, опубликованный параллельным запросом, не откатывается кешем.
      try {
        await reports.rebuild(view.baselineSnapshot, view.currentSnapshot, view.modules, {expectedComparison: {baseline: view.baselineSnapshot, current: view.currentSnapshot}});
      } catch (error) {
        if (error instanceof StalePublicationError) throw new ApplicationError("STALE_VIEW", "Сравнение устарело: обновите его перед пересборкой отчёта");
        throw error;
      }
    }
    return { automatic: true, module_id: module.moduleId };
  }

  /** Сохраняет именно выбранный полный снимок, оставляя текущий выбор клиента неизменным. */
  async function saveSnapshot(args: SnapshotArgs) {
    if (args.label !== undefined && args.label.length > 120)
      throw new ApplicationError("INVALID_ARGUMENT", "Некорректные параметры снимка");
    const view = views.get(args.view);
    if (!view) throw new ApplicationError("STALE_VIEW", "Обновите сравнение перед сохранением");
    if (!view.currentSnapshot.complete) throw new ApplicationError("INCOMPLETE_VIEW", "Неполный снимок нельзя сохранить как базу");
    return reports.withLivePublication(async () => metadata(await store.save((await evidenceView(view)).currentSnapshot, args.label)));
  }

  const waitForChanges: SessionOperations["waitForChanges"] = ({cursor}, signal) => watcher.wait(cursor, signal);
  const changeClause: SessionOperations["changeClause"] = args => {
    const { view, module } = selectedModule(args);
    if (view.target?.id !== "current" || !module.after?.document.contract)
      throw new ApplicationError("INVALID_ARGUMENT", "Редактирование доступно для контракта в текущем состоянии");
    return editor.changeClause(module.after, args, module.before?.document);
  };
  const changePrototype: SessionOperations["changePrototype"] = async args => {
    if (findView(args.view).target?.id !== "current")
      throw new ApplicationError("INVALID_ARGUMENT", "Прототипы доступны для изменения в текущем состоянии");
    if (args.action === "create") {
      const path = args.path.trim();
      const directory = path === "" || path === "/" ? args.moduleId : path;
      await createPrototypes(root, [{ directory, id: args.moduleId, title: args.title,
        purpose: args.purpose }]);
      return { directory };
    }
    const { module } = selectedModule(args);
    if (!module.after) throw new ApplicationError("STALE_VIEW", "Прототип отсутствует в текущем состоянии");
    return changeExistingPrototype(root, module.after, args.action === "edit" ? args.text : undefined);
  };
  const updateFinding: SessionOperations["updateFinding"] = async args => {
    const {view, module} = selectedModule(args);
    const entries = module.moduleId ? await reports.readModuleReviews(module.moduleId) : [];
    const review = (await selectedAnalyses(entries, view)).find(entry => entry.review_id === args.reviewId);
    if (!review) throw new ApplicationError("STALE_VIEW", "Анализ отсутствует в выбранном срезе.");
    const finding = review.report.findings.find(item => item.id === args.findingId && item.kind !== "contract_change");
    const summary = !review.report.findings.length && review.report.assessment.current.verdict === "violation" && args.findingId === "assessment-summary";
    if (!finding && !summary) throw new ApplicationError("NOT_FOUND", "Замечание не найдено.");
    try {
      return await decisions.update(args.reviewId, args.findingId, {status:args.status, decision:args.decision}, args.expected,
        {status:finding?.lifecycle === "resolved" ? "resolved" : "open", decision:""});
    } catch (error) {
      if (error instanceof DecisionConflict) throw new ApplicationError("DECISION_CONFLICT", error.message);
      throw error;
    }
  };
  const getRelations: SessionOperations["getRelations"] = async args => {
    const { view, module } = selectedModule(args);
    return relations.getRelations(root, store.directory, view.currentSnapshot, module.currentPath);
  };
  const buildRelations: SessionOperations["buildRelations"] = async args => {
    const { view, module } = selectedModule(args);
    if (view.target?.id !== "current") throw new ApplicationError("INVALID_ARGUMENT", "Построение связей доступно для рабочего дерева.");
    return relations.buildRelations(root, store.directory, view.currentSnapshot, module.currentPath);
  };
  const getRelationSource: SessionOperations["getRelationSource"] = async args => {
    const { view, module } = selectedModule(args);
    if (!module.after?.files.some(f => f.path === args.file)) throw new ApplicationError("NOT_FOUND", "Файл отсутствует в модуле.");
    return relations.getRelationSource(root, store.directory, view.currentSnapshot, args.file);
  };
  const operations = { waitForChanges, getComparison, getReviewStatuses, getModule, updateFinding, getRelations, buildRelations, getRelationSource,
    changeClause, changePrototype, getFileDiff, prepareAnalysis, getAnalysis, buildReview, saveSnapshot,
    getReviewSettings: (_args: {repository?: string}) => settings.read(),
    setReviewSetting: settings.set,
    listHarnesses: (_args: {repository?: string}) => analysis.harnesses(),
    deliverFindingFix: (args: FindingFixArgs) => analysis.deliverFix(args),
    deliverAnalysis: (args: {id: string; harnessId: string}) => analysis.deliver(args.id, args.harnessId) } satisfies SessionOperations;
  const turns = new AgentTurns(analysis, decisions,
    async () => findView((await getComparison({historyLimit:1})).id),
    view => reports.withLivePublication(() => evidenceView(view)), selectedAnalyses);
  return { root, store, migration, reviews, reports, changes, analysis, turns, startupComparison, ...operations, close: () => watcher.close() };
}
