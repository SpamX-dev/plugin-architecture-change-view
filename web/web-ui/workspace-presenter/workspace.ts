import type { ArchiViewClient, ClauseNavigation, ComparisonView, WorkspaceContext, WorkspaceSelection } from "../view-model/types.js";
import { errorCode, errorMessage } from "../view-model/types.js";
import type { ModulePresenter } from "../module-presenter/module-card.js";
import { byId, el, icon, renderFailure } from "../views/dom.js";
import { createModuleTree } from "./module-tree.js";
import { renderTimeline, timelineDate } from "../views/timeline.js";
import { openReviewSettings } from "./review-settings.js";

function initialSelection(): { key?: string; repository?: string } {
  const hash = location.hash.slice(1);
  if (hash.startsWith("?")) {
    const query = new URLSearchParams(hash.slice(1));
    return { key: query.get("module") ?? undefined, repository: query.get("repository") ?? undefined };
  }
  try { return { key: decodeURIComponent(hash) || undefined }; } catch { return {}; }
}

export async function openWorkspace(client: ArchiViewClient, openModule: (workspace: WorkspaceContext) => ModulePresenter) {
  let current: ComparisonView | null = null;
  let currentTarget = "current";
  let currentHistoryLimit = 50;
  let generation = 0;
  let refreshing = false;
  let subscription: AbortController | undefined;
  let statusGeneration = 0;
  const card = openModule({
    get view() { return current; },
    get refreshing() { return refreshing; },
    reveal: module => tree.reveal(module),
    refresh, loadStatuses,
  });
  const tree = createModuleTree(() => current, () => card.selected, chooseTreeModule);

  async function chooseTreeModule(key: string, repository?: string) {
    if (!refreshing && repository === current?.workspace?.repository) return card.selectModule(key);
    const previous = tree.getRepository(repository ?? "");
    return refresh({ repository, target: previous?.view.target.id ?? "current", key, historyLimit: previous?.historyLimit ?? 50 });
  }

  function renderWarnings(view: ComparisonView) {
    const warning = byId("warning");
    const diagnostics = [...view.diagnostics, ...view.reviewDiagnostics];
    warning.hidden = view.complete && !diagnostics.length;
    warning.textContent = diagnostics.join("; ");
  }

  async function loadStatuses(view: ComparisonView) {
    if (view !== current || refreshing) return;
    const request = ++statusGeneration;
    const comparison = generation;
    const active = () => view === current && request === statusGeneration && comparison === generation;
    const updated = byId("updated");
    const timestamp = (view.target.id === "current" ? "Обновлено " : "Состояние от ") + timelineDate(view.after.capturedAt);
    updated.textContent = timestamp + " · Загружаем анализ…";
    try {
      const result = await client.getReviewStatuses({view:view.id, repository:view.workspace?.repository});
      if (!active()) return;
      const byKey = new Map(result.modules.map(module => [module.key,module]));
      for (const module of view.modules) Object.assign(module, byKey.get(module.key));
      view.reviewDiagnostics = result.diagnostics;
      renderWarnings(view);
      updated.textContent = timestamp;
      tree.refreshStatuses();
      const selected = view.modules.find(module => module.key === card.selected);
      if (selected) card.renderHeading(selected);
    } catch (error) {
      if (!active()) return;
      updated.textContent = timestamp + " · Не удалось загрузить статусы анализа: " + errorMessage(error) + " ";
      const retry = el("button", "text-button", "Повторить");
      retry.type = "button";
      retry.onclick = () => { void loadStatuses(view); };
      updated.append(retry);
    }
    card.renderPanel();
  }

  async function showComparison(view: ComparisonView, historyLimit: number, key?: string, clause?: ClauseNavigation, reviewId?: string, automatic = false) {
    const sameRepository = current?.root === view.root;
    card.setRepository(view.root, sameRepository);
    current = view;
    byId("project-settings").disabled = false;
    currentTarget = view.target.id;
    byId("new-prototype").hidden = Boolean(view.published) || currentTarget !== "current";
    currentHistoryLimit = historyLimit;
    renderTimeline(view, currentTarget);
    byId("project-name").textContent = view.modules[0]?.name ?? "Проект";
    byId("project-path").textContent = view.root;
    byId("project-path").title = view.root;
    renderWarnings(view);
    const captured = timelineDate(view.after.capturedAt);
    byId("updated").textContent = view.published ? "Сохранено " + captured + " · Проверяем изменения…" :
      currentTarget === "current" ? "Обновлено " + captured : "Состояние от " + captured;
    const owner = clause && view.modules.find((module) => module.moduleId === clause.reference.module_id);
    const selected = [owner?.key, key, key && view.modules.find(module => module.currentPath === key)?.key, sameRepository ? card.selected : undefined, "."].find((directory) =>
      view.modules.some((module) => module.key === directory)) ?? view.modules[0]?.key;
    tree.showComparison(view, historyLimit, automatic);
    refreshing = false;
    if (selected !== undefined) await card.selectModule(selected, clause, reviewId, automatic);
    if (view.separateAnalysis) void loadStatuses(view);
  }

  // Keep one long poll per live view. Navigation owns cancellation; module and tab selection stay interactive.
  async function followWorkingTree(initial: ComparisonView) {
    if (!initial.watchCursor && !initial.watchError) return;
    const controller = new AbortController();
    subscription = controller;
    const { signal } = controller;
    const repository = initial.workspace?.repository;
    let cursor = initial.watchCursor;
    let retry = false;
    while (!signal.aborted) {
      try {
        let reviewsChanged = false;
        if (cursor && !retry) {
          const event = await client.waitForChanges({ cursor, repository }, signal);
          if (signal.aborted) return;
          if (event.cursor === cursor) continue;
          cursor = event.cursor;
          reviewsChanged = event.reviewsChanged;
        }
        const view = await client.getComparison({ repository, target: "current", baseline: "auto", historyLimit: currentHistoryLimit, watch: true });
        if (signal.aborted) return;
        if (!view.watchCursor) throw new Error(view.watchError ?? "Наблюдение недоступно");
        if (view.id !== current?.id || reviewsChanged || retry || !cursor) {
          const previous = current?.modules.find(module => module.key === card.selected);
          const followed = previous?.moduleId && view.modules.find(module => module.moduleId === previous.moduleId);
          await showComparison(view, currentHistoryLimit, followed ? followed.key : undefined, card.selectedClause, undefined, true);
        }
        if (retry || !cursor) cursor = view.watchCursor;
        retry = false;
      } catch (error) {
        if (signal.aborted) return;
        byId("updated").textContent = "Автообновление временно недоступно · " + errorMessage(error);
        retry = true;
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
  }

  async function refresh({ target = currentTarget, historyLimit = currentHistoryLimit, clause, repository = current?.workspace?.repository, key }: WorkspaceSelection = {}) {
    subscription?.abort();
    const token = ++generation;
    const switching = current && repository !== current.workspace?.repository;
    refreshing = true;
    card.invalidate();
    const button = byId("refresh");
    byId("project-settings").disabled = true;
    button.disabled = true;
    byId("timeline").disabled = true;
    if (switching) {
      byId("module-title").textContent = repository ?? "Проект";
      byId("module-subtitle").hidden = true;
      byId("module-contract-heading").hidden = true;
      byId("copy-path").disabled = true;
      for (const id of ["breadcrumbs", "module-status", "module-meta"] as const) byId(id).replaceChildren();
      byId("document-panel").replaceChildren(el("div", "loading-state", "Читаем репозиторий…"));
    }
    button.classList.add("is-loading");
    try {
      const args = { target, baseline: "auto", historyLimit, repository, ...(target === "current" ? { watch: true } : {}) };
      const view = await client.getComparison(args);
      if (token !== generation) return;
      const previous = !switching && current?.modules.find(module => module.key === card.selected);
      const followed = previous && previous.moduleId && view.modules.find(module => module.moduleId === previous.moduleId);
      await showComparison(view, historyLimit, key ?? (followed ? followed.key : undefined), clause);
      if (token === generation && target === "current") void followWorkingTree(view);
    } catch (error) {
      if (token === generation) {
        if (!current && repository !== undefined && errorCode(error) === "REPOSITORY_UNAVAILABLE") {
          await refresh();
          return;
        }
        const selection = card.invalidate();
        renderFailure(error, async () => {
          if (token === generation && selection === card.selection) await refresh({ target, historyLimit, clause, repository, key });
        });
      }
    }
    finally {
      if (token === generation) {
        refreshing = false;
        card.renderAnalysisControls();
        button.disabled = false; button.classList.remove("is-loading");
        byId("project-settings").disabled = !current || Boolean(switching && current.workspace?.repository !== repository);
        byId("timeline").value = currentTarget;
        byId("timeline").disabled = !current || Boolean(current.published);
      }
    }
  }

  byId("refresh").prepend(icon("refresh"));
  byId("project-settings").onclick = () => { if (current) openReviewSettings(client, current); };
  byId("refresh").addEventListener("click", () => refresh());
  byId("timeline").addEventListener("change", (event) => {
    if ((event.target as HTMLInputElement | HTMLSelectElement).value === "load-earlier") {
      currentHistoryLimit += 50;
      (event.target as HTMLInputElement | HTMLSelectElement).value = currentTarget;
      refresh();
    } else refresh({ target: (event.target as HTMLInputElement | HTMLSelectElement).value });
  });
  window.addEventListener("pagehide", () => { ++generation; subscription?.abort(); });
  window.addEventListener("pageshow", event => { if (event.persisted) void refresh(); });
  await refresh(initialSelection());
}
