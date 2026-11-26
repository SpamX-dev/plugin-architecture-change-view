import type { ComparisonView, ModuleSummary } from "../types.js";
import { moduleFindingCount, treeFindingCounts } from "../module-presenter/findings.js";
import { treeParents } from "../module-presenter/module-path.js";
import { moduleAnalysisStatus } from "../views/review-status.js";
import { createTreeView, type Filter, type ModuleRow, type TreeSection } from "../views/module-tree.js";

export function createModuleTree(getView: () => ComparisonView | null, getSelection: () => string | null,
  selectModule: (key: string, repository?: string) => Promise<void>) {
  let filter: Filter = "all";
  let search = "";
  const trees = new Map<string, { view: ComparisonView; expanded: Set<string>; historyLimit: number }>();
  const closed = new Set<string>();
  let treeRoot: string | undefined;
  const display = createTreeView({
    selectModule,
    filter(status) { filter = status; renderFilters(); renderTree(); },
    search(value) { search = value.trim().toLowerCase(); renderTree(); },
    collapse() {
      for (const [repository, { expanded, view }] of trees) {
        expanded.clear();
        if (view.workspace) closed.add(repository);
        else for (const module of view.modules) if (module.directory === ".") expanded.add(module.key);
      }
      renderTree();
    },
    expandModule(key, repository, expand) {
      const expanded = trees.get(repository ?? "")!.expanded;
      if (expand ?? !expanded.has(key)) expanded.add(key);
      else expanded.delete(key);
      renderTree();
    },
    toggleRepository(repository) {
      if (closed.has(repository)) closed.delete(repository);
      else closed.add(repository);
      renderTree();
    },
    selectRepository(repository) { closed.delete(repository); void selectModule(".", repository); },
  });

  function renderFilters() {
    const loaded = [...trees.values()].map(entry => entry.view);
    const total = loaded.reduce((sum, entry) => sum + entry.modules.length, 0);
    const filters = (["all", "initial", "new", "changed", "removed", "unchanged"] as const).map(status => ({
      status, count: status === "all" ? total : loaded.reduce((sum, entry) => sum + (entry.counts[status] ?? 0), 0),
    }));
    display.filters(filters, filter, total);
  }

  function renderTree() {
    const view = getView();
    if (!view) return display.tree([]);
    if (!view.workspace) return display.tree([{rows: rowsFor(view, trees.get("")!.expanded)}]);
    const { repositories, root } = view.workspace;
    const sections = repositories.map((repository): TreeSection => {
      const cached = trees.get(repository);
      const loaded = cached !== undefined;
      const expanded = loaded && !closed.has(repository);
      const label = repository === "." ? root.split(/[\\/]/).at(-1) || "." : repository;
      return {repository: {key: repository, label, loaded, expanded},
        rows: expanded ? rowsFor(cached.view, cached.expanded, repository) : []};
    });
    display.tree(sections);
  }

  /** Keep the matching side's ancestors visible, including an old owner of a reused path. */
  function rowsFor(view: ComparisonView, expanded: Set<string>, repository?: string): ModuleRow[] {
    const visible = new Set<string>();
    const matches = new Set<string>();
    const parents = treeParents(view.modules);
    for (const module of view.modules) {
      if (filter !== "all" && module.status !== filter) continue;
      if (search && ![module.directory, module.name, module.title, module.moduleId].some(text => text?.toLowerCase().includes(search))) continue;
      matches.add(module.key);
      let row: ModuleSummary | undefined = module;
      while (row && !visible.has(row.key)) {
        visible.add(row.key);
        row = parents.get(row.key);
      }
    }
    const modules = view.modules.filter(module => visible.has(module.key));
    const searching = search.length > 0 || filter !== "all";
    const findingCounts = treeFindingCounts(modules, searching ? visible : expanded, parents);
    const selected = getView()?.workspace?.repository === repository ? getSelection() : null;
    const rows = new Map<string, ModuleRow>();
    for (const module of modules) {
      const open = searching || expanded.has(module.key);
      const findings = findingCounts.get(module.key) ?? 0;
      const ownFindings = moduleFindingCount(module);
      let finding: string | undefined;
      if (findings) {
        const location = ownFindings === findings ? "модуля" : ownFindings ? "в модуле и вложенных модулях" : "во вложенных модулях";
        finding = "Открытые замечания " + location + " · " + findings;
      } else if (!module.analyses && view.published && (open ? module.reviewStatus?.self : module.reviewStatus?.subtree)?.current.current_violation) {
        finding = module.reviewStatus?.self?.current.current_violation ?
          "Сохранённая проверка выявила нарушение в модуле" : "Нарушение во вложенных модулях";
      }
      rows.set(module.key, { module, selected: selected === module.key, context: !matches.has(module.key), expanded: open,
        finding, analysis: moduleAnalysisStatus(module, open ? "self" : "subtree"), children: [] });
    }
    const roots: ModuleRow[] = [];
    for (const row of rows.values()) {
      const parent = parents.get(row.module.key);
      (parent ? rows.get(parent.key)!.children : roots).push(row);
    }
    return roots;
  }
  function showComparison(view: ComparisonView, historyLimit: number, automatic = false) {
    const root = view.workspace?.root ?? view.root;
    if (treeRoot !== root) {
      trees.clear();
      closed.clear();
      treeRoot = root;
    }
    const repository = view.workspace?.repository ?? "";
    for (const key of trees.keys()) {
      if (key !== repository && !view.workspace?.repositories.includes(key)) {
        trees.delete(key);
        closed.delete(key);
      }
    }
    const expanded = trees.get(repository)?.expanded ?? new Set(view.modules.length < 100 ? view.modules.map((module) => module.key) : []);
    trees.set(repository, { view, expanded, historyLimit });
    if (!automatic) closed.delete(repository);
    const repositoryCount = view.workspace?.repositories.length ?? trees.size;
    display.searchScope(trees.size, repositoryCount);
    renderFilters();
    // Selecting the initial module reveals its parents and renders the tree in one pass.
    if (automatic || !view.modules.length) renderTree();
  }

  function reveal(module: ModuleSummary) {
    const view = getView();
    if (!view) return;
    const repository = view.workspace?.repository ?? "";
    const expanded = trees.get(repository)!.expanded;
    closed.delete(repository);
    const parents = treeParents(view.modules);
    let row: ModuleSummary | undefined = module;
    while (row) {
      expanded.add(row.key);
      row = parents.get(row.key);
    }
    renderTree();
  }

  return { showComparison, reveal, refreshStatuses() { renderFilters(); renderTree(); }, getRepository: (repository: string) => trees.get(repository) };
}
