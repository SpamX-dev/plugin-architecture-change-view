/** Прикладная сессия проекта: снимки и операции просмотра без зависимости от транспорта. */
import { realpath } from "node:fs/promises";
import { ApplicationError } from "./errors.mjs";
import { diffLines } from "diff";
import { captureGitHead, captureWorkingTree, compareSnapshots, listGitRevisions, readGitHeadRevision, snapshotDigest } from "../snapshots.mjs";
import { SnapshotStore } from "../snapshot-store.mjs";
import { ReviewStore } from "../review-store.mjs";
import { ReportStore } from "../report-store.mjs";
import { createReportModel } from "../report-model.mjs";
import { ChangeHistory } from "../change-history.mjs";
import { digest } from "../formats.mjs";
import { AnalysisRequests } from "./analysis.mjs";

/** Метаданные базы, необходимые интерфейсу без передачи всех документов. */
function metadata(snapshot) {
  return { id: snapshot.id, label: snapshot.label, kind: snapshot.kind,
    capturedAt: snapshot.capturedAt, revision: snapshot.revision,
    baseRevision: snapshot.baseRevision, subject: snapshot.subject, isHead: snapshot.isHead };
}

/** Передаёт только использованные доказательства, а не исходники всего проекта. */
function evidenceForReport(bundle) {
  const references = [...bundle.report.checks.flatMap((c) => c.evidence),
    ...bundle.report.findings.flatMap((f) => f.evidence),
    ...Object.values(bundle.report.observed).flatMap((o) => o?.responsibilities.flatMap((r) => r.evidence) ?? [])];
  return Object.fromEntries(["baseline", "current"].map((side) => {
    const ids = new Set(references.filter((r) => r.snapshot === side).map((r) => r.fact_id));
    return [side, (bundle[side]?.facts ?? []).filter((f) => ids.has(f.id))];
  }));
}

/** Контракт зависимости задаёт предпосылку; он не подтверждает проверенность поставщика. */
function dependencyAssumptions(entry, view) {
  return (entry.inputs?.current.dependencies ?? []).map(({ selector, available }) => {
    const provider = selector.module_id ? view.modules.find((module) => module.moduleId === selector.module_id) :
      view.modules.find((module) => module.after?.files.some((file) => file.path === selector.path));
    return { selector, available, contractOnly: ["contract", "api"].includes(selector.kind),
      providerStatus: provider?.reviewStatus?.self.current ?? null };
  });
}

/** Разбивает разницу на строки с координатами прежнего и текущего документов. */
function documentDiff(before, after) {
  let oldLine = 1;
  let newLine = 1;
  const rows = [];
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
export async function createArchiViewSession({ root: requestedRoot, stateDirectory }) {
  const root = await realpath(requestedRoot);
  const store = new SnapshotStore(root, stateDirectory);
  await store.open();
  const reviews = new ReviewStore(store);
  const reports = new ReportStore(store);
  const changes = new ChangeHistory(store);
  const analysis = new AnalysisRequests(store, reports);
  const captureOptions = { snapshotRoot: store.snapshotRoot };
  const gitSnapshots = new Map();
  const startup = await captureLiveState();
  const launch = { ...startup.working, kind: "launch",
    label: "Начальное состояние" };
  launch.id = "launch-" + launch.fingerprint;
  let gitHead = startup.head;
  if (launch.complete && (!gitHead || gitHead.complete)) await changes.observe(launch, gitHead);
  // Открытие проекта публикует структуру даже до первого запроса браузера.
  // База выбирается тем же правилом, что и первое сравнение, и не продвигается.
  const published = await reports.publishedComparison();
  let initialBaseline = published ? published.baseline : gitHead ?? (await store.list({ includePublished: false }))[0] ?? launch;
  // Уже прочитанные опубликованные снимки остаются доступными по точному id.
  // Перечень сохранённых баз не должен заново читать всю историю отчётов.
  let publishedSnapshots = published ? [published.baseline, published.current].filter(Boolean) : [];
  const startupView = compareSnapshots(initialBaseline, launch, { projectRoot: root });
  if (startupView.complete) {
    const publication = await reports.rebuild(initialBaseline, launch, startupView.modules);
    publishedSnapshots = [publication.comparison.baseline, publication.comparison.current].filter(Boolean);
  }
  const views = new Map();
  /** Исторические коммиты читаются по выбору; список не загружает исходники всей истории. */
  async function gitSnapshot(revision, headRevision) {
    if (!gitSnapshots.has(revision)) gitSnapshots.set(revision,
      await captureGitHead(root, { ...captureOptions, revision }));
    const snapshot = gitSnapshots.get(revision);
    return snapshot ? { ...snapshot, label: revision === headRevision ? "HEAD" : "Revision " + revision.slice(0, 7), isHead: revision === headRevision } : null;
  }

  /** Размер страницы ограничен, но ранние коммиты доступны последующими страницами. */
  async function revisionHistory(limit) {
    let revisions = [], before, page;
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
  async function captureLiveState(historyLimit = null) {
    let result;
    for (let attempt = 0; attempt < 3; attempt++) {
      let history;
      try { history = historyLimit === null ? null : await revisionHistory(historyLimit); }
      catch (error) {
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
    const working = { ...result.working, complete: false,
      diagnostics: [...result.working.diagnostics, "HEAD изменялся во время построения снимка; обновите сравнение."] };
    working.digest = snapshotDigest(working);
    working.id = "working-" + working.digest.slice(7);
    return { ...result, working };
  }

  /** Формирует сравнение и хронологию, сохраняя исходную семантику публикации текущего состояния. */
  async function getComparison(args = {}) {
    const historyLimit = Number(args.historyLimit ?? 50);
    if (!Number.isSafeInteger(historyLimit) || historyLimit < 1) throw new ApplicationError("INVALID_ARGUMENT", "Некорректный размер истории");
    const live = await captureLiveState(historyLimit);
    const gitHistory = live.history;
    const revisions = gitHistory.revisions;
    const headRevision = revisions.at(-1)?.revision ?? null;
    const previousHead = gitHead?.revision;
    gitHead = live.head;
    // HEAD обновляется вместе с проектом. Явная другая база остаётся фиксированной.
    if (gitHead && initialBaseline?.kind === "git" && initialBaseline.revision === previousHead)
      initialBaseline = gitHead;
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
    const resolve = async (id) => {
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
          for (const item of [external.baseline, external.current].filter(Boolean)) {
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
    let baseline = initialBaseline;
    // Компактная хронология явно запрашивает auto, чтобы прежний ручной
    // выбор базы не скрывал текущие правки после удаления этого выбора из UI.
    // API без параметра продолжает использовать опубликованную базу.
    if (selected && selected !== "auto") baseline = await resolve(selected);
    else if (targetId === "current" && selected === "auto") baseline = gitHead ?? initialBaseline;
    else if (targetId !== "current") {
      if (current.kind === "git") {
        const revision = revisions.find((entry) => entry.revision === current.revision);
        const parent = revision ? revision.parentRevision :
          (await listGitRevisions(root, { limit: 1, before: current.revision })).revisions.at(-1)?.revision;
        baseline = parent ? await gitSnapshot(parent, headRevision) : null;
      } else if (current.kind === "change") baseline = current.baseRevision ? await gitSnapshot(current.baseRevision, headRevision) : null;
    }
    if (!baseline && selected && !["initial", "auto"].includes(selected)) throw new ApplicationError("NOT_FOUND", "База сравнения не найдена");
    if (targetId === "current") initialBaseline = baseline;
    // Исторический просмотр не публикуется вместо текущего work. Новые реальные
    // изменения при этом продолжают наблюдаться и уплотняться относительно своей базы.
    const workingView = compareSnapshots(initialBaseline, working, { projectRoot: root });
    const publication = workingView.complete ? await reports.rebuild(initialBaseline, working, workingView.modules) : null;
    if (publication) publishedSnapshots = [publication.comparison.baseline, publication.comparison.current].filter(Boolean);
    const view = compareSnapshots(baseline, current, { projectRoot: root });
    view.id = digest({ comparison: view.id, target: targetId }).slice(7, 31);
    view.currentSnapshot = current;
    view.baselineSnapshot = baseline;
    // rebuild уже прочитал и проверил историю под блокировкой. При неполном
    // рабочем снимке публикация не выполняется, поэтому остаётся обычное чтение.
    const history = publication ?? await reports.list();
    view.reviewDiagnostics = [...history.diagnostics, ...localHistory.diagnostics ?? []];
    view.reviews = [...history.entries].sort((a, b) => b.registration_order - a.registration_order);
    const model = createReportModel(baseline, current);
    view.reportModel = model;
    const statuses = model.aggregateTreeStatuses(history.entries);
    for (const module of view.modules) {
      const matching = view.reviews.filter((bundle) => module.moduleId ? bundle.report.module.id === module.moduleId :
        (bundle.report.module.current_path ?? bundle.report.module.baseline_path) === module.directory);
      const latest = matching.find((bundle) => {
        const freshness = model.reviewFreshness(bundle);
        return freshness.current.status === "fresh" && freshness.change.status === "fresh";
      }) ?? matching.find((bundle) => model.reviewFreshness(bundle).current.status === "fresh") ?? matching[0];
      module.review = latest ? { id: latest.report.id, stale: model.reviewFreshness(latest).current.status !== "fresh",
        assessment: latest.report.assessment, findings: latest.report.findings.length,
        activeFindings: latest.report.findings.length ? latest.report.findings.filter((finding) => finding.lifecycle !== "resolved").length :
          Number(latest.report.assessment.current.verdict === "violation"),
        createdAt: latest.report.analysis.created_at } : null;
      const moduleId = module.moduleId ?? "directory:" + module.directory;
      module.reviewStatus = statuses.get(moduleId) ?? null;
      const technical = targetId === "current" ? (publication?.reports ?? []).find((report) => report.module_id === moduleId) :
        model.createTechnicalReport(digest(store.snapshotRoot), module);
      module.structure = { automatic: true, complete: view.complete,
        checkHash: technical?.check_hash ?? null, diagnostics: technical?.structure.diagnostics ?? [] };
    }
    views.set(view.id, view);
    while (views.size > 8) views.delete(views.keys().next().value);
    const localChanges = new Map([...saved.filter((entry) => entry.kind === "change" && (entry.baseRevision ?? null) === headRevision),
      ...localHistory.changes].map((entry) => [entry.id, entry]));
    const timeline = [...revisions.map((entry) => ({ ...entry, isHead: entry.revision === headRevision,
      label: entry.revision === headRevision ? "HEAD" : "Revision " + entry.revision.slice(0, 7) })),
      ...[...localChanges.values()].sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.sequence - b.sequence).map(metadata),
      { id: "current", kind: "current", label: "Текущее состояние", description: "Сжатый результат", capturedAt: working.capturedAt }];
    const target = targetId === "current" ? timeline.at(-1) : timeline.find((entry) => entry.id === targetId) ?? metadata(current);
    const bases = [...timeline.filter((entry) => entry.kind !== "current"),
      ...saved.filter((entry) => entry.kind === "saved").map(metadata), ...(baseline ? [metadata(baseline)] : [])];
    view.target = target;
    return { ...view, currentSnapshot: undefined, baselineSnapshot: undefined, reportModel: undefined, reviews: undefined,
      timeline, target, historyHasMore: gitHistory.hasMore,
      baselines: [{ id: "initial", label: "Первый анализ · без базы", kind: "initial" }, ...new Map(bases.map((entry) => [entry.id, entry])).values()],
      modules: view.modules.map(({ before, after, files, ...module }) => module) };
  }

  /** Возвращает детали и доказательства из выбранного неизменяемого представления. */
  async function getModule(args) {
    const view = views.get(args.view);
    if (!view) throw new ApplicationError("STALE_VIEW", "Обновите сравнение");
    const module = view.modules.find((entry) =>
      entry.key === args.path);
    if (!module) throw new ApplicationError("NOT_FOUND", "Модуль не найден");
    const matching = view.reviews.filter((bundle) => module.moduleId ? bundle.report.module.id === module.moduleId :
      (bundle.report.module.current_path ?? bundle.report.module.baseline_path) === module.directory);
    return { ...module, reviews: matching.map((bundle) => ({
      report: bundle.report, stale: view.reportModel.reviewFreshness(bundle).current.status !== "fresh",
      freshness: view.reportModel.reviewFreshness(bundle),
      dependencies: dependencyAssumptions(bundle, view),
      facts: evidenceForReport(bundle),
      contracts: bundle.manifest.contracts,
    })), diff: documentDiff(module.before?.document.text, module.after?.document.text) };
  }

  /** Выбирает точный view; неизвестный id требует обновления клиентом. */
  function selectedModule(args) {
    if (typeof args.view !== "string" || typeof args.path !== "string") throw new ApplicationError("INVALID_ARGUMENT", "Нужны view и path");
    const view = views.get(args.view);
    if (!view) throw new ApplicationError("STALE_VIEW", "Обновите сравнение");
    const module = view.modules.find((entry) => entry.key === args.path);
    if (!module) throw new ApplicationError("NOT_FOUND", "Модуль не найден");
    return { view, module };
  }

  /** Экспортирует входы анализа выбранного представления без запуска агента. */
  async function prepareAnalysis(args) {
    const { view, module } = selectedModule(args);
    if (!view.complete || !(module.after ?? module.before)?.document.contract || !module.moduleId)
      throw new ApplicationError("INCOMPLETE_VIEW", "Нужны полный снимок и корректный arch.yaml модуля");
    return analysis.create(view, module);
  }

  /** Читает сохранённый статус запроса, не подменяя его запуском модели. */
  async function getAnalysis(args) {
    if (typeof args.id !== "string" || !/^[a-f0-9-]{36}$/.test(args.id)) throw new ApplicationError("INVALID_ARGUMENT", "Некорректный идентификатор анализа");
    return analysis.status(args.id);
  }

  /** Перестраивает технический отчёт только для текущего полного представления. */
  async function buildReview(args) {
    const { view, module } = selectedModule(args);
    if (!view.complete) throw new ApplicationError("INCOMPLETE_VIEW", "Неполный обход не позволяет сохранить проверку");
    if (view.target?.id === "current") await reports.rebuild(view.baselineSnapshot, view.currentSnapshot, view.modules);
    return { automatic: true, module_id: module.moduleId };
  }

  /** Сохраняет именно выбранный полный снимок, оставляя текущий выбор клиента неизменным. */
  async function saveSnapshot(args) {
    if (typeof args.view !== "string" || (args.label !== undefined && (typeof args.label !== "string" || args.label.length > 120)))
      throw new ApplicationError("INVALID_ARGUMENT", "Некорректные параметры снимка");
    const view = views.get(args.view);
    if (!view) throw new ApplicationError("STALE_VIEW", "Обновите сравнение перед сохранением");
    if (!view.currentSnapshot.complete) throw new ApplicationError("INCOMPLETE_VIEW", "Неполный снимок нельзя сохранить как базу");
    return metadata(await store.save(view.currentSnapshot, args.label));
  }

  return { root, store, reviews, reports, changes, analysis, getComparison, getModule, prepareAnalysis, getAnalysis, buildReview, saveSnapshot };
}
