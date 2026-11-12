import type { ArchiViewClient, ClauseReference, ComparisonView, FindingTarget, FixRecord, ModuleDetail, ModuleSummary, PanelBridge, PromptAction, ReviewBundle } from "./types.js";
import { errorCode, errorMessage } from "./types.js";
import { byId, el, icon, notice } from "./dom.js";
import { renderContractHeading, savedClauseMatchesContract } from "./contract.js";
import { badge } from "./change-status.js";
import { freshnessLabel } from "./review-status.js";
import { renderReview } from "./review.js";
import { findingBug, moduleFindingCount } from "./findings.js";
import { moduleTrail } from "./module-path.js";
import { createModuleTree } from "./module-tree.js";
import { createAnalysisControls } from "./analysis-controls.js";
import { renderTimeline, timelineDate, timelineLabel } from "./timeline.js";
import { renderDocument, renderHistoricalClause, renderFiles } from "./module-document.js";
import { renderProjectSelection } from "./project-selection.js";

interface AppState {
  view: ComparisonView | null;
  detail: ModuleDetail | null;
  selected: string | null;
  tab: string;
  selection: number;
  refresh: number;
  target: string;
  historyLimit: number;
  bridge: PanelBridge | null;
  findingFixes: Map<string, FixRecord>;
}

interface ClauseNavigation {
  reference: ClauseReference;
  review: ReviewBundle;
}

function initialSelection(): { key?: string; repository?: string } {
  const hash = location.hash.slice(1);
  if (hash.startsWith("?")) {
    const query = new URLSearchParams(hash.slice(1));
    return { key: query.get("module") ?? undefined, repository: query.get("repository") ?? undefined };
  }
  try { return { key: decodeURIComponent(hash) || undefined }; } catch { return {}; }
}

export async function startApp({ client, bridge, host, chooseProject }: {
  client: ArchiViewClient;
  bridge: Promise<PanelBridge | null>;
  host: "web" | "dsh" | "codex";
  chooseProject?: () => Promise<string | null>;
}) {
  const state: AppState = { view: null, detail: null, selected: null, tab: "document",
    selection: 0, refresh: 0, target: "current", historyLimit: 50, bridge: null, findingFixes: new Map() };
  const tree = createModuleTree(() => state.view, () => state.selected, chooseTreeModule);
  const fixesByRepository = new Map<string, Map<string, FixRecord>>();
  let refreshing = false;
  let selectedClause: ClauseNavigation | undefined;
  function promptAction(): PromptAction | undefined {
    if (state.bridge?.send) return { mode: "send", deliver: state.bridge.send };
    if (host === "web") return { mode: "copy", deliver: (prompt) => navigator.clipboard.writeText(prompt) };
  }
  const renderAnalysisControls = createAnalysisControls({ client, promptAction,
    selection: () => ({ view: refreshing || !state.detail || state.view?.published ? null : state.view, module: state.view?.modules.find((entry) => entry.key === state.selected) }),
    refresh, toast });
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  function currentView(): ComparisonView { if (!state.view) throw new Error("Project comparison is not loaded"); return state.view; }

  function toast(message: string) {
    const node = byId("toast");
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 4000);
  }

  /** Обновляет хлебные крошки, статус и контекст выбранного каталога. */
  function renderHeading(module: ModuleSummary) {
    const group = byId("module-heading-content");
    group.className = "module-heading-content";
    group.removeAttribute("title");
    group.onclick = null;
    group.querySelector(":scope > .contract-change-action")?.remove();
    byId("module-title").className = "";
    byId("module-title").removeAttribute("title");
    byId("module-title").onclick = null;
    byId("module-title").textContent = module.title ?? module.name;
    byId("module-status").replaceChildren(badge(module.status, false, module.descendantChanges));
    byId("module-subtitle").textContent = module.directory === "." ?
      "Корневой модуль проекта" : module.directory;
    byId("module-subtitle").hidden = false;
    byId("module-contract-heading").replaceChildren();
    byId("module-contract-heading").hidden = true;
    const breadcrumbs = byId("breadcrumbs");
    breadcrumbs.replaceChildren();
    for (const [index, { directory, module: ancestor }] of moduleTrail(currentView().modules, module).entries()) {
      if (index) breadcrumbs.append(el("span", "breadcrumb-separator", "/"));
      const button = el("button", "breadcrumb", directory === "." ?
        ancestor.name : directory.split("/").at(-1));
      button.type = "button";
      button.addEventListener("click", () => selectModule(ancestor.key));
      breadcrumbs.append(button);
    }
    const meta = byId("module-meta");
    meta.replaceChildren();
    const documentLabel = module.documentState === "invalid" ? "Ошибка формата" : module.documentState === "missing" ? "Описание отсутствует" :
      module.documentState === "empty" ? "Описание пустое" :
        module.documentChanged ? "Описание изменено" : "Описание без изменений";
    for (const [label, value] of [["Контракт", documentLabel],
      ["Файлы", module.filesChanged + " изменено"],
      ["Подмодули", module.descendantChanges + " с изменениями"]]) {
      const item = el("div", "meta-item");
      item.append(el("span", "meta-label", label), el("span", "meta-value", value));
      meta.append(item);
    }
    byId("copy-path").disabled = false;
    // Собственная проверка и оценка изменения, затем то же для поддерева.
    // Статусы объединяются только подписью: актуальность входов не подменяется.
    const reviewStatuses = module.reviewStatus ? "Модуль · проверка: " +
      freshnessLabel(module.reviewStatus.self.current, { compact: true }) + " · оценка изменения: " +
      freshnessLabel(module.reviewStatus.self.change, { compact: true }) + " · Поддерево · проверка: " +
      freshnessLabel(module.reviewStatus.subtree.current, { compact: true }) + " · оценка изменения: " +
      freshnessLabel(module.reviewStatus.subtree.change, { compact: true }) : "Содержательной проверки нет";
    byId("review-status").textContent = reviewStatuses;
    byId("files-count").textContent = String(module.filesChanged);
    byId("files-count").hidden = module.filesChanged === 0;
    renderFindingCount(module);
    document.title = module.name + " — ArchiView";
    renderAnalysisControls();
  }

  function renderFindingCount(module: Pick<ModuleSummary, "review" | "reviewStatus">) {
    const findings = module.review?.findings;
    const tab = byId("tab-findings");
    tab.textContent = "Замечания" + (findings ? " · " + findings : "");
    if (moduleFindingCount(module) || (!module.review && module.reviewStatus?.self.current.current_violation)) tab.prepend(findingBug());
  }

  /** Загружает детали из того же снимка сравнения, что и дерево слева. */
  async function selectModule(directory: string, clause?: ClauseNavigation, reviewId?: string) {
    const view = currentView();
    const module = view.modules.find((item) => item.key === directory) ?? view.modules.find((item) => item.directory === directory);
    if (!module) return;
    selectedClause = clause;
    state.selected = module.key;
    state.detail = null;
    const token = ++state.selection;
    // URL sandbox-ресурса принадлежит хосту; about:srcdoc и opaque origins
    // запрещают replaceState. Обычная веб-страница сохраняет собственный hash.
    if (host !== "codex") {
      const fragment = view.workspace ? "?" + new URLSearchParams({ repository: view.workspace.repository, module: module.key }) :
        encodeURIComponent(module.key);
      history.replaceState(null, "", "#" + fragment);
    }
    renderHeading(module);
    tree.reveal(module);
    document.body.classList.remove("tree-open");
    byId("document-panel").replaceChildren(el("div", "loading-state", "Читаем документ…"));
    try {
      const detail = await client.getModule({ view: view.id, path: module.key, repository: view.workspace?.repository });
      if (token !== state.selection) return;
      state.detail = detail;
      renderFindingCount(detail);
      renderPanel({ reviewId });
      if (clause && state.tab === "document") revealClause(clause, detail);
    } catch (error) {
      if (token === state.selection) renderFailure(error, async () => {
        if (token !== state.selection) return;
        // A discarded server view can only be recovered by reloading its comparison.
        if (errorCode(error) === "STALE_VIEW") await refresh({ target: view.target.id, clause });
        else await selectModule(module.key, clause);
      });
    }
  }

  async function chooseTreeModule(key: string, repository?: string) {
    if (!refreshing && repository === state.view?.workspace?.repository) return selectModule(key);
    const previous = tree.getRepository(repository ?? "");
    return refresh({ repository, target: previous?.view.target.id ?? "current", key, historyLimit: previous?.historyLimit ?? 50 });
  }

  /**
   * Переходит из замечания к конкретному пункту контракта его владельца. Сохранённая
   * попытка и сторона снимка задают ожидаемый пункт: если активное сравнение его уже
   * не содержит, вместо молчаливого перехода показывается явная историческая карточка.
   */
  async function openReviewClause(reference: ClauseReference, review: ReviewBundle) {
    byId("document-panel").querySelectorAll("[data-historical-clause]").forEach((node) => node.remove());
    const module = currentView().modules.find((item) => item.moduleId === reference.module_id);
    state.tab = "document";
    if (module) await selectModule(module.key, { reference, review });
    else if (state.detail) {
      selectedClause = { reference, review };
      renderPanel();
      revealClause(selectedClause, state.detail);
    }
  }

  function revealClause({ reference, review }: ClauseNavigation, detail: ModuleDetail) {
    if (detail.moduleId !== reference.module_id) {
      renderHistoricalClause(reference, review,
        "Модуль не входит в активное сравнение, поэтому показан только сохранённый пункт проверки.");
      return;
    }
    const contract = (detail.after ?? detail.before)?.document.contract;
    const row = [...document.querySelectorAll<HTMLElement>("[data-contract-clause]")].find((item) =>
      item.dataset.clauseSection === reference.section && item.dataset.clauseId === reference.id);
    if (row && savedClauseMatchesContract(review, reference, contract)) {
      row.scrollIntoView({ block: "center" });
      row.classList.add("clause-target");
      row.tabIndex = -1;
      row.focus({ preventScroll: true });
      return;
    }
    renderHistoricalClause(reference, review,
      "В активном сравнении этого пункта нет: контракт изменился после сохранённой проверки.");
  }

  /** Жук открывает конкретное замечание той попытки, из которой он был показан. */
  function openReviewFinding(target: FindingTarget) {
    state.tab = "findings";
    selectedClause = undefined;
    renderPanel({ reviewId: target.reviewId, findingId: target.findingId });
  }

  /** Переключает представления одного модуля, сохраняя навигацию и базу сравнения. */
  function renderPanel(navigation: { reviewId?: string; findingId?: string } = {}) {
    for (const button of document.querySelectorAll<HTMLElement>("[data-tab]")) {
      button.setAttribute("aria-selected", String(button.dataset.tab === state.tab));
    }
    const panel = byId("document-panel");
    panel.setAttribute("aria-labelledby", "tab-" + state.tab);
    if (!state.detail) return;
    panel.replaceChildren();
    const heading = byId("module-contract-heading");
    const selected = state.detail.after ?? state.detail.before;
    if (!selected) return;
    heading.replaceChildren();
    heading.hidden = !selected.document.contract;
    byId("module-subtitle").hidden = Boolean(selected.document.contract);
    if (selected.document.contract) renderContractHeading(heading, selected.document, {
      contractDiff: state.detail.contractDiff, titleElement: byId("module-title"), groupElement: byId("module-heading-content"),
    });
    byId("document-version").textContent = state.detail.status === "removed" ? "Из базы сравнения" :
      currentView().published ? "Сохранённое состояние" : timelineLabel(currentView().target ?? { id: "current" });
    if (state.tab === "document") renderDocument(panel, state.detail, currentView(), selectModule, openReviewFinding);
    else if (["checks", "findings"].includes(state.tab)) {
      // Копирование доступно самостоятельной странице; встроенный хост без
      // capability отправки показывает недоступное действие, не меняя транспорт.
      const action = promptAction();
      const owner = state.detail;
      renderReview(panel, state.detail, state.tab, { openClause: openReviewClause,
        projectRoot: currentView().root, fixStates: state.findingFixes, fixMode: action?.mode,
        fixFinding: action?.deliver,
        fixChanged: (reviewId) => {
          if (state.detail === owner && state.tab === "findings" && panel.querySelector<HTMLElement>(".review-body")?.dataset.reviewId === reviewId)
            renderPanel({ reviewId });
        },
        ...navigation });
    }
    else renderFiles(panel, state.detail, copyText);
    renderAnalysisControls();
  }

  /** Объясняет ошибку загрузки и предлагает повторить доступное действие. */
  function renderFailure(error: unknown, retryOperation: () => Promise<void>) {
    if (errorCode(error) === "PROJECT_REQUIRED") return renderProjectSelection({
      projectHint: host === "codex" ? "Не удалось автоматически определить папку проекта. Укажите абсолютный путь к папке." : undefined,
      chooseProject,
      async openProject(projectRoot) { await client.setProject({ projectRoot }); await retryOperation(); },
    });
    const box = notice("Не удалось открыть данные", errorMessage(error), "removed-notice");
    const retry = el("button", "button button-quiet", "Повторить");
    retry.type = "button";
    retry.addEventListener("click", retryOperation);
    box.append(retry);
    byId("document-panel").replaceChildren(box);
  }

  async function showComparison(view: ComparisonView, historyLimit: number, key?: string, clause?: ClauseNavigation, reviewId?: string) {
    const sameRepository = state.view?.root === view.root;
    state.view = view;
    state.target = view.target.id;
    state.historyLimit = historyLimit;
    state.findingFixes = fixesByRepository.get(view.root) ?? new Map();
    fixesByRepository.set(view.root, state.findingFixes);
    renderTimeline(view, state.target);
    byId("project-name").textContent = view.modules[0]?.name ?? "Проект";
    byId("project-path").textContent = view.root;
    byId("project-path").title = view.root;
    byId("warning").hidden = view.complete && !view.reviewDiagnostics.length;
    byId("warning").textContent = [...view.diagnostics, ...view.reviewDiagnostics].join("; ");
    const captured = timelineDate(view.after.capturedAt);
    byId("updated").textContent = view.published ? "Сохранено " + captured + " · Проверяем изменения…" :
      state.target === "current" ? "Обновлено " + captured : "Состояние от " + captured;
    const owner = clause && view.modules.find((module) => module.moduleId === clause.reference.module_id);
    const selected = [owner?.key, key, sameRepository ? state.selected : undefined, "."].find((directory) =>
      view.modules.some((module) => module.key === directory)) ?? view.modules[0]?.key;
    tree.showComparison(view, historyLimit);
    refreshing = false;
    if (selected !== undefined) await selectModule(selected, clause, reviewId);
  }

  /** При переходе к текущему состоянию сначала показывает опубликованную структуру. */
  async function refresh({ target = state.target, historyLimit = state.historyLimit, clause, repository = state.view?.workspace?.repository, key }: {
    target?: string; historyLimit?: number; clause?: ClauseNavigation; repository?: string; key?: string;
  } = {}) {
    const token = ++state.refresh;
    const switching = state.view && repository !== state.view.workspace?.repository;
    let saved = !switching && state.view?.published && target === state.target ? state.view : undefined;
    refreshing = !saved;
    if (!saved) {
      ++state.selection;
      state.detail = null;
    }
    renderAnalysisControls();
    const button = byId("refresh");
    button.disabled = true;
    byId("timeline").disabled = true;
    if (switching) {
      byId("module-title").textContent = repository ?? "Проект";
      byId("module-subtitle").hidden = true;
      byId("module-contract-heading").hidden = true;
      byId("copy-path").disabled = true;
      for (const id of ["breadcrumbs", "module-status", "module-meta", "review-status"] as const) byId(id).replaceChildren();
      byId("document-panel").replaceChildren(el("div", "loading-state", "Читаем репозиторий…"));
    }
    button.classList.add("is-loading");
    try {
      const args = { target, baseline: "auto", historyLimit, repository };
      const preferPublished = target === "current" && (switching || state.view?.target.id !== "current");
      const view = await client.getComparison(preferPublished ? { ...args, published: true } : args);
      if (token !== state.refresh) return;
      if (view.published) saved = view;
      const shown = showComparison(view, historyLimit, key, clause);
      const initialSelection = state.selection;
      await shown;
      if (!view.published || token !== state.refresh) return;
      const live = await client.getComparison({ ...args, repository: view.workspace?.repository ?? repository });
      if (token !== state.refresh) return;
      const unchangedSelection = state.selection === initialSelection;
      const selected = view.modules.find((module) => module.key === state.selected);
      const liveModule = selected?.moduleId && live.modules.find((module) => module.moduleId === selected.moduleId);
      // A deep link can refer to a module added since publication. An already selected
      // module follows its stable ID if its directory moved or was reused.
      const nextKey = unchangedSelection && key && key !== selected?.key && live.modules.some((module) => module.key === key) ? key :
        liveModule ? liveModule.key : selected?.key;
      const reviewId = byId("document-panel").querySelector<HTMLElement>(".review-body")?.dataset.reviewId;
      await showComparison(live, historyLimit, nextKey, selectedClause, reviewId);
    } catch (error) {
      if (token === state.refresh) {
        if (!state.view && repository !== undefined && errorCode(error) === "REPOSITORY_UNAVAILABLE") {
          await refresh();
          return;
        }
        if (saved && state.view === saved) {
          const warning = byId("warning");
          byId("updated").textContent = "Сохранено " + timelineDate(saved.after.capturedAt);
          warning.hidden = false;
          warning.textContent = [...saved.diagnostics, ...saved.reviewDiagnostics, "Не удалось обновить рабочее дерево: " + errorMessage(error)].join("; ");
          return;
        }
        const selection = ++state.selection;
        state.detail = null;
        renderFailure(error, async () => {
          if (token === state.refresh && selection === state.selection) await refresh({ target, historyLimit, clause, repository, key });
        });
      }
    }
    finally {
      if (token === state.refresh) {
        refreshing = false;
        renderAnalysisControls();
        button.disabled = false; button.classList.remove("is-loading");
        byId("timeline").value = state.target;
        byId("timeline").disabled = !state.view || Boolean(state.view.published);
      }
    }
  }

  /** Копирует путь выбранного модуля или файла без изменения документов. */
  async function copyText(text: string) {
    try { await navigator.clipboard.writeText(text); toast("Путь скопирован"); }
    catch { toast(text); }
  }

  bridge.then((connected) => {
    state.bridge = connected;
    renderAnalysisControls();
    if (state.detail && state.tab === "findings") renderPanel();
  });
  byId("refresh").prepend(icon("refresh"));
  byId("refresh").addEventListener("click", () => refresh());
  byId("timeline").addEventListener("change", (event) => {
    if ((event.target as HTMLInputElement | HTMLSelectElement).value === "load-earlier") {
      state.historyLimit += 50;
      (event.target as HTMLInputElement | HTMLSelectElement).value = state.target;
      refresh();
    } else refresh({ target: (event.target as HTMLInputElement | HTMLSelectElement).value });
  });
  byId("copy-path").addEventListener("click", () => {
    if (state.detail) copyText(state.detail.directory === "." ? currentView().root :
      currentView().root.replace(/[\\/]$/, "") + "/" + state.detail.directory);
  });
  for (const tab of document.querySelectorAll<HTMLElement>("[data-tab]")) {
    tab.addEventListener("click", () => {
      state.tab = tab.dataset.tab ?? "document";
      selectedClause = undefined;
      renderPanel();
    });
  }
  await refresh(initialSelection());
}
