import type { ModuleSummary } from "../view-model/types.js";
import { byId, el, findingBug, findingMarker } from "./dom.js";
import { badge } from "./change-status.js";
import { moduleAnalysisStatus } from "./review-status.js";
import { moduleTrail } from "../view-model/tree-paths.js";

export function bindCardNavigation(actions: { createPrototype(): void; copyPath(): void; selectTab(tab: string): void }) {
  const tabs = document.querySelectorAll<HTMLElement>("[data-tab]");
  byId("new-prototype").addEventListener("click", actions.createPrototype);
  byId("copy-path").addEventListener("click", actions.copyPath);
  for (const button of tabs) button.addEventListener("click", () => actions.selectTab(button.dataset.tab ?? "document"));
  return (selected: string) => {
    for (const button of tabs) button.setAttribute("aria-selected", String(button.dataset.tab === selected));
    byId("document-panel").setAttribute("aria-labelledby", "tab-" + selected);
  };
}

/** Обновляет хлебные крошки, статус и контекст выбранного каталога. */
export function renderHeading(module: ModuleSummary, modules: ModuleSummary[], selectModule: (key: string) => void) {
  const group = byId("module-heading-content");
  group.className = "module-heading-content";
  group.removeAttribute("title");
  group.onclick = null;
  group.querySelector(":scope > .contract-change-action")?.remove();
  byId("module-title").className = "";
  byId("module-title").removeAttribute("title");
  byId("module-title").onclick = null;
  byId("module-title").textContent = module.title ?? module.name;
  byId("module-status").replaceChildren(badge(module.status, module.descendantChanges));
  byId("module-subtitle").textContent = module.directory === "." ?
    "Корневой модуль проекта" : module.directory;
  byId("module-subtitle").hidden = false;
  byId("module-contract-heading").replaceChildren();
  byId("module-contract-heading").hidden = true;
  const breadcrumbs = byId("breadcrumbs");
  breadcrumbs.replaceChildren();
  for (const [index, { directory, module: ancestor }] of moduleTrail(modules, module).entries()) {
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
  const analysis = moduleAnalysisStatus(module);
  for (const [label, value] of [["Контракт", documentLabel],
    ["Файлы", module.filesChanged + " изменено"],
    ["Подмодули", module.descendantChanges + " с изменениями"],
    ...(analysis ? [["Анализ", analysis]] : [])]) {
    const item = el("div", "meta-item");
    item.append(el("span", "meta-label", label), el("span", "meta-value", value));
    if (label === "Анализ") item.id = "review-status";
    meta.append(item);
  }
  byId("copy-path").disabled = false;
  byId("files-count").textContent = String(module.filesChanged);
  byId("files-count").hidden = module.filesChanged === 0;
  renderFindingCount(module);
  document.title = module.name + " — ArchiView";
}

export function renderFindingCount(module: Pick<ModuleSummary, "analyses" | "dependencyCycleCount">, cycleCount = module.dependencyCycleCount ?? 0) {
  for (const [type, label] of [["grasp", "GRASP"], ["implementation", "Реализация"]] as const) {
    const count = module.analyses?.[type]?.openFindings ?? 0;
    const tab = byId(type === "grasp" ? "tab-grasp" : "tab-implementation");
    tab.textContent = count ? label + " · " + count : label;
    if (count) tab.prepend(findingBug());
    if (type !== "implementation") continue;
    tab.removeAttribute("aria-description");
    if (cycleCount) {
      const description = "Циклические зависимости · " + cycleCount;
      const marker = findingMarker(description, "cycle");
      marker.setAttribute("aria-hidden", "true");
      tab.setAttribute("aria-description", description);
      tab.prepend(marker);
    }
  }
}
