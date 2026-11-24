/** Assertions at protocol boundaries keep fixtures explicit without weakening application types. */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { stringify } from "yaml";
export type { ComparisonView as ComparisonResponse, ModuleDetail as ModuleResponse } from "../module-operations/api.js";

export function initTestRepository(root: string) {
  execFileSync("git", ["init", "-q", "--initial-branch=main", root], { windowsHide: true });
}

export function commitTestFiles(root: string) {
  execFileSync("git", ["add", "."], { cwd:root, windowsHide:true });
  execFileSync("git", ["-c","user.name=Test","-c","user.email=test@example.invalid","commit","-qm","Initial"], { cwd:root, windowsHide:true });
}

export async function writeModuleTree(root: string, directories: Record<string, string>) {
  await mkdir(path.join(root, ".archiview/modules"), { recursive: true });
  await writeFile(path.join(root, ".archiview/modules.tree"), stringify(directories));
}

export function contractYaml(id: string, responsibility = "Read project data.") {
  return stringify({ schema_version: 1, id, title: id, kind: "module",
    purpose: responsibility, boundaries: {}, invariants: {} });
}
