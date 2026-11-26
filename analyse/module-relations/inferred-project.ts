import { copyFile, mkdir, stat, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { errorDetails } from "../../node-errors.js";
import { regularProjectFile } from "../project-sources/source-files.js";
import { supportsFile } from "./graph.js";

/** Give loose JS/TS files a real project root without creating a tsconfig in the checkout.
 * The indexer qualifies symbols in unnamed packages relative to the config's directory. */
export async function inferredProject(root: string, scratch: string, files: Iterable<string>, missing: string[], configured: string[]) {
  const project = path.join(scratch, "project");
  const directories = new Set(["."]);
  for (const file of files) {
    if (!supportsFile(file) && path.extname(file).toLowerCase() !== ".json") continue;
    if (!await regularProjectFile(root, file)) throw new Error("Файл изменился во время построения: " + file);
    const target = path.join(project, file);
    await mkdir(path.dirname(target), { recursive:true });
    await copyFile(path.join(root, file), target);
    let directory = path.posix.dirname(file);
    while (!directories.has(directory)) {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  for (const dir of directories) {
    const dependencies = path.join(root, dir, "node_modules");
    try { if (!(await stat(dependencies)).isDirectory()) continue; }
    catch (cause) { if (errorDetails(cause).code === "ENOENT") continue; throw cause; }
    await symlink(dependencies, path.join(project, dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  }
  // Loose files inherit the nearest project's resolver (including paths and module mode).
  // Keep each temporary config in the same directory as its original so unnamed SCIP symbols align.
  const roots = configured.map(config => ({config, directory: path.posix.dirname(config)}))
    .sort((a, b) => Number(a.directory === ".") - Number(b.directory === ".") || b.directory.length - a.directory.length);
  const groups = new Map<string, string[]>();
  for (const file of missing) {
    const config = roots.find(({directory}) => directory === "." || file.startsWith(directory + "/"))?.config ?? "";
    const group = groups.get(config) ?? [];
    group.push(file);
    groups.set(config, group);
  }
  const configs = [];
  for (const [base, inputs] of groups) {
    const directory = base ? path.posix.dirname(base) : ".";
    const config = path.posix.join(directory, ".archiview-" + randomUUID() + ".json");
    await writeFile(path.join(project, config), JSON.stringify({
      ...(base ? { extends: "./" + path.posix.basename(base) } : {}),
      compilerOptions: base ? { allowJs: true } : { allowJs: true, module: "NodeNext" },
      files: inputs.map(file => path.posix.relative(directory, file)), include: [], exclude: [],
    }), { flag: "wx" });
    configs.push(config);
  }
  return { root: project, configs };
}
