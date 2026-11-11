/** Возвращает цепочку каталогов выбранного модуля от корня проекта. */
export function ancestors(directory: string) {
  if (directory === ".") return ["."];
  const parts = directory.split("/");
  return [".", ...parts.map((_, index) => parts.slice(0, index + 1).join("/"))];
}

type ModulePath = { key: string; directory: string; status: string; baselinePath?: string | null; currentPath?: string | null };

function indexPaths<T extends ModulePath>(modules: T[]) {
  const before = new Map<string, T>();
  const after = new Map<string, T>();
  for (const module of modules) {
    if (module.status !== "new" && module.status !== "initial") before.set(module.baselinePath ?? module.directory, module);
    if (module.status !== "removed") after.set(module.currentPath ?? module.directory, module);
  }
  return { before, after };
}

/** Each navigation link keeps the identity from the selected side of the comparison. */
export function moduleTrail<T extends ModulePath>(modules: T[], selected: ModulePath) {
  const { before, after } = indexPaths(modules);
  const paths = selected.status === "removed" ? before : after;
  return ancestors(selected.directory).flatMap(directory => {
    const module = paths.get(directory);
    return module ? [{ directory, module }] : [];
  });
}

/** A removed row belongs to its baseline parent, even when a new module uses that path. */
export function treeParents<T extends ModulePath>(modules: T[]) {
  const { before, after } = indexPaths(modules);
  const parents = new Map<string, T>();
  for (const module of modules) {
    if (module.directory === ".") continue;
    const index = module.directory.lastIndexOf("/");
    const directory = index < 0 ? "." : module.directory.slice(0, index);
    const parent = (module.status === "removed" ? before : after).get(directory);
    if (parent) parents.set(module.key, parent);
  }
  return parents;
}
