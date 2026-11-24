import { copyFile, mkdir, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { errorDetails } from "../../node-errors.js";
import { regularProjectFile } from "../project/source-files.js";
import { supportsFile } from "./graph.js";

/** Give loose JS/TS files a real project root without creating a tsconfig in the checkout.
 * The indexer qualifies symbols in unnamed packages relative to the config's directory. */
export async function inferredProject(root: string, scratch: string, files: Iterable<string>) {
  const project = path.join(scratch, "project");
  const directories = new Set(["."]);
  const inputs: string[] = [];
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
    if (supportsFile(file)) inputs.push(file);
  }
  for (const dir of directories) {
    const dependencies = path.join(root, dir, "node_modules");
    try { if (!(await stat(dependencies)).isDirectory()) continue; }
    catch (cause) { if (errorDetails(cause).code === "ENOENT") continue; throw cause; }
    await symlink(dependencies, path.join(project, dir, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  }
  await writeFile(path.join(project, "tsconfig.json"), JSON.stringify({
    compilerOptions: { allowJs: true, module: "NodeNext" }, files: inputs,
  }));
  return project;
}
