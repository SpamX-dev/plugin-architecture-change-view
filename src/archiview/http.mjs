/**
 * Локальный сервер ArchiView. Представляет неизменяемые результаты сравнения,
 * раздаёт клиент и сохраняет снимки только по явному действию пользователя.
 * Корень проекта фиксируется при запуске; произвольные файлы через HTTP не выдаются.
 */
import { createServer } from "node:http";
import { readFile, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { diffLines } from "diff";
import { captureGitHead, captureWorkingTree, compareSnapshots } from "../snapshots.mjs";
import { SnapshotStore } from "../snapshot-store.mjs";
import { ReviewStore } from "../review-store.mjs";
import { createStructuralReview, reviewIsStale } from "../reviews.mjs";

/** Метаданные базы, необходимые интерфейсу без передачи всех документов. */
function metadata(snapshot) {
  return { id: snapshot.id, label: snapshot.label, kind: snapshot.kind,
    capturedAt: snapshot.capturedAt, revision: snapshot.revision };
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
  const reviews = new ReviewStore(store);
  const launch = { ...await captureWorkingTree(root), kind: "launch",
    label: "При открытии ArchiView" };
  launch.id = "launch-" + launch.fingerprint;
  const gitHead = await captureGitHead(root);
  const views = new Map();
  const assets = new Map([
    ["/", [new URL("../../web/archiview/index.html", import.meta.url), "text/html"]],
    ["/app.mjs", [new URL("../../web/archiview/app.mjs", import.meta.url), "text/javascript"]],
    ["/review.mjs", [new URL("../../web/archiview/review.mjs", import.meta.url), "text/javascript"]],
    ["/styles.css", [new URL("../../web/archiview/styles.css", import.meta.url), "text/css"]],
  ]);

  /** Собирает доступные базы, сохраняя точную версию Git HEAD момента запуска. */
  async function baselines() {
    return [...await store.list(), ...(gitHead ? [gitHead] : []), launch];
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
        const available = await baselines();
        const selected = url.searchParams.get("baseline");
        const baseline = selected === "initial" ? null : selected ? available.find((entry) => entry.id === selected) :
          gitHead ?? available.find((entry) => entry.kind === "saved") ?? launch;
        if (!baseline && selected !== "initial") return json(response, 404, { error: "База сравнения не найдена" });
        const current = await captureWorkingTree(root);
        const view = compareSnapshots(baseline, current);
        view.currentSnapshot = current;
        view.baselineSnapshot = baseline;
        const history = await reviews.list();
        view.reviewDiagnostics = history.diagnostics;
        view.reviews = history.bundles;
        for (const module of view.modules) {
          const matching = history.bundles.filter((bundle) => module.moduleId ? bundle.report.module.id === module.moduleId :
            (bundle.report.module.current_path ?? bundle.report.module.baseline_path) === module.directory);
          const latest = matching.find((bundle) => !reviewIsStale(bundle, baseline, current)) ?? matching[0];
          module.review = latest ? { id: latest.report.id, stale: reviewIsStale(latest, baseline, current),
            assessment: latest.report.assessment, findings: latest.report.findings.length,
            createdAt: latest.report.analysis.created_at } : null;
        }
        views.set(view.id, view);
        while (views.size > 8) views.delete(views.keys().next().value);
        return json(response, 200, { ...view, currentSnapshot: undefined, baselineSnapshot: undefined, reviews: undefined,
          baselines: [{ id: "initial", label: "Первый анализ · без базы", kind: "initial" }, ...available.map(metadata)],
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
          report: bundle.report, stale: reviewIsStale(bundle, view.baselineSnapshot, view.currentSnapshot),
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
        const bundle = createStructuralReview(view.baselineSnapshot, view.currentSnapshot, module);
        await reviews.save(bundle);
        return json(response, 201, { id: bundle.report.id });
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
  return { server, root, store, reviews };
}
