import type { ArchiViewClient, ComparisonView, ModuleDetail } from "../types.js";
import { errorMessage } from "../types.js";
import { el } from "../views/dom.js";
import { openRelationSource, renderRelations } from "../views/relations.js";

export function createRelationsPanel(client: ArchiViewClient) {
  const builds = new Map<string, Promise<unknown>>();
  return async function show(panel: HTMLElement, view: ComparisonView, module: ModuleDetail, select: (key: string) => void) {
    const box = el("div", "relations-panel");
    const action = el("button", "button button-quiet", "Построить связи проекта");
    const status = el("p", "relations-status", "Загрузка связей…");
    status.setAttribute("role", "status");
    box.append(action, status);
    panel.replaceChildren(box);
    const args = { view: view.id, path: module.key, repository: view.workspace?.repository };
    const current = !view.published && view.target.id === "current";
    action.hidden = !current;
    action.disabled = true;
    const selectKey = (dir: string) => view.modules.find(m => m.currentPath === dir)?.key;
    action.onclick = () => {
      if (!builds.has(view.root)) {
        const task = client.buildRelations(args).finally(() => builds.delete(view.root));
        builds.set(view.root, task);
      }
      void show(panel, view, module, select);
    };
    try {
      const pending = builds.get(view.root);
      if (current && pending) {
        status.textContent = "Строим связи всего проекта…";
        await pending;
        if (!box.isConnected) return;
      }
      const data = await client.getRelations(args);
      if (!box.isConnected) return;
      status.remove();
      action.textContent = data.ready ? "Перестроить связи проекта" : "Построить связи проекта";
      if (!module.after) box.append(el("p", "empty-state", "Модуль отсутствует в выбранном снимке."));
      else renderRelations(box, data, module.directory, dir => {
        const key = selectKey(dir);
        if (key !== undefined) select(key);
      }, (dir, site) => {
        const key = selectKey(dir);
        if (key !== undefined) void openRelationSource(site, () => client.getRelationSource({ ...args, path: key, file: site.file }));
      });
    } catch (cause) {
      status.textContent = errorMessage(cause);
    } finally { action.disabled = false; }
  };
}
