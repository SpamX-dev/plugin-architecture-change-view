import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, rmdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureGitHead, captureGitIndex, captureWorkingTree, readGitHeadRevision } from "../analyse/git-changes/capture.js";
import { compareRepositorySnapshots, compareSnapshots } from "../analyse/git-changes/comparison.js";
import { GitTreeReader } from "../analyse/git-changes/git-tree.js";
import { buildModuleStates } from "../analyse/module-review/module-state.js";
import { snapshotFragment } from "../analyse/module-review/publication.js";
import { MODULE_TREE_FILE } from "../framework/project/storage-paths.js";
import { snapshotDigest, structureHash } from "../framework/snapshots/identity.js";
import type { Snapshot } from "../framework/snapshots/types.js";
import { fileDiff } from "../module-operations/file-diff.js";
import { listModuleFiles } from "../module-operations/module-access.js";
import { moduleDetail, moduleSummary } from "../module-operations/module-view.js";
import { commitTestFiles, contractYaml, initTestRepository, writeModuleTree } from "./support.js";

test("the repository map is a root file in full, published and fast Git views", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "archiview-map-changes-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  initTestRepository(root);
  await writeFile(path.join(root, ".gitignore"), "*.ignored\n");
  commitTestFiles(root);
  const reader = new GitTreeReader(root, root);
  const map = path.join(root, MODULE_TREE_FILE);
  const original = "{}\n", edited = "{} # updated\n";
  await mkdir(path.dirname(map));
  await writeFile(map, original);
  await writeFile(path.join(root, "new.ts"), "export {};\n");
  await writeFile(path.join(root, "local.ignored"), "ignored\n");

  async function check(state: "new" | "changed" | "removed", expectedLines: string[]) {
    const head = (await readGitHeadRevision(root))!;
    const full = await captureWorkingTree(root);
    const fast = await reader.working(head);
    const pairs: [Snapshot, Snapshot, string?][] = [
      [(await captureGitHead(root))!, full], [await reader.revision(head), fast, root],
    ];
    for (const [before, after, liveRoot] of pairs) {
      const modules = compareSnapshots(before, after).modules;
      const owner = modules.find(m => m.directory === ".")!;
      const expected = state === "new" ? [{ path: MODULE_TREE_FILE, status: state }, { path: "new.ts", status: "new" }]
        : [{ path: MODULE_TREE_FILE, status: state }];
      assert.deepEqual(owner.files, expected);
      const summary = moduleSummary(owner);
      assert.equal(summary.filesChanged, expected.length);
      assert.equal(summary.filesStatus, state);
      assert.equal(summary.contractStatus, "unchanged");
      assert.deepEqual(moduleDetail(owner, [], undefined, modules, root, root).files, expected);
      const diff = await fileDiff(owner, before, after, MODULE_TREE_FILE, liveRoot);
      assert.deepEqual(diff.hunks.flatMap(h => h.lines), expectedLines);
      assert.ok(!after.modules.some(m => m.files.some(f => f.path === "local.ignored")));
      if (state === "changed") {
        assert.equal(buildModuleStates(before).get("directory:.")!.self_digest, buildModuleStates(after).get("directory:.")!.self_digest);
      }
    }
    const fragment = snapshotFragment(full, ".");
    const fact = fragment?.facts.find(entry => entry.fact.path === MODULE_TREE_FILE)?.fact;
    assert.equal(fact?.text, state === "removed" ? undefined : state === "new" ? original : edited);
    assert.equal((await listModuleFiles(root, ".")).files.includes(MODULE_TREE_FILE), state !== "removed");
    return fast;
  }
  const first = await check("new", ["+{}"]);
  const initialHead = await reader.revision((await readGitHeadRevision(root))!);
  commitTestFiles(root);
  await writeFile(map, edited);
  assert.equal((await captureGitIndex(root))!.facts.find(f => f.path === MODULE_TREE_FILE)?.text, original);
  const staleModule = compareSnapshots(initialHead, first).modules.find(m => m.directory === ".")!;
  await assert.rejects(fileDiff(staleModule, initialHead, first, MODULE_TREE_FILE, root), { code: "STALE_VIEW" });
  await check("changed", ["-{}", "+{} # updated"]);
  await rm(map);
  await check("removed", ["-{}"]);
});

test("old archives resolve the map from their exact Git revision or expose missing evidence", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "archiview-legacy-map-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  initTestRepository(root);
  await mkdir(path.join(root, ".archiview"));
  const map = path.join(root, MODULE_TREE_FILE);
  await writeFile(map, "{}\n");
  commitTestFiles(root);
  const archived = (await captureGitHead(root))!;
  // The old writer did not include the registry in module files or evidence.
  archived.modules[0].files = archived.modules[0].files.filter(f => f.path !== MODULE_TREE_FILE);
  archived.facts = archived.facts.filter(f => f.path !== MODULE_TREE_FILE);
  archived.modules[0].fingerprint = structureHash(JSON.stringify(archived.modules[0].files));
  archived.fingerprint = structureHash(JSON.stringify({ root: archived.root, modules: archived.modules }));
  archived.digest = snapshotDigest(archived);
  const original = structuredClone(archived);
  const firstCommit = await compareRepositorySnapshots(root, null, archived, { emptyTree: true });
  assert.deepEqual(firstCommit.modules[0].files, [{ path: MODULE_TREE_FILE, status: "new" }]);
  const unchanged = await captureWorkingTree(root);
  assert.deepEqual((await compareRepositorySnapshots(root, archived, unchanged)).modules[0].files, []);
  await writeFile(map, "{} # changed\n");
  const edited = await captureWorkingTree(root);
  for (const [left, right] of [[archived, edited], [edited, archived]]) {
    const resolved = await compareRepositorySnapshots(root, left, right);
    assert.deepEqual(resolved.modules[0].files, [{ path: MODULE_TREE_FILE, status: "changed" }]);
    assert.deepEqual(resolved.diagnostics, []);
    const diff = await fileDiff(resolved.modules[0], left, right, MODULE_TREE_FILE, { repository: root });
    assert.deepEqual(diff.hunks.flatMap(h => h.lines), left === archived ? ["-{}", "+{} # changed"] : ["-{} # changed", "+{}"]);
    const unknown = compareSnapshots(left, right);
    assert.deepEqual(unknown.modules[0].files, []);
    assert.match(unknown.diagnostics.join("\n"), /modules\.tree/);
  }
  await rm(map);
  const removed = await captureWorkingTree(root);
  assert.deepEqual((await compareRepositorySnapshots(root, archived, removed)).modules[0].files,
    [{ path: MODULE_TREE_FILE, status: "removed" }]);
  const oldWorking = { ...archived, kind: "saved", revision: undefined, baseRevision: archived.revision };
  const unknown = await compareRepositorySnapshots(root, oldWorking, edited);
  assert.deepEqual(unknown.modules[0].files, []);
  assert.match(unknown.diagnostics.join("\n"), /modules\.tree/);
  assert.deepEqual(archived, original);
});

test("module summaries distinguish an unavailable contract from a deleted contract", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "archiview-contract-status-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  initTestRepository(root);
  const map = path.join(root, MODULE_TREE_FILE);
  const source = path.join(root, "src", "feature.ts");
  const contract = path.join(root, ".archiview", "modules", "feature.yaml");
  await mkdir(path.dirname(source));
  await writeModuleTree(root, { feature: "src" });
  await writeFile(source, "export const feature = 1;\n");
  await writeFile(contract, contractYaml("feature"));
  commitTestFiles(root);
  const baseline = await captureGitHead(root);
  assert.ok(baseline);

  async function status() {
    const snapshot = await captureWorkingTree(root);
    const module = compareSnapshots(baseline, snapshot).modules.find(entry => entry.directory === "src");
    assert.ok(module?.after, "the module stays visible despite the error or deletion");
    return moduleSummary(module).contractStatus;
  }

  await writeFile(map, "feature: [\n");
  assert.equal(await status(), "unavailable", "a broken registry does not prove that YAML was deleted");
  await writeModuleTree(root, { feature: "src" });
  await writeFile(contract, Buffer.from([0xff]));
  assert.equal(await status(), "unavailable", "existing YAML with unreadable text has no known status");
  await rm(contract);
  await rm(source);
  await rmdir(path.dirname(source));
  assert.equal(await status(), "removed", "a retained registry entry does not prove that YAML exists");
});
