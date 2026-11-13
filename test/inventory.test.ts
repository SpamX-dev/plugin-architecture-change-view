import { contractYaml, writeModuleTree } from "./support.js";
import type { TestContext } from "node:test";
/** Проверки покрытия исходников, цепочки контрактов и ограничения корня. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { moduleContext, moduleInventory } from "../src/contracts/inventory.js";
import { discoverWorkspaceRepositories, resolveWorkspaceRepository } from "../src/project/workspace.js";

/** Запускает Git без оболочки в изолированном тестовом репозитории. */
const runFile = promisify(execFile);

/** Создаёт временный проект с автоматической уборкой только его каталога. */
async function project(t: TestContext, files: Record<string, string>, repository = true) {
  const root = await mkdtemp(path.join(os.tmpdir(), "architecture-change-view-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  if (repository) await runFile("git", ["init", "-q", root]);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  return root;
}

test("covers each source directory and its containers; retains planned modules", async (t) => {
  const root = await project(t, {
    ".archiview/modules.tree": "root: .\nsrc: src\nempty: src/empty\nplanned: future\n",
    ".archiview/modules/root.yaml": contractYaml("root"),
    ".archiview/modules/src.yaml": contractYaml("src"),
    "src/main.ts": "export const main = 1;",
    "src/domain/order.ts": "export class Order {}",
    "src/empty/run.py": "pass", ".archiview/modules/empty.yaml": "  \n",
    "test/check.js": "export const check = true;",
    "future/README.md": "Project plan", ".archiview/modules/planned.yaml": contractYaml("planned"),
    "node_modules/dependency/index.js": "ignored",
    "dist/bundle.js": "ignored", "docs/README.md": "prose",
  });
  const result = await moduleInventory(root);
  const modules = new Map(result.modules.map((entry) => [entry.directory, entry]));
  assert.equal(result.complete, true);
  assert.equal(result.sourceFiles, 4);
  assert.deepEqual([...modules.keys()].sort(),
    [".", "future", "src", "src/domain", "src/empty", "test"].sort());
  assert.equal(modules.get(".")!.sourceFiles, 4);
  assert.equal(modules.get("src")!.sourceFiles, 3);
  assert.equal(modules.get("src/domain")!.status, "missing");
  assert.equal(modules.get("src/empty")!.status, "empty");
  assert.equal(modules.get("future")!.required, false);
  assert.equal(modules.get("future")!.status, "documented");
});

test("reads root-to-target contracts without hiding a missing child description", async (t) => {
  const root = await project(t, {
    ".archiview/modules.tree": "root: .\nsrc: src\n",
    ".archiview/modules/root.yaml": contractYaml("root"),
    ".archiview/modules/src.yaml": contractYaml("src"),
    "src/domain/order.ts": "class Order {}",
  });
  const context = await moduleContext(root, "src/domain");
  assert.deepEqual(context.contracts.map((entry) => entry.directory),
    [".", "src", "src/domain"]);
  assert.equal(context.contracts[0].text, contractYaml("root"));
  assert.equal(context.contracts[1].text, contractYaml("src"));
  assert.equal(context.contracts[2].status, "missing");
  assert.equal(await readFile(path.join(root, "src/domain/order.ts"), "utf8"),
    "class Order {}");
  await assert.rejects(moduleContext(root, "../"), /outside project/);
  await assert.rejects(moduleContext(root, root), /must be relative/);
});

test("a resource contract includes its skill directory without including other skills", async (t) => {
  const root = await project(t, {
    "skills/example/SKILL.md": "# Instructions",
    "skills/other/SKILL.md": "# Other instructions",
  });
  assert.deepEqual((await moduleInventory(root)).modules, []);
  await writeModuleTree(root, { example: "skills/example" });
  await writeFile(path.join(root, ".archiview/modules/example.yaml"), [
    "schema_version: 1", "id: example", "title: Example", "kind: module",
    "purpose: Provide instructions", "responsibilities: { R1: Define the instructions }",
    "boundaries: {}", "invariants: {}", "extensions: { archiview.roles: [resources] }",
  ].join("\n"));
  const inventory = await moduleInventory(root);
  assert.equal(inventory.sourceFiles, 0);
  assert.deepEqual(inventory.modules.map(({ directory }) => directory), [".", "skills", "skills/example"]);
  const skill = inventory.modules.find(({ directory }) => directory === "skills/example");
  assert.deepEqual(skill?.contract?.extensions?.["archiview.roles"], ["resources"]);
});

test("flat contracts are returned in ancestry order and colocated files do not register modules", async (t) => {
  const root = await project(t, {
    ".archiview/modules.tree": "leaf: src/models\napp: .\ncontainer: src\n",
    ".archiview/modules/app.yaml": contractYaml("app"),
    ".archiview/modules/container.yaml": contractYaml("container"),
    ".archiview/modules/leaf.yaml": contractYaml("leaf"),
    "src/models/record.ts": "",
    "old/arch.yaml": contractYaml("old"), "old/module.md": "Former module.",
  });
  const context = await moduleContext(root, "src/models");
  assert.deepEqual(context.contracts.map(({ directory, document, contract }) => [directory, document, contract?.id]), [
    [".", ".archiview/modules/app.yaml", "app"],
    ["src", ".archiview/modules/container.yaml", "container"],
    ["src/models", ".archiview/modules/leaf.yaml", "leaf"],
  ]);
  const old = (await moduleContext(root, "old")).contracts.at(-1)!;
  assert.equal(old.status, "missing");
  assert.equal(old.contract ?? null, null);
  assert.ok(!(await moduleInventory(root)).modules.some((entry) => entry.directory === "old"));
});

test("inventory reports ambiguous module paths, duplicate ids and unmapped contract files", async (t) => {
  const root = await project(t, { "src/main.ts": "", ".archiview/modules.tree": "first: src\nsecond: src\n" });
  const tree = path.join(root, ".archiview/modules.tree");
  for (const content of ["first: src\nsecond: src\n", "first: src\nfirst: .\n"]) {
    await writeFile(tree, content);
    const inventory = await moduleInventory(root);
    assert.equal(inventory.complete, false);
    assert.ok(inventory.diagnostics.length > 0);
    await assert.rejects(moduleContext(root, "src"));
  }
  await writeModuleTree(root, {});
  await writeFile(path.join(root, ".archiview/modules/abandoned.yaml"), "orphan");
  const inventory = await moduleInventory(root);
  assert.equal(inventory.complete, false);
  assert.ok(inventory.diagnostics.some((message) => message.includes("abandoned.yaml")));
});

test("requires the Git spelling for mapped source directories and contract filenames", async (t) => {
  const root = await project(t, {
    ".archiview/modules.tree": "main: SRC\nModel: model\n",
    ".archiview/modules/main.yaml": contractYaml("main"),
    ".archiview/modules/model.yaml": contractYaml("Model"),
    "src/main.ts": "",
    "model/run.ts": "",
  });
  const inventory = await moduleInventory(root);
  assert.equal(inventory.complete, false);
  const states = new Map(inventory.modules.map((m) => [m.directory, m.status]));
  assert.equal(states.get("SRC"), "unreadable");
  assert.equal(states.get("src"), "missing");
  assert.equal(states.get("model"), "missing");
  assert.ok(inventory.diagnostics.some((line) => line.includes("model.yaml") && line.includes("not registered")));
  assert.equal((await moduleContext(root, "model")).contracts.at(-1)?.status, "missing");
  assert.equal((await moduleContext(root, "src")).contracts.at(-1)?.status, "missing");
});

test("invalid UTF-8 in the map or contract makes the inventory incomplete", async (t) => {
  const files = { ".archiview/modules.tree": "app: .\n", ".archiview/modules/app.yaml": contractYaml("app") };
  const root = await project(t, { "main.ts": "", ...files });
  for (const [file, valid] of Object.entries(files)) {
    await writeFile(path.join(root, file), Buffer.concat([Buffer.from(valid + "# "), Buffer.from([0xff])]));
    const inventory = await moduleInventory(root);
    assert.equal(inventory.complete, false);
    assert.ok(inventory.diagnostics.some((message) => message.includes("UTF-8")), inventory.diagnostics.join("\n"));
    await assert.rejects(moduleContext(root), /UTF-8/);
    await writeFile(path.join(root, file), valid);
  }
});

test("central contract storage rejects a linked modules directory", async (t) => {
  const root = await project(t, { "main.ts": "", ".archiview/modules.tree": "app: .\n" });
  const external = await project(t, { "app.yaml": contractYaml("app") });
  await symlink(external, path.join(root, ".archiview/modules"), process.platform === "win32" ? "junction" : "dir");
  const inventory = await moduleInventory(root);
  assert.equal(inventory.complete, false);
  assert.equal(inventory.modules[0].status, "unreadable");
  await assert.rejects(moduleContext(root));
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
  await writeModuleTree(root, { root: "." });
  await mkdir(path.join(root, ".archiview/modules/root.yaml"));
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

test("context uses the same directory exclusions as source discovery", async (t) => {
  const root = await project(t, { "src/main.ts": "", "dist/js/main.ts": "", ".archiview/work/data.ts": "" });
  for (const directory of ["dist/js", ".archiview/work"]) {
    await assert.rejects(moduleContext(root, directory), /excluded/);
  }
  await symlink(path.join(root, "dist"), path.join(root, "generated"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(moduleContext(root, "generated/js"), /excluded/);
});

test("an unreadable contract entry requires repair even in a planned directory", async (t) => {
  const root = await project(t, { "main.ts": "" });
  await mkdir(path.join(root, "planned"));
  await writeModuleTree(root, { root: ".", planned: "planned" });
  for (const id of ["root", "planned"]) {
    await mkdir(path.join(root, ".archiview/modules", id + ".yaml"));
  }
  const inventory = await moduleInventory(root);
  assert.equal(inventory.complete, false);
  assert.deepEqual(inventory.modules.map(({ directory, status, preparation }) => [directory, status, preparation]),
    [[".", "unreadable", "repair"], ["planned", "unreadable", "repair"]]);
});

test("a workspace routes existing and new source files to their own checkout", async (t) => {
  const root = await project(t, { "README.md": "Workspace notes", "abandoned/.git": "broken worktree pointer",
    "apps/left/src/file.ts": "left", "right/src/file.ts": "right", "dist/generated/x.ts": "ignored" }, false);
  for (const repository of ["apps/left", "right", "dist/generated"]) {
    const directory = path.join(root, repository);
    await runFile("git", ["init", "--quiet"], { cwd: directory });
    await writeModuleTree(directory, { app: ".", component: "src" });
    for (const id of ["app", "component"])
      await writeFile(path.join(directory, ".archiview/modules", id + ".yaml"), contractYaml(id, repository));
  }
  const inventory = await moduleInventory(root);
  assert.deepEqual(inventory.repositories, ["apps/left", "right"]);
  assert.equal(inventory.complete, true, inventory.diagnostics.join("\n"));
  assert.deepEqual(inventory.modules.filter(m => m.contract?.id === "component").map(m => [
    m.repository, m.directory, m.document, m.files, m.contract?.purpose,
  ]), [
    ["apps/left", "apps/left/src", "apps/left/.archiview/modules/component.yaml", ["apps/left/src/file.ts"], "apps/left"],
    ["right", "right/src", "right/.archiview/modules/component.yaml", ["right/src/file.ts"], "right"],
  ]);
  const limited = await moduleInventory(root, { maxFiles: 1 });
  assert.deepEqual(limited.repositories, inventory.repositories);
  assert.equal(limited.complete, false);
  assert.equal(limited.sourceFiles, 1);
  assert.ok(limited.diagnostics.some(message => message.includes("File limit")));
  for (const file of ["apps/left/src/file.ts", "apps/left/src/new.ts", "right/src/new-file"]) {
    const result = await moduleContext(root, file);
    assert.equal(result.directory, "src");
    assert.ok(result.contracts.every(m => m.contract?.purpose === result.repository));
    assert.deepEqual(result.contracts.map(m => m.contract?.id), ["app", "component"]);
  }
  const planned = await moduleContext(root, "right/src/new/entry.ts");
  assert.deepEqual(planned.contracts.map(m => m.status), ["documented", "documented", "missing"]);
  await assert.rejects(moduleContext(root), /choose a repository/i);
  await assert.rejects(moduleContext(root, "README.md"), /outside the workspace repositories/);
  await assert.rejects(resolveWorkspaceRepository(root, "dist/generated"), /excluded/);
  await assert.rejects(resolveWorkspaceRepository(root, "../"), /outside project/);
  assert.equal(await resolveWorkspaceRepository(root, "right"), planned.root);
});

test("nested checkouts and linked worktrees retain independent roots", async (t) => {
  const root = await project(t, { "parent/src/index.ts": "", "parent/libs/child/src/main.ts": "" }, false);
  const parent = path.join(root, "parent"), child = path.join(parent, "libs/child");
  const git = (cwd: string, args: string[]) => runFile("git", args, { cwd, windowsHide: true });
  for (const directory of [parent, child]) {
    await git(directory, ["init", "-q"]);
    await writeModuleTree(directory, { app: "." });
    await writeFile(path.join(directory, ".archiview/modules/app.yaml"), contractYaml("app", path.basename(directory)));
  }
  await git(parent, ["add", "src", ".archiview"]);
  await git(parent, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "parent"]);
  await git(parent, ["worktree", "add", "--quiet", "--detach", path.join(root, "linked")]);
  assert.deepEqual(await discoverWorkspaceRepositories(root), ["linked", "parent", "parent/libs/child"]);
  const result = await moduleInventory(parent);
  assert.equal(result.sourceFiles, 2);
  assert.deepEqual(result.repositories, [".", "libs/child"]);
  assert.equal((await moduleContext(parent, "libs/child/src/main.ts")).contracts[0].contract?.purpose, "child");
  assert.equal((await moduleContext(root, "linked/src/index.ts")).repository, "linked");
  await writeFile(path.join(parent, "libs/shared.ts"), "");
  const subtree = path.join(parent, "libs");
  assert.deepEqual(await discoverWorkspaceRepositories(subtree), [".", "child"]);
  assert.equal((await moduleContext(subtree, "shared.ts")).contracts[0].status, "missing");
});
