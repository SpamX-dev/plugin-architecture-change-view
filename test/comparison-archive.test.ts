import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { captureGitHead, captureWorkingTree } from "../analyse/git-changes/capture.js";
import { compareGitFiles, compareSnapshots, comparisonId } from "../analyse/git-changes/comparison.js";
import { SnapshotStore } from "../analyse/git-changes/snapshot-store.js";
import { checkPreparedIndex } from "../analyse/module-review/report-index.js";
import { ReportStore } from "../analyse/module-review/report-store.js";
import type { Snapshot } from "../framework/snapshots/types.js";
import { commitTestFiles, contractYaml, initTestRepository, writeModuleTree } from "./support.js";

test("saved file comparisons preserve real changes when a module gains or loses ownership", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "archiview-file-owner-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "repo");
  await mkdir(path.join(root, "feature"), { recursive: true });
  initTestRepository(root);
  const settings = "feature/settings.json", source = "feature/main.ts";
  await writeFile(path.join(root, settings), "{}\n");
  const store = new SnapshotStore(root, path.join(directory, "state"));
  const original = await store.save(await captureWorkingTree(root));
  await writeFile(path.join(root, source), "export {};\n");
  const split = await store.save(await captureWorkingTree(root));
  await writeFile(path.join(root, settings), '{"enabled":true}\n');
  const edited = await store.save(await captureWorkingTree(root));
  await rm(path.join(root, "feature"), { recursive: true });

  const owned = compareSnapshots(original, split);
  assert.deepEqual(owned.modules.find(m => m.directory === ".")!.files, [{ path: settings, status: "removed" }]);
  const historical = await store.saveComparison(owned);
  const saved = await store.saveComparison(await compareGitFiles(root, original, split));
  assert.notEqual(saved.id, historical.id);
  assert.deepEqual(await store.readComparison(historical.id), historical);
  assert.deepEqual(saved.modules.map(m => [m.directory, m.status, m.files]), [
    [".", "unchanged", []], ["feature", "new", [{ path: source, status: "new" }]],
  ]);
  assert.equal(saved.modules[0].descendantChanges, 1);
  assert.deepEqual((await compareGitFiles(root, split, original)).modules.flatMap(m => m.files),
    [{ path: source, status: "removed" }]);
  const forward = await compareGitFiles(root, original, edited);
  assert.deepEqual(forward.modules.find(m => m.directory === "feature")!.files, [
    { path: source, status: "new" }, { path: settings, status: "changed" },
  ]);
  const reverse = await compareGitFiles(root, edited, original);
  assert.deepEqual(reverse.modules.map(m => [m.directory, m.files]), [
    [".", [{ path: settings, status: "changed" }]], ["feature", [{ path: source, status: "removed" }]],
  ]);
});

test("Git reports reopen by ID after recapture, transfer and changes to the source tree", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "archiview-comparison-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "original");
  await mkdir(root);
  initTestRepository(root);
  await writeModuleTree(root, { app: "." });
  await writeFile(path.join(root, ".archiview/modules/app.yaml"), contractYaml("app"));
  await writeFile(path.join(root, "change.ts"), "old\n");
  await writeFile(path.join(root, "remove.ts"), "remove\n");
  commitTestFiles(root);
  const base = await captureGitHead(root);
  assert.ok(base);
  await writeFile(path.join(root, "change.ts"), "updated\n");
  await writeFile(path.join(root, "new.ts"), "new\n");
  await rm(path.join(root, "remove.ts"));
  const current = await captureWorkingTree(root);
  const report = compareSnapshots(base, current);
  const store = new SnapshotStore(root);
  assert.equal(await store.readComparison(report.id), null);
  const sessionData = { ...report, currentSnapshot: current,
    modules: report.modules.map(m => ({ ...m, review: { privateSessionData: true } })) };
  const secondCapture = compareSnapshots({ ...base, capturedAt: "2030-01-01T00:00:00Z", label: "HEAD" },
    { ...current, capturedAt: "2030-01-01T00:00:01Z" });
  assert.equal(report.id, secondCapture.id);
  const [first, second] = await Promise.all([store.saveComparison(sessionData), store.saveComparison(secondCapture)]);
  assert.deepEqual(second, first);
  assert.deepEqual(first.modules[0].files, [
    { path: "change.ts", status: "changed" }, { path: "new.ts", status: "new" }, { path: "remove.ts", status: "removed" },
  ]);
  assert.equal("currentSnapshot" in first, false);
  assert.equal("review" in first.modules[0], false);
  assert.equal(first.before.digest, base.digest);
  assert.equal(first.after.digest, current.digest);
  assert.notEqual(report.id, compareSnapshots({ ...base, digest: current.digest }, current).id);
  assert.notEqual(report.id, compareSnapshots(base, { ...current, id: "other-observation" }).id);
  assert.notEqual(report.id, comparisonId({ ...report, diagnostics: ["Historical mode unavailable"] }));
  assert.notEqual(report.id, comparisonId({ ...report, modules: report.modules.map(m => ({ ...m, files: [] })) }));
  assert.notEqual(compareSnapshots(null, current).id, compareSnapshots(null, current, { emptyTree: true }).id);
  const { digest: _legacyDigest, ...old } = base;
  const legacy = { ...old, schema_version: 1 } as Snapshot;
  const oldReport = compareSnapshots(legacy, legacy);
  const reopened = await store.saveComparison(oldReport);
  assert.match(reopened.before.digest!, /^sha256:/);
  assert.equal(reopened.before.digest, reopened.after.digest);
  await assert.rejects(store.readComparison("../project.json"), /Invalid comparison report ID/);
  const reportsDirectory = path.join(root, ".archiview/comparisons");
  assert.deepEqual((await readdir(reportsDirectory)).sort(), [report.id + ".json", oldReport.id + ".json"].sort());
  await new ReportStore(store).rebuild(base, current, report.modules);
  commitTestFiles(root);
  assert.equal((await checkPreparedIndex(root)).modules, 1);
  const transferred = path.join(directory, "other-checkout");
  await mkdir(path.join(transferred, ".archiview"), { recursive: true });
  await cp(reportsDirectory, path.join(transferred, ".archiview/comparisons"), { recursive: true });
  await cp(path.join(root, ".archiview/project.json"), path.join(transferred, ".archiview/project.json"));
  await writeFile(path.join(root, "new.ts"), "changed after publication\n");
  assert.deepEqual(await new SnapshotStore(transferred).readComparison(report.id), first);
  const archivePath = path.join(reportsDirectory, report.id + ".json");
  const corrupt = JSON.parse(await readFile(archivePath, "utf8"));
  corrupt.report.modules[0].files = [];
  await writeFile(archivePath, JSON.stringify(corrupt));
  await assert.rejects(store.saveComparison(report), /Invalid or foreign comparison report/);
});
