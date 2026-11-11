import type { ComparisonView, ModuleDetail, DocumentDiffLine, SessionOperations, ComparisonArgs, ModuleArgs, SnapshotArgs } from "./api.js";
import type { Snapshot, GitRevision } from "../snapshots/types.js";
import type { ReviewBundle } from "../reviews/types.js";
import type { PublishedComparison, ReviewEntry } from "../reports/types.js";
import type { SessionView } from "./session-view.js";
import { errorDetails } from "../runtime/errors.js";
/** Прикладная сессия проекта: снимки и операции просмотра без зависимости от транспорта. */
import { realpath } from "node:fs/promises";
import path from "node:path";
import { ApplicationError } from "./errors.js";
import { diffLines } from "diff";
import { captureGitHead, captureWorkingTree, listGitRevisions, readGitHeadRevision } from "../snapshots/capture.js";
import { compareSnapshots } from "../snapshots/comparison.js";
import { snapshotDigest } from "../snapshots/identity.js";
import { SnapshotStore } from "../storage/snapshot-store.js";
import { ReviewStore } from "../storage/review-store.js";
import { ReportStore, StalePublicationError, moduleReportName } from "../storage/report-store.js";
import { createReportModel } from "../reports/model.js";
import { ChangeHistory } from "../storage/change-history.js";
import { digest } from "../serialization/digest.js";
import { AnalysisRequests } from "./analysis.js";

/** Метаданные базы, необходимые интерфейсу без передачи всех документов. */
function metadata(snapshot: Snapshot) {
  return { id: snapshot.id, label: snapshot.label, kind: snapshot.kind,
    capturedAt: snapshot.capturedAt, revision: snapshot.revision,
    baseRevision: snapshot.baseRevision, subject: snapshot.subject, isHead: snapshot.isHead };
}

/** Передаёт только использованные доказательства, а не исходники всего проекта. */
function evidenceForReport(bundle: Pick<ReviewBundle, "report"> & { baseline: Pick<Snapshot, "facts"> | null; current: Pick<Snapshot, "facts"> }) {
  const references = [...bundle.report.checks.flatMap((c) => c.evidence),
    ...bundle.report.findings.flatMap((f) => f.evidence),
    ...Object.values(bundle.report.observed).flatMap((o) => o?.responsibilities.flatMap((r) => r.evidence) ?? [])];
  function facts(side: "baseline" | "current") {
    const ids = new Set(references.filter((r) => r.snapshot === side).map((r) => r.fact_id));
    return (bundle[side]?.facts ?? []).filter((fact) => ids.has(fact.id));
  }
  return { baseline: facts("baseline"), current: facts("current") };
}

/** Контракт зависимости задаёт предпосылку; он не подтверждает проверенность поставщика. */
function dependencyAssumptions(entry: ReviewEntry, view: SessionView) {
  return (entry.inputs?.current.dependencies ?? []).map(({ selector, available }) => {
    const provider = selector.module_id ? view.modules.find((module) => module.moduleId === selector.module_id) :
      view.modules.find((module) => module.after?.files.some((file) => file.path === selector.path));
    return { selector, available, contractOnly: ["contract", "api"].includes(selector.kind),
      providerStatus: provider?.reviewStatus?.self.current ?? null };
  });
}

/** Разбивает разницу на строки с координатами прежнего и текущего документов. */
function documentDiff(before?: string | null, after?: string | null) {
  let oldLine = 1;
  let newLine = 1;
  const rows: DocumentDiffLine[] = [];
  for (const part of diffLines(before ?? "", after ?? "")) {
    const lines = part.value.split("\n");
    if (lines.at(-1) === "") lines.pop();
    for (const text of lines) rows.push({
      kind: part.added ? "added" : part.removed ? "removed" : "same",
      beforeLine: part.added ? null : oldLine++,
      afterLine: part.removed ? null : newLine++,
      text,
    });
  }
  return rows;
}

/** Открывает хранилища одного проекта; вызывается лениво при первом запросе данных. */
export async function createArchiViewSession({ root: requestedRoot, stateDirectory }: { root: string; stateDirectory?: string }) {
  const root = await realpath(requestedRoot);
  const store = new SnapshotStore(root, stateDirectory);
  await store.open();
  const reviews = new ReviewStore(store);
  const reports = new ReportStore(store);
  const changes = new ChangeHistory(store);
  const analysis = new AnalysisRequests(store, reports);
  const captureOptions = { snapshotRoot: store.snapshotRoot };
  const gitSnapshots = new Map<string, Snapshot | null>();
  const startupState = await reports.withLivePublication(async () => {
    const startup = await captureLiveState();
    const launch = { ...startup.working, kind: "launch",
      label: "Начальное состояние" };
    launch.id = "launch-" + launch.fingerprint;
    const gitHead = startup.head;
    if (launch.complete && (!gitHead || gitHead.complete)) await changes.observe(launch, gitHead);
    // Открытие проекта публикует структуру даже до первого запроса браузера.
    // База выбирается тем же правилом, что и первое сравнение, и не продвигается.
    const published = await reports.publishedComparison();
    const initialBaseline = published ? published.baseline : gitHead ?? (await store.list({ includePublished: false }))[0] ?? launch;
    // Уже прочитанные опубликованные снимки остаются доступными по точному id.
    // Перечень сохранённых баз не должен заново читать всю историю отчётов.
    let publishedSnapshots = published ? [published.baseline, published.current].filter((snapshot): snapshot is Snapshot => snapshot !== null) : [];
    const startupView = compareSnapshots(initialBaseline, launch, { projectRoot: root });
    if (startupView.complete) {
      const publication = await reports.rebuild(initialBaseline, launch, startupView.modules);
      publishedSnapshots = publication.comparison ? [publication.comparison.baseline, publication.comparison.current].filter((snapshot): snapshot is Snapshot => snapshot !== null) : [];
    }
    return { launch, gitHead, initialBaseline, publishedSnapshots };
  });
  const { launch } = startupState;
  let { gitHead, initialBaseline, publishedSnapshots } = startupState;
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
    return reports.withLivePublication(() => loadComparison(args));
  }

  async function loadComparison(args: ComparisonArgs): Promise<ComparisonView> {
    const historyLimit = Number(args.historyLimit ?? 50);
    if (!Number.isSafeInteger(historyLimit) || historyLimit < 1) throw new ApplicationError("INVALID_ARGUMENT", "Некорректный размер истории");
    const live = await captureLiveState(historyLimit);
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
    const observation = working.complete && (!gitHead || gitHead.complete) ?
      await changes.observe(working, gitHead, { includeHistory: true }) : null;
    const localHistory = observation?.history ?? await changes.list(headRevision);
    const saved = [...await store.list({ includePublished: false }), ...publishedSnapshots];
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
    // An explicit current selection updates work. A historical view only observes live changes
    // against the authoritative base, including a base chosen by another session.
    const selectLiveBaseline = targetId === "current" && !usePublishedBaseline ? () => baseline : retainedBaseline;
    const { history, liveReports } = await reports.refreshWorking(working, selectLiveBaseline);
    if (usePublishedBaseline) baseline = retainedBaseline(history.comparison);
    if (history.comparison) {
      initialBaseline = history.comparison.baseline;
      publishedSnapshots = [initialBaseline, history.comparison.current].filter((snapshot): snapshot is Snapshot => snapshot !== null);
    }
    const model = createReportModel(baseline, current);
    const view: SessionView = { ...compareSnapshots(baseline, current, { projectRoot: root }), currentSnapshot: current, baselineSnapshot: baseline, reviews: [], reviewDiagnostics: [], reportModel: model };
    view.id = digest({ comparison: view.id, target: targetId }).slice(7, 31);
    view.reviewDiagnostics = [...history.diagnostics, ...localHistory.diagnostics ?? []];
    view.reviews = [...history.entries].sort((a, b) => (b.registration_order ?? 0) - (a.registration_order ?? 0));
    const statuses = model.aggregateTreeStatuses(history.entries);
    for (const module of view.modules) {
      const matching = view.reviews.filter((bundle) => module.moduleId ? bundle.report.module.id === module.moduleId :
        (bundle.report.module.current_path ?? bundle.report.module.baseline_path) === module.directory);
      const latest = matching.find((bundle) => {
        const freshness = model.reviewFreshness(bundle);
        return freshness.current.status === "fresh" && freshness.change.status === "fresh";
      }) ?? matching.find((bundle) => model.reviewFreshness(bundle).current.status === "fresh") ?? matching[0];
      // Прежние записи об изменении контракта сохраняются в истории, но не считаются замечаниями.
      const findings = latest?.report.findings.filter((finding) => finding.kind !== "contract_change") ?? [];
      module.review = latest ? { id: latest.report.id, stale: model.reviewFreshness(latest).current.status !== "fresh",
        assessment: latest.report.assessment, findings: findings.length,
        activeFindings: findings.length ? findings.filter((finding) => finding.lifecycle !== "resolved").length :
          Number(latest.report.assessment.current.verdict === "violation"),
        createdAt: latest.report.analysis.created_at } : null;
      const moduleId = module.moduleId ?? "directory:" + module.directory;
      module.reviewStatus = statuses.get(moduleId) ?? null;
      const technical = targetId === "current" ? liveReports.find((report) => report.module_id === moduleId) :
        model.createTechnicalReport(digest(store.snapshotRoot), module);
      module.structure = { automatic: true, complete: view.complete,
        checkHash: technical?.check_hash ?? null, diagnostics: technical?.structure.diagnostics ?? [] };
    }
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
      modules: view.modules.map(({ before, after, files, ...module }) => module) } satisfies ComparisonView);
  }

  /** Возвращает детали и доказательства из выбранного неизменяемого представления. */
  async function getModule(args: ModuleArgs): Promise<ModuleDetail> {
    const { view, module } = selectedModule(args);
    const matching = view.reviews.filter((bundle) => module.moduleId ? bundle.report.module.id === module.moduleId :
      (bundle.report.module.current_path ?? bundle.report.module.baseline_path) === module.directory);
    return structuredClone({ ...module, reviews: matching.map((bundle) => ({
      report: bundle.report, stale: view.reportModel.reviewFreshness(bundle).current.status !== "fresh",
      // Путь берётся из фактического хранилища, включая явно заданное внешнее.
      // ID попытки и замечания выбирают запись внутри общей истории модуля.
      reviewFile: path.relative(root, path.join(reports.work,
        moduleReportName(bundle.module_id) + ".review.yaml")).split(path.sep).join("/"),
      freshness: view.reportModel.reviewFreshness(bundle),
      dependencies: dependencyAssumptions(bundle, view),
      facts: evidenceForReport(bundle),
      contracts: bundle.manifest.contracts,
    })), diff: documentDiff(module.before?.document.text, module.after?.document.text) } satisfies ModuleDetail);
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
      throw new ApplicationError("INCOMPLETE_VIEW", "Нужны полный снимок и корректный arch.yaml модуля");
    return analysis.create(view, module);
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
    if (view.target?.id === "current") {
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
    return metadata(await store.save(view.currentSnapshot, args.label));
  }

  const operations = { getComparison, getModule, prepareAnalysis, getAnalysis, buildReview, saveSnapshot } satisfies SessionOperations;
  return { root, store, reviews, reports, changes, analysis, ...operations };
}
