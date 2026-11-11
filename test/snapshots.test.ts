import type { TestContext } from "node:test";
/** Проверяет смысл четырёх статусов, исторические документы и базы сравнения. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { captureWorkingTree, captureGitHead } from "../src/snapshots/capture.js";
import { compareSnapshots } from "../src/snapshots/comparison.js";
import { SnapshotStore } from "../src/storage/snapshot-store.js";

/** Git-команды выполняются только в явно созданном временном проекте. */
const run = promisify(execFile);

/** Подготавливает изолированный проект и внешнее по отношению к нему хранилище. */
async function fixture(t: TestContext, files: Record<string, string>) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "archiview-snapshot-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "project");
  await mkdir(root);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  return { root, store: path.join(temporary, "snapshots") };
}

test("compares new, changed, removed and old modules without changing parent status", async (t) => {
  const { root } = await fixture(t, {
    "module.md": "Project", "src/module.md": "Source",
    "src/keep/module.md": "Keep", "src/keep/code.js": "export const x = 1;",
    "src/change/module.md": "Change", "src/change/code.js": "export const x = 1;",
    "src/gone/module.md": "Historical responsibility", "src/gone/code.js": "export const x = 1;",
  });
  const before = await captureWorkingTree(root);
  await writeFile(path.join(root, "src/change/code.js"), "export const x = 2;");
  await rm(path.join(root, "src/gone"), { recursive: true });
  await mkdir(path.join(root, "src/new"));
  await writeFile(path.join(root, "src/new/module.md"), "New responsibility");
  await writeFile(path.join(root, "src/new/code.js"), "export const x = 1;");
  const comparison = compareSnapshots(before, await captureWorkingTree(root));
  const modules = new Map(comparison.modules.map((module) => [module.directory, module]));
  assert.equal(comparison.complete, true);
  assert.equal(modules.get("src/new")!.status, "new");
  assert.equal(modules.get("src/change")!.status, "changed");
  assert.equal(modules.get("src/gone")!.status, "removed");
  assert.equal(modules.get("src/keep")!.status, "unchanged");
  assert.equal(modules.get("src")!.status, "unchanged");
  assert.equal(modules.get("src")!.descendantChanges, 3);
  assert.equal(modules.get("src/change")!.documentChanged, false);
  assert.equal(modules.get("src/gone")!.before!.document.text, "Historical responsibility");
  assert.equal(modules.get("src/gone")!.after, null);
});

test("removing only module.md leaves a changed module with a missing document", async (t) => {
  const { root } = await fixture(t, {
    "src/module.md": "Responsibility", "src/code.ts": "export const code = true;",
    "src/settings.json": "{}",
  });
  const before = await captureWorkingTree(root);
  await rm(path.join(root, "src/module.md"));
  await writeFile(path.join(root, "src/settings.json"), '{"changed":true}');
  const view = compareSnapshots(before, await captureWorkingTree(root));
  const source = view.modules.find((module) => module.directory === "src");
  assert.equal(source!.status, "changed");
  assert.equal(source!.documentState, "missing");
  assert.equal(source!.documentChanged, true);
  assert.deepEqual(source!.files.map((file) => [file.path, file.status]), [
    ["src/module.md", "removed"], ["src/settings.json", "changed"],
  ]);
  assert.equal(before.modules.find((module) => module.directory === "src")!.document.text,
    "Responsibility");
});

test("a new module without module.md does not claim a document change", async (t) => {
  const { root } = await fixture(t, { "module.md": "Root" });
  const before = await captureWorkingTree(root);
  await mkdir(path.join(root, "undocumented"));
  await writeFile(path.join(root, "undocumented/code.js"), "export const x = 1;");
  const module = compareSnapshots(before, await captureWorkingTree(root)).modules
    .find((entry) => entry.directory === "undocumented");
  assert.equal(module!.status, "new");
  assert.equal(module!.documentState, "missing");
  assert.equal(module!.documentChanged, false);
});

test("Git HEAD restores historical modules and respects Git CRLF normalization", async (t) => {
  const { root } = await fixture(t, {
    ".gitattributes": "* text=auto eol=lf\n", "module.md": "Root\n",
    "src/module.md": "Source\n", "src/main.js": "export const main = 1;\n",
  });
  await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root, windowsHide: true });
  assert.equal(await captureGitHead(root), null);
  await run("git", ["add", "."], { cwd: root, windowsHide: true });
  await run("git", ["-c", "user.name=ArchiView Test", "-c", "user.email=archiview@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=" + path.join(root, "no-hooks"),
    "commit", "--quiet", "-m", "Baseline"], { cwd: root, windowsHide: true });
  const before = await captureGitHead(root);
  await writeFile(path.join(root, "src/main.js"), "export const main = 1;\r\n");
  await writeFile(path.join(root, "src/module.md"), "Source\r\n");
  const current = await captureWorkingTree(root);
  assert.ok(compareSnapshots(before, current).modules.every((module) => module.status === "unchanged"));
  const nested = await captureGitHead(path.join(root, "src"));
  assert.equal(nested!.modules.length, 1);
  assert.equal(nested!.modules[0].document.text, "Source\n");
  await rm(path.join(root, "src"), { recursive: true });
  const gone = compareSnapshots(before, await captureWorkingTree(root))
    .modules.find((module) => module.directory === "src");
  assert.equal(gone!.status, "removed");
  assert.equal(gone!.before!.document.text, "Source\n");
});

test("persists immutable documents outside source and refuses incomplete snapshots", async (t) => {
  const { root, store } = await fixture(t, {
    "module.md": "Root boundary", "code.js": "export const value = 1;",
  });
  const storage = new SnapshotStore(root, store);
  const snapshot = await captureWorkingTree(root);
  const saved = await storage.save(snapshot, "Accepted architecture");
  await writeFile(path.join(root, "module.md"), "Changed boundary");
  const [loaded] = await storage.list();
  assert.equal(loaded.id, saved.id);
  assert.equal(loaded.modules[0].document.text, "Root boundary");
  assert.equal(loaded.label, "Accepted architecture");
  assert.throws(() => new SnapshotStore(root, path.join(root, "cache")), /outside/);
  await assert.rejects(storage.save({ ...snapshot, complete: false }), /Invalid/);
  await assert.rejects(storage.save({ ...snapshot, root: root + "-other" }), /foreign/);
  assert.ok((await readFile(path.join(store, "snapshots", saved.id + ".yaml"), "utf8")).includes("Root boundary"));
});
