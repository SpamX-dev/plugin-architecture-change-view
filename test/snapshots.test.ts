import { initTestRepository, commitTestFiles } from "./support.js";
import { contractYaml, writeModuleTree } from "./support.js";
import type { TestContext } from "node:test";
/** Проверяет смысл четырёх статусов, исторические документы и базы сравнения. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { captureWorkingTree, captureGitHead, captureGitIndex } from "../analyse/git-changes/capture.js";
import { compareRepositorySnapshots, compareSnapshots } from "../analyse/git-changes/comparison.js";
import { snapshotDigest, structureHash } from "../framework/snapshots/identity.js";
import { createWorkspaceSession } from "../web/web-backend/workspace-session.js";
import { SnapshotStore } from "../analyse/git-changes/snapshot-store.js";
import { GitTreeReader } from "../analyse/git-changes/git-tree.js";
import { saveGitComparison } from "../module-operations/module-access.js";
import { fileDiff } from "../module-operations/file-diff.js";

/** Git-команды выполняются только в явно созданном временном проекте. */
const run = promisify(execFile);

/** Подготавливает изолированный проект и внешнее по отношению к нему хранилище. */
async function fixture(t: TestContext, files: Record<string, string>) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "archiview-snapshot-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "project");
  await mkdir(root);
  initTestRepository(root);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  return { root, store: path.join(temporary, "snapshots") };
}

test("the live Git tree spans HEAD to disk across the index, renames and unborn repositories", async t => {
  const { root } = await fixture(t, {
    ".gitignore": "*.tmp\n", "a/move.ts": "move\n", "a/cancel.ts": "same\n", "b/keep.ts": "keep\n",
  });
  const session = await createWorkspaceSession({ root });
  const files = async (view: string, key: string) => (await session.getModule({view, path: key, analysis: false})).files;
  const initial = await session.getComparison();
  assert.equal(initial.before.label, "Пустое дерево");
  assert.ok(initial.modules.every(module => module.status === "new"));
  commitTestFiles(root);
  await writeFile(path.join(root, "a/cancel.ts"), "staged edit\n");
  await rename(path.join(root, "a/move.ts"), path.join(root, "b/move.ts"));
  await run("git", ["add", "-A"], {cwd: root});
  await writeFile(path.join(root, "a/cancel.ts"), "same\n");
  await writeFile(path.join(root, "b/new.ts"), "new\n");
  await writeFile(path.join(root, "ignored.tmp"), "ignore\n");
  const current = await session.getComparison();
  assert.deepEqual(await files(current.id, "a"), [{path: "a/move.ts", status: "removed"}]);
  assert.deepEqual(await files(current.id, "b"), [
    {path: "b/move.ts", status: "new"}, {path: "b/new.ts", status: "new"},
  ]);
  assert.equal(current.modules.find(m => m.key === ".")!.status, "unchanged");
});

test("Git views and saved reports retain maintained build files across untracked, staged and committed states", async t => {
  const file = "build/maintained.ts";
  const { root, store } = await fixture(t, {
    ".gitignore": "*.tmp\nnode_modules/\n",
    [file]: "initial\n",
    "build/scratch.tmp": "ignored",
    "node_modules/dep/src.ts": "ignored",
    ".archiview/work/internal.ts": "private report",
    "build/child/src.ts": "foreign",
  });
  initTestRepository(path.join(root, "build/child"));
  const reader = new GitTreeReader(root, root);
  const [full, fast] = await Promise.all([captureWorkingTree(root), reader.working(null)]);
  for (const snapshot of [full, fast]) {
    assert.ok(snapshot.complete, snapshot.diagnostics.join("\n"));
    assert.deepEqual(snapshot.modules.map(m => m.directory), ["."]);
    assert.deepEqual(snapshot.modules[0].files.map(f => f.path).sort(), [".gitignore", file]);
    assert.equal(snapshot.modules[0].sourceFiles, 0);
  }
  assert.equal(full.facts.find(f => f.path === file)?.text, "initial\n");
  const repository = new SnapshotStore(root, store);
  const added = await saveGitComparison(repository, "index", "current");
  assert.deepEqual((await repository.readComparison(added.id))!.modules[0].files,
    [{ path: ".gitignore", status: "new" }, { path: file, status: "new" }]);
  const first = compareSnapshots(null, fast, { emptyTree: true }).modules[0];
  assert.deepEqual((await fileDiff(first, null, fast, file, root)).hunks[0].lines, ["+initial"]);

  const git = (args: string[]) => run("git", args, { cwd: root, windowsHide: true });
  await git(["add", "--", ".gitignore", file]);
  await writeFile(path.join(root, file), "edited\n");
  const staged = (await captureGitIndex(root))!;
  const changed = await saveGitComparison(repository, "index", "current");
  assert.deepEqual(changed.modules[0].files, [{ path: file, status: "changed" }]);
  assert.equal(staged.facts.find(f => f.path === file)?.text, "initial\n");
  await git(["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Stage build file"]);
  const committed = (await captureGitHead(root))!;
  const lightCommit = await reader.revision(committed.revision!);
  assert.deepEqual(staged.modules, committed.modules);
  assert.deepEqual(lightCommit.modules, committed.modules);
  const disk = await captureWorkingTree(root);
  assert.deepEqual((await reader.working(committed.revision!)).modules, disk.modules);
  assert.equal(disk.facts.find(f => f.path === file)?.text, "edited\n");
  await rm(path.join(root, file));
  assert.deepEqual((await saveGitComparison(repository)).modules[0].files, [{ path: file, status: "removed" }]);
});

test("compares new, changed, removed and old modules without changing parent status", async (t) => {
  const { root } = await fixture(t, {
    ".archiview/modules.tree": "gone: src/gone\n",
    ".archiview/modules/gone.yaml": contractYaml("gone", "Historical responsibility"),
    "src/keep/code.js": "export const x = 1;",
    "src/change/code.js": "export const x = 1;",
    "src/gone/code.js": "export const x = 1;",
  });
  const before = await captureWorkingTree(root);
  await writeFile(path.join(root, "src/change/code.js"), "export const x = 2;");
  await rm(path.join(root, "src/gone"), { recursive: true });
  await mkdir(path.join(root, "src/new"));
  await writeModuleTree(root, { added: "src/new" });
  await rm(path.join(root, ".archiview/modules/gone.yaml"));
  await writeFile(path.join(root, ".archiview/modules/added.yaml"), contractYaml("added"));
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
  assert.equal(modules.get("src/gone")!.before!.document.text, contractYaml("gone", "Historical responsibility"));
  assert.equal(modules.get("src/gone")!.after, null);
});

test("removing a colocated description changes the file diff without changing the module contract", async (t) => {
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
  assert.equal(source!.documentChanged, false);
  assert.deepEqual(source!.files.map((file) => [file.path, file.status]), [
    ["src/module.md", "removed"], ["src/settings.json", "changed"],
  ]);
  assert.equal(before.modules.find((module) => module.directory === "src")!.document.text, null);
});

test("a nested checkout takes ownership of formerly tracked sources without changing the parent's Git history", async (t) => {
  const { root } = await fixture(t, {
    "parent.ts": "", "child/src/index.ts": "old source",
    ".archiview/modules.tree": "app: .\nlibrary: child/src\n",
    ".archiview/modules/app.yaml": contractYaml("app"),
    ".archiview/modules/library.yaml": contractYaml("library"),
  });
  const git = (cwd: string, args: string[]) => run("git", args, { cwd, windowsHide: true });
  await git(root, ["init", "-q"]);
  await git(root, ["add", "."]);
  await git(root, ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "Parent revision"]);
  const child = path.join(root, "child");
  await git(child, ["init", "-q"]);
  await writeFile(path.join(child, "src/index.ts"), "new child source");
  await writeModuleTree(child, { library: "src" });
  await writeFile(path.join(child, ".archiview/modules/library.yaml"), contractYaml("library", "Child's contract"));
  const staleMap = await captureWorkingTree(root);
  assert.equal(staleMap.complete, false);
  assert.ok(staleMap.diagnostics.some(message => message.includes("child/src") && message.includes("modules.tree")));
  assert.ok(!staleMap.modules.some(module => module.directory.startsWith("child")));
  assert.ok(!staleMap.facts.some(fact => fact.path.startsWith("child/")));
  await writeModuleTree(root, { app: "." });
  await rm(path.join(root, ".archiview/modules/library.yaml"));
  const parent = await captureWorkingTree(root);
  assert.equal(parent.complete, true, parent.diagnostics.join("\n"));
  assert.deepEqual(parent.modules.map(m => m.directory), ["."]);
  const historical = await captureGitHead(root);
  assert.equal(historical?.modules.find(m => m.directory === "child/src")?.document.contract?.id, "library");
  assert.equal(historical?.facts.find(f => f.path === "child/src/index.ts")?.text, "old source");
  const current = await captureWorkingTree(child);
  assert.equal(current.modules.find(m => m.directory === "src")?.document.contract?.purpose, "Child's contract");
  assert.equal(current.facts.find(f => f.path === "src/index.ts")?.text, "new child source");
});

test("moving a child counts it once for each old, new and shared ancestor", async (t) => {
  const { root } = await fixture(t, {
    "left/code.ts": "", "right/code.ts": "",
    ".archiview/modules.tree": "child: left/child\n",
    ".archiview/modules/child.yaml": "schema_version: 1\nid: child\ntitle: Child\nkind: module\npurpose: Read\nboundaries: {}\ninvariants: {}\n",
    "left/child/code.ts": "",
  });
  const before = await captureWorkingTree(root);
  await rename(path.join(root, "left/child"), path.join(root, "right/child"));
  await writeModuleTree(root, { child: "right/child" });
  const { modules } = compareSnapshots(before, await captureWorkingTree(root));
  assert.equal(modules.find((module) => module.moduleId === "child")?.moved, true);
  for (const directory of ["left", "right", "."]) {
    assert.equal(modules.find((module) => module.directory === directory)?.descendantChanges, 1, directory);
  }
});

test("HEAD, staged tree and working tree each resolve contracts from their own layout", async (t) => {
  const document = "schema_version: 1\nid: child\ntitle: Child\nkind: module\npurpose: Read\nboundaries: {}\ninvariants: {}\n";
  const { root } = await fixture(t, {
    "original/arch.yaml": document,
    "original/value.ts": "export const value = 1;",
  });
  const git = (args: string[]) => run("git", args, { cwd: root, windowsHide: true });
  await git(["init", "-q"]);
  await git(["add", "."]);
  await git(["-c", "user.name=Snapshot Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "Old layout"]);

  await writeModuleTree(root, { child: "staged" });
  await rename(path.join(root, "original/arch.yaml"), path.join(root, ".archiview/modules/child.yaml"));
  await rename(path.join(root, "original"), path.join(root, "staged"));
  await git(["add", "-A"]);
  await rename(path.join(root, "staged"), path.join(root, "working"));
  await writeModuleTree(root, { child: "working" });
  const centralPath = ".archiview/modules/child.yaml";
  const historical = await captureGitHead(root);
  assert.equal(historical?.modules.find((item) => item.directory === "original")?.document.state, "missing");
  assert.ok(!historical?.modules.some((item) => item.document.contract?.id === "child"));
  for (const [snapshot, directory, documentPath] of [
    [await captureGitIndex(root), "staged", centralPath],
    [await captureWorkingTree(root), "working", centralPath],
  ] as const) {
    assert.ok(snapshot);
    assert.equal(snapshot.complete, true, snapshot.diagnostics.join("\n"));
    const module = snapshot.modules.find((item) => item.document.contract?.id === "child");
    assert.equal(module?.directory, directory);
    assert.equal(module.documentPath, documentPath);
    assert.equal(module.document.state, "documented");
    assert.equal(module.document.text, document);
  }
});

test("a working file replaced during Git normalization keeps a matching hash and fact", async (t) => {
  const before = "export const value = 1;\n", after = "export const value = 2;\n";
  const { root } = await fixture(t, { ".gitattributes": "source.js filter=capture\n", "source.js": before });
  await run("git", ["init", "-q"], { cwd: root });
  await writeFile(path.join(root, "../clean.cjs"), [
    "require('node:fs').writeFileSync('source.js', " + JSON.stringify(after) + ");",
    "process.stdin.pipe(process.stdout);",
  ].join("\n"));
  await run("git", ["config", "filter.capture.clean", "node ../clean.cjs"], { cwd: root });
  const working = await captureWorkingTree(root);
  assert.equal(working.complete, true, working.diagnostics.join("\n"));
  assert.equal(await readFile(path.join(root, "source.js"), "utf8"), after);
  const fact = working.facts.find((item) => item.path === "source.js");
  assert.equal(fact?.text, before);
  const expected = createHash("sha1").update("blob " + Buffer.byteLength(before) + "\0").update(before).digest("hex");
  assert.equal(working.modules[0].files.find((file) => file.path === "source.js")?.hash, expected);
});

test("a new module without a mapped contract does not claim a document change", async (t) => {
  const { root } = await fixture(t, { "root.ts": "" });
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
    ".gitattributes": "* text=auto eol=lf\n", ".archiview/modules.tree": "root: .\nsrc: src\n",
    ".archiview/modules/root.yaml": contractYaml("root"), ".archiview/modules/src.yaml": contractYaml("src"),
    "src/main.js": "export const main = 1;\n",
    "skills/example/SKILL.md": "Version one\n",
  });
  await run("git", ["init", "--quiet", "--initial-branch=main"], { cwd: root, windowsHide: true });
  assert.equal(await captureGitHead(root), null);
  await run("git", ["add", "."], { cwd: root, windowsHide: true });
  await run("git", ["-c", "user.name=ArchiView Test", "-c", "user.email=archiview@example.invalid",
    "-c", "commit.gpgsign=false", "-c", "core.hooksPath=" + path.join(root, "no-hooks"),
    "commit", "--quiet", "-m", "Baseline"], { cwd: root, windowsHide: true });
  const before = await captureGitHead(root);
  await writeFile(path.join(root, "src/main.js"), "export const main = 1;\r\n");
  await writeFile(path.join(root, ".archiview/modules/src.yaml"), contractYaml("src").replaceAll("\n", "\r\n"));
  const current = await captureWorkingTree(root);
  assert.ok(compareSnapshots(before, current).modules.every((module) => module.status === "unchanged"));
  for (const snapshot of [before!, current]) {
    assert.ok(!snapshot.modules.some((module) => module.directory.startsWith("skills")));
  }
  const nested = await captureGitHead(path.join(root, "src"));
  assert.equal(nested!.modules.length, 1);
  assert.equal(nested!.modules[0].document.state, "missing");
  await rm(path.join(root, "src"), { recursive: true });
  await writeModuleTree(root, { root: "." });
  await rm(path.join(root, ".archiview/modules/src.yaml"));
  const gone = compareSnapshots(before, await captureWorkingTree(root))
    .modules.find((module) => module.directory === "src");
  assert.equal(gone!.status, "removed");
  assert.equal(gone!.before!.document.text, contractYaml("src"));
});

test("Git modes are captured uniformly so an unchanged executable keeps its identity", async (t) => {
  const { root } = await fixture(t, {
    ".archiview/modules.tree": "root: .\n",
    ".archiview/modules/root.yaml": contractYaml("root"),
    "scripts/run.sh": "#!/bin/sh\necho run\n",
  });
  const git = (args: string[]) => run("git", args, { cwd: root, windowsHide: true });
  if (process.platform !== "win32") await chmod(path.join(root, "scripts/run.sh"), 0o755);
  await git(["add", "."]);
  // Windows cannot store the executable bit, so the index records the mode Git would keep.
  await git(["update-index", "--chmod=+x", "scripts/run.sh"]);
  await git(["-c", "user.name=Mode Test", "-c", "user.email=mode@example.invalid", "commit", "-qm", "Executable"]);
  const head = await captureGitHead(root);
  const working = await captureWorkingTree(root);
  const record = (snapshot: NonNullable<typeof head>) => snapshot.modules
    .flatMap((module) => module.files).find((file) => file.path === "scripts/run.sh");
  assert.equal(record(head!)?.mode, "100755");
  assert.equal(record(working)?.mode, "100755");
  assert.equal(head!.digest, working.digest);
  assert.ok(compareSnapshots(head, working).modules.every((module) => module.status === "unchanged"));
  // The earliest writer omitted even 100755. The archived commit still identifies the real mode.
  const legacy = structuredClone(head!);
  for (const module of legacy.modules) for (const file of module.files) delete file.mode;
  assert.ok(compareSnapshots(legacy, working).modules.every((module) => module.status === "unchanged"));
  const restored = await compareRepositorySnapshots(root, legacy, working);
  assert.ok(restored.modules.every((module) => module.status === "unchanged"));
  assert.deepEqual(restored.diagnostics, []);
});

test("archived Git modes report executable-only changes in either direction and expose unavailable evidence", async t => {
  const { root, store } = await fixture(t, { "tool.js": "console.log(1);\n", "marker.js": "console.log(2);\n" });
  commitTestFiles(root);
  await run("git", ["update-index", "--chmod=+x", "marker.js"], { cwd: root });
  const legacy = await captureGitIndex(root);
  assert.ok(legacy);
  const sparse = structuredClone(legacy);
  for (const module of sparse.modules) for (const file of module.files) if (file.mode === "100644") delete file.mode;
  for (const module of legacy.modules) {
    for (const file of module.files) delete file.mode;
    module.fingerprint = structureHash(JSON.stringify(module.files));
  }
  legacy.digest = snapshotDigest(legacy);
  const archives = new SnapshotStore(root, store);
  await archives.save(legacy);
  const [saved] = await archives.list();
  await run("git", ["update-index", "--chmod=+x", "tool.js"], { cwd: root });
  const executable = await captureGitIndex(root);
  assert.ok(executable);
  assert.deepEqual(compareSnapshots(sparse, executable).modules.flatMap(m => m.files), [{ path: "tool.js", status: "changed" }]);

  for (const [left, right] of [[saved, executable], [executable, saved]]) {
    const result = await compareRepositorySnapshots(root, left, right);
    assert.deepEqual(result.modules.flatMap(m => m.files), [{ path: "tool.js", status: "changed" }]);
    assert.deepEqual(result.diagnostics, []);
  }
  assert.equal(saved.digest, snapshotDigest(saved));
  // The archive remains readable after transfer without the Git object.
  const unavailable = await compareRepositorySnapshots(store, saved, executable);
  assert.deepEqual(unavailable.modules.flatMap(m => m.files), []);
  assert.match(unavailable.diagnostics.join("\n"), /исполняемого бита.*tool\.js/);
  // A working-tree archive's baseRevision does not supply its file mode.
  const working = { ...saved, kind: "change", revision: undefined, baseRevision: legacy.revision };
  const unknown = await compareRepositorySnapshots(root, working, executable);
  assert.deepEqual(unknown.modules.flatMap(m => m.files), []);
  assert.match(unknown.diagnostics.join("\n"), /исполняемого бита.*tool\.js/);
});

for (const fileMode of ["true", "false", "default"]) {
  test("unborn and untracked modes match git add with core.fileMode " + fileMode, async t => {
    const { root } = await fixture(t, { "staged.js": "staged\n", "owner.js": "owner\n", "other.js": "other\n" });
    const git = (args: string[]) => run("git", args, { cwd: root, windowsHide: true });
    if (fileMode === "default") await git(["config", "--unset-all", "core.fileMode"]);
    else await git(["config", "core.fileMode", fileMode]);
    await chmod(path.join(root, "owner.js"), 0o744);
    await chmod(path.join(root, "other.js"), 0o655);
    await chmod(path.join(root, "staged.js"), 0o644);
    await git(["add", "--", "staged.js"]);
    await git(["update-index", "--chmod=+x", "staged.js"]);

    const full = await captureWorkingTree(root);
    const fast = await new GitTreeReader(root, root).working(null);
    await git(["add", "-A"]);
    const { stdout } = await git(["ls-files", "--stage", "-z"]);
    const expected = Object.fromEntries(stdout.split("\0").filter(Boolean).map(row =>
      [row.slice(row.indexOf("\t") + 1), row.split(" ", 1)[0]]));
    for (const snapshot of [full, fast]) {
      assert.deepEqual(snapshot.diagnostics, []);
      const modes = Object.fromEntries(snapshot.modules.flatMap(module => module.files.map(file => [file.path, file.mode])));
      assert.deepEqual(modes, expected);
    }
  });
}

test("saving a selected tree rejects a mode-only change before full evidence capture", async t => {
  const { root } = await fixture(t, { "tool.js": "console.log(1);\n" });
  commitTestFiles(root);
  const session = await createWorkspaceSession({ root });
  t.after(() => session.close());
  const selected = await session.getComparison();
  const readWorking = GitTreeReader.prototype.working;
  t.mock.method(GitTreeReader.prototype, "working", async function(this: GitTreeReader, head: string | null) {
    const tree = await readWorking.call(this, head);
    if (process.platform !== "win32") await chmod(path.join(root, "tool.js"), 0o755);
    await run("git", ["update-index", "--chmod=+x", "tool.js"], { cwd: root });
    return tree;
  });
  await assert.rejects(session.saveSnapshot({ view: selected.id }), { code: "STALE_VIEW" });
});

test("a working tree executable bit change is reported between working snapshots",
  { skip: process.platform === "win32" }, async (t) => {
  const { root } = await fixture(t, { "tool.js": "export const tool = 1;\n" });
  commitTestFiles(root);
  const before = await captureWorkingTree(root);
  await chmod(path.join(root, "tool.js"), 0o755);
  const after = await captureWorkingTree(root);
  assert.equal(after.modules[0].files.find((file) => file.path === "tool.js")?.mode, "100755");
  assert.equal(compareSnapshots(before, after).modules.find((module) => module.directory === ".")?.status, "changed");
});

test("a large filtered working file keeps the commit hash without text evidence", async (t) => {
  const { root } = await fixture(t, { ".gitattributes": "*.dat text eol=lf\n" });
  await writeFile(path.join(root, "big.dat"), ("value = 1\n".repeat(60000)).replaceAll("\n", "\r\n"));
  commitTestFiles(root);
  const head = await captureGitHead(root);
  const working = await captureWorkingTree(root);
  const record = (snapshot: NonNullable<typeof head>) => snapshot.modules
    .flatMap((module) => module.files).find((file) => file.path === "big.dat");
  assert.ok((await stat(path.join(root, "big.dat"))).size > 256 * 1024);
  assert.equal(record(head!)?.hash, record(working)?.hash);
  assert.equal(working.facts.some((fact) => fact.path === "big.dat"), false);
  assert.ok(working.evidenceLimitations.some((line) => line.startsWith("big.dat:")));
  assert.ok(compareSnapshots(head, working).modules.every((module) => module.status === "unchanged"));
});

test("persists immutable documents outside source and refuses incomplete snapshots", async (t) => {
  const { root, store } = await fixture(t, {
    ".archiview/modules.tree": "root: .\n",
    ".archiview/modules/root.yaml": contractYaml("root", "Root boundary"), "code.js": "export const value = 1;",
  });
  const storage = new SnapshotStore(root, store);
  const snapshot = await captureWorkingTree(root);
  const saved = await storage.save(snapshot, "Accepted architecture");
  await writeFile(path.join(root, ".archiview/modules/root.yaml"), contractYaml("root", "Changed boundary"));
  const [loaded] = await storage.list();
  assert.equal(loaded.id, saved.id);
  assert.equal(loaded.modules[0].document.text, contractYaml("root", "Root boundary"));
  assert.equal(loaded.label, "Accepted architecture");
  assert.throws(() => new SnapshotStore(root, path.join(root, "cache")), /outside/);
  await assert.rejects(storage.save({ ...snapshot, complete: false }), /Invalid/);
  await assert.rejects(storage.save({ ...snapshot, root: root + "-other" }), /foreign/);
  assert.ok((await readFile(path.join(store, "snapshots", saved.id + ".yaml"), "utf8")).includes("Root boundary"));
});
