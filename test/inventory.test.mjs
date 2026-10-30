/** Проверки покрытия исходников, цепочки контрактов и ограничения корня. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { moduleContext, moduleInventory } from "../src/inventory.mjs";

/** Запускает Git без оболочки в изолированном тестовом репозитории. */
const runFile = promisify(execFile);

/** Создаёт временный проект с автоматической уборкой только его каталога. */
async function project(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), "architecture-change-view-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  return root;
}

test("covers each source directory and its containers; retains planned modules", async (t) => {
  const root = await project(t, {
    "module.md": "Project boundary", "src/module.md": "Application boundary",
    "src/main.ts": "export const main = 1;",
    "src/domain/order.ts": "export class Order {}",
    "src/empty/run.py": "pass", "src/empty/module.md": "  \n",
    "test/check.js": "export const check = true;",
    "future/module.md": "Responsibility of an agreed future module",
    "node_modules/dependency/index.js": "ignored",
    "dist/bundle.js": "ignored", "docs/README.md": "prose",
  });
  const result = await moduleInventory(root);
  const modules = new Map(result.modules.map((entry) => [entry.directory, entry]));
  assert.equal(result.complete, true);
  assert.equal(result.sourceFiles, 4);
  assert.deepEqual([...modules.keys()].sort(),
    [".", "future", "src", "src/domain", "src/empty", "test"].sort());
  assert.equal(modules.get(".").sourceFiles, 4);
  assert.equal(modules.get("src").sourceFiles, 3);
  assert.equal(modules.get("src/domain").status, "missing");
  assert.equal(modules.get("src/empty").status, "empty");
  assert.equal(modules.get("future").required, false);
  assert.equal(modules.get("future").status, "documented");
});

test("reads root-to-target contracts without hiding a missing child description", async (t) => {
  const root = await project(t, {
    "module.md": "Root responsibility", "src/module.md": "Source responsibility",
    "src/domain/order.ts": "class Order {}",
  });
  const context = await moduleContext(root, "src/domain");
  assert.deepEqual(context.contracts.map((entry) => entry.directory),
    [".", "src", "src/domain"]);
  assert.equal(context.contracts[0].text, "Root responsibility");
  assert.equal(context.contracts[1].text, "Source responsibility");
  assert.equal(context.contracts[2].status, "missing");
  assert.equal(await readFile(path.join(root, "src/domain/order.ts"), "utf8"),
    "class Order {}");
  await assert.rejects(moduleContext(root, "../"), /outside project/);
  await assert.rejects(moduleContext(root, root), /must be relative/);
});

test("respects Git ignores, includes untracked source and skips deleted tracked files", async (t) => {
  const root = await project(t, {
    ".gitignore": "ignored/\n", "ignored/generated.ts": "ignored",
    "src/live.ts": "export const live = 1;",
    "src/deleted.ts": "export const deleted = 1;",
    "src/untracked.py": "pass",
  });
  await runFile("git", ["init", "--quiet"], { cwd: root, windowsHide: true });
  await runFile("git", ["add", "src/deleted.ts"], { cwd: root, windowsHide: true });
  await rm(path.join(root, "src/deleted.ts"));
  const result = await moduleInventory(root);
  assert.equal(result.discovery, "git");
  assert.equal(result.complete, true);
  assert.equal(result.sourceFiles, 2);
  assert.deepEqual(result.modules.map((entry) => entry.directory), [".", "src"]);
  const subtree = await moduleInventory(path.join(root, "src"));
  assert.equal(subtree.sourceFiles, 2);
  assert.deepEqual(subtree.modules.map((entry) => entry.directory), ["."]);
});

test("marks bounded inventory and unreadable contracts as incomplete", async (t) => {
  const root = await project(t, { "a.rs": "fn a() {}", "b.rs": "fn b() {}",
    "c.rs": "fn c() {}" });
  const limited = await moduleInventory(root, { maxFiles: 2 });
  assert.equal(limited.complete, false);
  assert.ok(limited.diagnostics.some((entry) => entry.includes("File limit")));
  await mkdir(path.join(root, "module.md"));
  const broken = await moduleInventory(root);
  assert.equal(broken.complete, false);
  assert.equal(broken.modules[0].status, "unreadable");
});

test("does not follow directory links outside the project", async (t) => {
  const root = await project(t, { "main.rs": "fn main() {}" });
  const external = await project(t, { "module.md": "External private boundary",
    "secret.ts": "private" });
  await symlink(external, path.join(root, "outside"),
    process.platform === "win32" ? "junction" : "dir");
  const inventory = await moduleInventory(root);
  assert.equal(inventory.sourceFiles, 1);
  assert.equal(inventory.modules.length, 1);
  await assert.rejects(moduleContext(root, "outside"), /outside project/);
});
