/**
 * Локальный сервер ArchiView. Представляет неизменяемые результаты сравнения,
 * раздаёт клиент и автоматически строит и уплотняет технические отчёты.
 * Корень проекта фиксируется при запуске; произвольные файлы через HTTP не выдаются.
 */
import { createServer } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { diffLines } from "diff";
import { captureGitHead, captureWorkingTree, compareSnapshots, listGitRevisions, readGitHeadRevision, snapshotDigest } from "../snapshots.mjs";
import { SnapshotStore } from "../snapshot-store.mjs";
import { ReviewStore } from "../review-store.mjs";
import { ReportStore } from "../report-store.mjs";
import { aggregateTreeStatuses, createTechnicalReport, reviewFreshness } from "../report-model.mjs";
import { ChangeHistory } from "../change-history.mjs";
import { digest } from "../formats.mjs";

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

/**
 * Создаёт сервер, но не открывает порт. Такой жизненный цикл позволяет тестам
 * использовать временный порт и закрывать ровно принадлежащий им экземпляр.
 */
export async function createArchiView({ root: requestedRoot, stateDirectory }) {
  const root = await realpath(requestedRoot);
  const store = new SnapshotStore(root, stateDirectory);
  await store.open();
  const reviews = new ReviewStore(store);
  const reports = new ReportStore(store);
  const changes = new ChangeHistory(store);
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
  let initialBaseline = published ? published.baseline : gitHead ?? (await store.list())[0] ?? launch;
  const startupView = compareSnapshots(initialBaseline, launch, { projectRoot: root });
  if (startupView.complete) await reports.rebuild(initialBaseline, launch, startupView.modules);
  const views = new Map();
  const assets = new Map([
    ["/", [new URL("../../web/archiview/index.html", import.meta.url), "text/html"]],
    ["/app.mjs", [new URL("../../web/archiview/app.mjs", import.meta.url), "text/javascript"]],
    ["/review.mjs", [new URL("../../web/archiview/review.mjs", import.meta.url), "text/javascript"]],
    ["/styles.css", [new URL("../../web/archiview/styles.css", import.meta.url), "text/css"]],
  ]);

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

  /** Завершает API-ответ; документы не попадают в текст исключений или журнал. */
  function json(response, status, value) {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(value));
  }

  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; " +
      "script-src 'self'; style-src 'self'; img-src 'self' data:; " +
      "object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    const address = server.address();
    const host = request.headers.host;
    if (!["127.0.0.1:" + address.port, "localhost:" + address.port].includes(host)) {
      return json(response, 403, { error: "Недопустимый адрес запроса" });
    }
    const url = new URL(request.url, "http://" + host);
    if (request.headers.origin && request.headers.origin !== url.origin) {
      return json(response, 403, { error: "Запрос должен исходить из ArchiView" });
    }
    try {
      if (request.method === "GET" && assets.has(url.pathname)) {
        const [asset, contentType] = assets.get(url.pathname);
        const content = await readFile(fileURLToPath(asset));
        response.writeHead(200, { "Content-Type": contentType + "; charset=utf-8" });
        return response.end(content);
      }
      if (request.method === "GET" && url.pathname === "/api/comparison") {
        const historyLimit = Number(url.searchParams.get("historyLimit") ?? 50);
        if (!Number.isSafeInteger(historyLimit) || historyLimit < 1) return json(response, 400, { error: "Некорректный размер истории" });
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
        if (working.complete && (!gitHead || gitHead.complete)) await changes.observe(working, gitHead);
        const localHistory = await changes.list(headRevision);
        const saved = await store.list();
        const known = new Map([...saved, ...localHistory.changes, launch,
          ...(initialBaseline ? [initialBaseline] : [])].map((snapshot) => [snapshot.id, snapshot]));
        const resolve = async (id) => {
          if (id === "initial") return null;
          if (/^git-[a-f0-9]{40,64}$/.test(id)) return gitSnapshot(id.slice(4), headRevision);
          return known.get(id) ?? (/^change-[a-f0-9]{64}$/.test(id) ? await changes.get(id) : null);
        };
        const targetId = url.searchParams.get("target") ?? "current";
        const current = targetId === "current" ? working : await resolve(targetId);
        if (!current) return json(response, 404, { error: "Состояние не найдено" });
        const selected = url.searchParams.get("baseline");
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
        if (!baseline && selected && !["initial", "auto"].includes(selected)) return json(response, 404, { error: "База сравнения не найдена" });
        if (targetId === "current") initialBaseline = baseline;
        // Исторический просмотр не публикуется вместо текущего work. Новые реальные
        // изменения при этом продолжают наблюдаться и уплотняться относительно своей базы.
        const workingView = compareSnapshots(initialBaseline, working, { projectRoot: root });
        const publication = workingView.complete ? await reports.rebuild(initialBaseline, working, workingView.modules) : null;
        const view = compareSnapshots(baseline, current, { projectRoot: root });
        view.id = digest({ comparison: view.id, target: targetId }).slice(7, 31);
        view.currentSnapshot = current;
        view.baselineSnapshot = baseline;
        const history = await reports.list();
        view.reviewDiagnostics = [...history.diagnostics, ...localHistory.diagnostics ?? []];
        view.reviews = [...history.entries].sort((a, b) => b.registration_order - a.registration_order);
        const statuses = aggregateTreeStatuses(history.entries, baseline, current);
        for (const module of view.modules) {
          const matching = view.reviews.filter((bundle) => module.moduleId ? bundle.report.module.id === module.moduleId :
            (bundle.report.module.current_path ?? bundle.report.module.baseline_path) === module.directory);
          const latest = matching.find((bundle) => {
            const freshness = reviewFreshness(bundle, baseline, current);
            return freshness.current.status === "fresh" && freshness.change.status === "fresh";
          }) ?? matching.find((bundle) => reviewFreshness(bundle, baseline, current).current.status === "fresh") ?? matching[0];
          module.review = latest ? { id: latest.report.id, stale: reviewFreshness(latest, baseline, current).current.status !== "fresh",
            assessment: latest.report.assessment, findings: latest.report.findings.length,
            createdAt: latest.report.analysis.created_at } : null;
          const moduleId = module.moduleId ?? "directory:" + module.directory;
          module.reviewStatus = statuses.get(moduleId) ?? null;
          const technical = targetId === "current" ? (publication?.reports ?? []).find((report) => report.module_id === moduleId) :
            createTechnicalReport(digest(store.snapshotRoot), baseline, current, module);
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
        return json(response, 200, { ...view, currentSnapshot: undefined, baselineSnapshot: undefined, reviews: undefined,
          timeline, target, historyHasMore: gitHistory.hasMore,
          baselines: [{ id: "initial", label: "Первый анализ · без базы", kind: "initial" }, ...new Map(bases.map((entry) => [entry.id, entry])).values()],
          modules: view.modules.map(({ before, after, files, ...module }) => module) });
      }
      if (request.method === "GET" && url.pathname === "/api/module") {
        const view = views.get(url.searchParams.get("view"));
        if (!view) return json(response, 409, { error: "Обновите сравнение" });
        const module = view.modules.find((entry) =>
          entry.key === url.searchParams.get("path"));
        if (!module) return json(response, 404, { error: "Модуль не найден" });
        const matching = view.reviews.filter((bundle) => module.moduleId ? bundle.report.module.id === module.moduleId :
          (bundle.report.module.current_path ?? bundle.report.module.baseline_path) === module.directory);
        return json(response, 200, { ...module, reviews: matching.map((bundle) => ({
          report: bundle.report, stale: reviewFreshness(bundle, view.baselineSnapshot, view.currentSnapshot).current.status !== "fresh",
          freshness: reviewFreshness(bundle, view.baselineSnapshot, view.currentSnapshot),
          dependencies: dependencyAssumptions(bundle, view),
          facts: evidenceForReport(bundle),
          contracts: bundle.manifest.contracts,
        })), diff: documentDiff(module.before?.document.text, module.after?.document.text) });
      }
      if (request.method === "POST" && url.pathname === "/api/reviews") {
        let body = "";
        for await (const chunk of request) {
          body += chunk;
          if (Buffer.byteLength(body) > 4096) return json(response, 413, { error: "Слишком большой запрос" });
        }
        const args = JSON.parse(body || "{}");
        if (typeof args.view !== "string" || typeof args.path !== "string") return json(response, 400, { error: "Нужны view и path" });
        const view = views.get(args.view);
        if (!view) return json(response, 409, { error: "Обновите сравнение" });
        const module = view.modules.find((m) => m.key === args.path);
        if (!module) return json(response, 404, { error: "Модуль не найден" });
        if (!view.complete) return json(response, 422, { error: "Неполный обход не позволяет сохранить проверку" });
        if (view.target?.id === "current") await reports.rebuild(view.baselineSnapshot, view.currentSnapshot, view.modules);
        return json(response, 200, { automatic: true, module_id: module.moduleId });
      }
      if (request.method === "POST" && url.pathname === "/api/snapshots") {
        let body = "";
        for await (const chunk of request) {
          body += chunk;
          if (Buffer.byteLength(body) > 4096) {
            return json(response, 413, { error: "Слишком большой запрос" });
          }
        }
        const args = JSON.parse(body || "{}");
        if (typeof args.view !== "string" ||
            (args.label !== undefined && (typeof args.label !== "string" ||
              args.label.length > 120))) {
          return json(response, 400, { error: "Некорректные параметры снимка" });
        }
        const view = views.get(args.view);
        if (!view) return json(response, 409, { error: "Обновите сравнение перед сохранением" });
        if (!view.currentSnapshot.complete) {
          return json(response, 422, { error: "Неполный снимок нельзя сохранить как базу" });
        }
        const saved = await store.save(view.currentSnapshot, args.label);
        return json(response, 201, metadata(saved));
      }
      return json(response, 404, { error: "Ресурс не найден" });
    } catch (error) {
      return json(response, error instanceof SyntaxError ? 400 : 500, { error: error.message });
    }
  });
  return { server, root, store, reviews, reports, changes };
}
