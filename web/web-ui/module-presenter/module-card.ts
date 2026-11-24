import type { ArchiViewClient, ClauseReference, ComparisonView, FindingTarget, FixRecord, ModuleDetail, ModuleSummary, ReviewBundle } from "../types.js";
import { errorCode, errorMessage } from "../types.js";
import type { WorkspaceContext } from "../workspace-presenter/workspace.js";
import { byId, el, renderFailure } from "../views/dom.js";
import { renderHeading as showHeading, renderFindingCount } from "../views/module-heading.js";
import { renderContractHeading, savedClauseMatchesContract } from "../views/contract.js";
import { renderReview } from "../views/review.js";
import { renderDocument, renderHistoricalClause, renderFiles } from "../views/module-document.js";
import { openFileDiff } from "../views/diff.js";
import { createAnalysisControls } from "./analysis-controls.js";
import { createRelationsPanel } from "./relations.js";
import { createClauseEditor } from "./clause-editor.js";
import { prototypeDialog } from "./prototype-editor.js";
import { isPrototype } from "../../../framework/contracts/types.js";

export interface ClauseNavigation {
  reference: ClauseReference;
  review: ReviewBundle;
}
export type ModulePresenter = ReturnType<typeof createModulePresenter>;

export function createModulePresenter(client: ArchiViewClient, workspace: WorkspaceContext) {
  const state: {
    detail: ModuleDetail | null;
    selected: string | null;
    selection: number;
    tab: string;
    findingFixes: Map<string, FixRecord>;
  } = { detail: null, selected: null, selection: 0, tab: "document", findingFixes: new Map() };
  const collapsedFileDirectories = new Set<string>();
  const showRelations = createRelationsPanel(client);
  const fixesByRepository = new Map<string, Map<string, FixRecord>>();
  let reviewDetail: ModuleDetail | undefined;
  let detailRequest: ModuleDetail | undefined;
  let detailError: string | undefined;
  let selectedClause: ClauseNavigation | undefined;
  async function copyPrompt(prompt: string) {
    if (!navigator.clipboard) throw new Error("Буфер обмена недоступен в этом браузере");
    await navigator.clipboard.writeText(prompt);
  }
  const renderAnalysisControls = createAnalysisControls({ client, copyPrompt,
    selection: () => ({ view: workspace.refreshing || !state.detail || workspace.view?.published ? null : workspace.view, module: workspace.view?.modules.find((entry) => entry.key === state.selected) }),
    refresh: workspace.refresh, toast });
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  const clauseControls = createClauseEditor(client, async (view, key, change) => {
    if (workspace.view?.root !== view.root || workspace.view?.target.id !== "current") return;
    await workspace.refresh();
    // Cancelling an addition removes its row. Return focus to that section in this case.
    requestAnimationFrame(() => {
      if (workspace.view?.root !== view.root || state.selected !== key || state.tab !== "document" || workspace.view?.target.id !== "current") return;
      const row = '[data-clause-section="' + change.section + '"][data-clause-id="' + CSS.escape(change.clauseId) + '"]';
      const panel = byId("document-panel");
      const focus = panel.querySelector<HTMLButtonElement>(row + " .clause-edit-action") ??
        panel.querySelector<HTMLButtonElement>('[data-add-clause="' + change.section + '"]');
      focus?.focus();
    });
  });

  function currentView(): ComparisonView { if (!workspace.view) throw new Error("Project comparison is not loaded"); return workspace.view; }

  function openPrototype(mode: "create" | "edit" | "delete") {
    const view = workspace.view;
    if (!view || view.published || view.target.id !== "current" || workspace.refreshing) return;
    prototypeDialog(mode, client, view, state.detail, async directory => {
      if (workspace.view?.root !== view.root || workspace.view?.target.id !== "current") return;
      const key = mode === "delete" ? directory.slice(0, Math.max(0, directory.lastIndexOf("/"))) || "." : directory;
      state.tab = "document";
      document.body.classList.remove("tree-open");
      await workspace.refresh({ key });
    });
  }

  function toast(message: string) {
    const node = byId("toast");
    node.textContent = message;
    node.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { node.hidden = true; }, 4000);
  }

  function renderHeading(module: ModuleSummary) {
    showHeading(module, currentView().modules, selectModule);
    renderAnalysisControls();
  }

  /** Загружает детали из того же снимка сравнения, что и дерево слева. */
  async function selectModule(directory: string, clause?: ClauseNavigation, reviewId?: string, automatic = false) {
    const view = currentView();
    const module = view.modules.find((item) => item.key === directory) ?? view.modules.find((item) => item.directory === directory);
    if (!module) return;
    if (module.key !== state.selected) collapsedFileDirectories.clear();
    selectedClause = clause;
    state.selected = module.key;
    state.detail = null;
    detailError = undefined;
    const token = ++state.selection;
    const fragment = view.workspace ? "?" + new URLSearchParams({ repository: view.workspace.repository, module: module.key }) :
      encodeURIComponent(module.key);
    history.replaceState(null, "", "#" + fragment);
    renderHeading(module);
    if (!automatic) {
      workspace.reveal(module);
      document.body.classList.remove("tree-open");
    }
    byId("document-panel").replaceChildren(el("div", "loading-state", "Читаем документ…"));
    try {
      const detail = await client.getModule({ view: view.id, path: module.key, repository: view.workspace?.repository, ...(view.separateAnalysis ? {analysis:false} : {}) });
      if (token !== state.selection) return;
      state.detail = detail;
      renderFindingCount(view.separateAnalysis ? module : detail);
      renderPanel({ reviewId });
    } catch (error) {
      if (token === state.selection) renderFailure(error, async () => {
        if (token !== state.selection) return;
        // A discarded server view can only be recovered by reloading its comparison.
        if (errorCode(error) === "STALE_VIEW") await workspace.refresh({ target: view.target.id, clause });
        else await selectModule(module.key, clause);
      });
    }
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
    const needsReview = viewNeedsReview();
    if (needsReview && state.detail !== reviewDetail && state.tab !== "files") {
      if (["checks", "findings"].includes(state.tab)) {
        panel.replaceChildren(el("div", "loading-state", detailError ?? workspace.reviewError ?? "Загружаем анализ…"));
        if (detailError || workspace.reviewError) {
          const retry = el("button", "button button-quiet", "Повторить");
          retry.onclick = () => {
            detailError = undefined;
            if (workspace.reviewError) void workspace.loadStatuses(currentView());
            else renderPanel(navigation);
          };
          panel.append(retry);
          return;
        }
      }
      const detail = state.detail;
      if (workspace.statusLoaded && !detailError && detailRequest !== detail) {
        detailRequest = detail;
        const view = currentView();
        void client.getModule({view:view.id, path:detail.key, repository:view.workspace?.repository, analysis:true}).then(result => {
          if (state.detail !== detail || workspace.view !== view) return;
          state.detail = reviewDetail = result;
          renderPanel(navigation);
        }).catch(error => {
          if (state.detail !== detail || workspace.view !== view) return;
          detailError = errorMessage(error);
          renderPanel(navigation);
        }).finally(() => { if (detailRequest === detail) detailRequest = undefined; });
      }
      if (state.tab !== "document") return;
    }
    if (state.tab === "document") {
      if (isPrototype(state.detail.after?.document.contract) && !currentView().published && workspace.view?.target.id === "current") {
        const actions = el("div", "prototype-actions");
        const edit = el("button", "button button-quiet", "Редактировать контракт");
        const remove = el("button", "button button-quiet", "Удалить прототип");
        edit.onclick = () => openPrototype("edit");
        remove.onclick = () => openPrototype("delete");
        actions.append(edit, remove);
        panel.append(actions);
      }
      renderDocument(panel, state.detail, currentView(), selectModule, openReviewFinding, clauseControls(currentView(), state.detail));
      if (selectedClause) revealClause(selectedClause, state.detail);
    }
    else if (["checks", "findings"].includes(state.tab)) {
      const owner = state.detail;
      renderReview(panel, state.detail, state.tab, { openClause: openReviewClause,
        projectRoot: currentView().root, fixStates: state.findingFixes, copyFixPrompt: copyPrompt,
        fixChanged: (reviewId) => {
          if (state.detail === owner && state.tab === "findings" && panel.querySelector<HTMLElement>(".review-body")?.dataset.reviewId === reviewId)
            renderPanel({ reviewId });
        },
        ...navigation });
    }
    else if (state.tab === "relations") {
      void showRelations(panel, currentView(), state.detail, selectModule);
    }
    else {
      const view = currentView(), detail = state.detail;
      renderFiles(panel, detail, copyText, collapsedFileDirectories, file => openFileDiff(file, view, () =>
        client.getFileDiff({ view: view.id, path: detail.key, file, repository: view.workspace?.repository })));
    }
    renderAnalysisControls();
  }

  function viewNeedsReview() {
    const view = workspace.view;
    if (!view?.separateAnalysis) return false;
    if (state.tab === "checks" || state.tab === "findings") return true;
    return state.tab === "document" && Boolean(view.modules.find(m => m.key === state.selected)?.review);
  }

  /** Копирует путь выбранного модуля или файла без изменения документов. */
  async function copyText(text: string) {
    try { await navigator.clipboard.writeText(text); toast("Путь скопирован"); }
    catch { toast(text); }
  }

  byId("new-prototype").addEventListener("click", () => openPrototype("create"));
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

  return {
    get selected() { return state.selected; },
    get selectedClause() { return selectedClause; },
    get selection() { return state.selection; },
    selectModule, renderHeading, renderPanel, renderAnalysisControls,
    invalidate() {
      ++state.selection;
      state.detail = null;
      renderAnalysisControls();
      return state.selection;
    },
    setRepository(root: string, sameRepository: boolean) {
      if (!sameRepository) collapsedFileDirectories.clear();
      detailError = undefined;
      state.findingFixes = fixesByRepository.get(root) ?? new Map();
      fixesByRepository.set(root, state.findingFixes);
    },
  };
}
