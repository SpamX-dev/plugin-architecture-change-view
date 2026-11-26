import type { ArchiViewClient, ComparisonView, ModuleDetail } from "../view-model/types.js";
import { errorMessage } from "../view-model/types.js";
import { el } from "../views/dom.js";
import { openRelationSource, renderDependencyCycles, renderRelations } from "../views/relations.js";
import type { Site } from "../../../framework/module-relations/types.js";

export function createRelationsPanel(client: ArchiViewClient, loadStatuses: (view: ComparisonView) => Promise<void>) {
  const builds = new Map<string, Promise<unknown>>();
  return async function show(panel: HTMLElement, view: ComparisonView, module: ModuleDetail, select: (key: string) => void, mode: "relations" | "cycles" = "relations") {
    const box = el("div", "relations-panel");
    if (mode === "cycles") box.append(el("h3", "section-heading", "Циклические зависимости"));
    const action = el("button", "button button-quiet", "Построить связи проекта");
    const status = el("p", "relations-status", mode === "cycles" ? "Проверяем циклические зависимости…" : "Загрузка связей…");
    status.setAttribute("role", "status");
    box.append(action, status);
    panel.replaceChildren(box);
    const args = { view: view.id, path: module.key, repository: view.workspace?.repository };
    const current = !view.published && view.target.id === "current";
    action.hidden = !current || mode === "cycles";
    action.disabled = true;
    const modules = new Map(view.modules.map(m => [m.currentPath, m]));
    const openSite = (dir: string, site: Site) => {
      const owner = modules.get(dir);
      if (owner) void openRelationSource(site, () => client.getRelationSource({ ...args, path: owner.key, file: site.file }));
    };
    action.onclick = () => {
      if (!builds.has(view.root)) {
        const task = client.buildRelations(args).then(() => {
          if (!view.watchCursor) void loadStatuses(view);
        }).finally(() => builds.delete(view.root));
        builds.set(view.root, task);
      }
      void show(panel, view, module, select, mode);
    };
    try {
      const pending = builds.get(view.root);
      if (current && pending) {
        status.textContent = "Строим связи всего проекта…";
        await pending;
        if (!box.isConnected) return;
      }
      if (!module.after) box.append(el("p", "empty-state", "Модуль отсутствует в выбранном снимке."));
      else if (mode === "cycles") {
        const result = await client.getDependencyCycles(args);
        if (!box.isConnected) return;
        renderDependencyCycles(box, result, dir => modules.get(dir)?.title ?? dir, openSite);
        action.hidden = !current || result.status !== "unindexed";
      } else {
        const data = await client.getRelations(args);
        if (!box.isConnected) return;
        action.textContent = data.ready ? "Перестроить связи проекта" : "Построить связи проекта";
        renderRelations(box, data, module.directory, dir => {
          const owner = modules.get(dir);
          if (owner) select(owner.key);
        }, openSite);
      }
      status.remove();
    } catch (cause) {
      status.textContent = errorMessage(cause);
      if (mode === "cycles" && current) action.hidden = false;
    } finally { action.disabled = false; }
  };
}
