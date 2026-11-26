import { ancestors, indexPaths, type ModulePath } from "../workspace-presenter/tree-paths.js";

/** Each navigation link keeps the identity from the selected side of the comparison. */
export function moduleTrail<T extends ModulePath>(modules: T[], selected: ModulePath) {
  const { before, after } = indexPaths(modules);
  const paths = selected.status === "removed" ? before : after;
  return ancestors(selected.directory).flatMap(directory => {
    const module = paths.get(directory);
    return module ? [{ directory, module }] : [];
  });
}
