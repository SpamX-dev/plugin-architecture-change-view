import { initTestRepository } from "./support.js";
import { writeModuleTree } from "./support.js";
import type { TestContext } from "node:test";
/** Реальные Git revision и неизменяемые наблюдения рабочего дерева между коммитами. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { stringify } from "yaml";
import { ChangeHistory } from "../src/storage/change-history.js";
import { SnapshotStore } from "../src/storage/snapshot-store.js";
import { captureGitHead, captureWorkingTree, listGitRevisions } from "../src/snapshots/capture.js";

const run = promisify(execFile);
const stored = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Каждый сценарий создаёт собственный проект; Git получает только тестовую identity. */
async function fixture(t: TestContext, useGit = true) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "archiview-change-history-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "source");
  await mkdir(root);
  initTestRepository(root);
  await writeModuleTree(root, { root: "." });
  await writeFile(path.join(root, ".archiview/modules/root.yaml"), stringify({ schema_version: 1, id: "root", title: "Root", kind: "module",
    purpose: "Читать записи.", responsibilities: { R1: "Читать записи." }, boundaries: {}, invariants: {} }));
  await writeFile(path.join(root, "code.js"), "export const read = () => 0;\n");
  const git = async (...args: string[]) => (await run("git", args, { cwd: root, windowsHide: true })).stdout.trim();
  const commit = async (subject: string) => {
    await git("add", ".archiview/modules.tree", ".archiview/modules/root.yaml", "code.js");
    await git("-c", "user.name=ArchiView Test", "-c", "user.email=archiview@example.invalid", "commit", "--quiet", "-m", subject);
    return git("rev-parse", "HEAD");
  };
  if (useGit) await git("init", "--quiet", "--initial-branch=main");
  const snapshotStore = new SnapshotStore(root);
  const history = new ChangeHistory(snapshotStore);
  return { directory, root, snapshotStore, history, git, commit };
}

test("Git metadata pages expose the entire first-parent line and load selected commits exactly", async (t) => {
  const { root, commit } = await fixture(t);
  const revisions = [];
  for (let index = 0; index < 4; index++) {
    await writeFile(path.join(root, "code.js"), "export const read = () => " + index + ";\n");
    revisions.push(await commit("Revision " + index));
  }
  const newest = await listGitRevisions(root, { limit: 2 });
  assert.deepEqual(newest.revisions.map((entry) => entry.revision), revisions.slice(2));
  assert.equal(newest.hasMore, true);
  assert.equal(newest.nextBefore, revisions[2]);
  assert.equal(newest.headRevision, revisions[3]);
  assert.equal(newest.revisions[1].isHead, true);
  assert.equal(newest.revisions[0].parentRevision, revisions[1]);
  const older = await listGitRevisions(root, { limit: 2, before: newest.nextBefore });
  assert.deepEqual(older.revisions.map((entry) => entry.revision), revisions.slice(0, 2));
  assert.equal(older.hasMore, false);
  assert.equal(older.revisions[0].parentRevision, null);
  assert.equal(older.revisions.some((entry) => entry.isHead), false);
  assert.deepEqual((await listGitRevisions(root, { before: revisions[0] })).revisions, []);
  const selected = await captureGitHead(root, { revision: revisions[1] });
  assert.equal(selected!.facts.find((fact) => fact.path === "code.js")!.text, "export const read = () => 1;\n");
  await assert.rejects(listGitRevisions(root, { before: "--all" }), /Invalid Git revision cursor/);
});

test("Git first-parent history excludes side commits while preserving merge parent metadata", async (t) => {
  const { root, git, commit } = await fixture(t);
  const initial = await commit("Initial");
  await git("checkout", "--quiet", "-b", "side");
  await writeFile(path.join(root, "side.js"), "export const side = true;\n");
  await git("add", "side.js");
  await git("-c", "user.name=ArchiView Test", "-c", "user.email=archiview@example.invalid", "commit", "--quiet", "-m", "Side");
  const side = await git("rev-parse", "HEAD");
  await git("checkout", "--quiet", "main");
  await writeFile(path.join(root, "code.js"), "export const read = () => 1;\n");
  const main = await commit("Main");
  await git("-c", "user.name=ArchiView Test", "-c", "user.email=archiview@example.invalid", "merge", "--quiet", "--no-ff", "side", "-m", "Merge");
  const result = await listGitRevisions(root);
  assert.deepEqual(result.revisions.slice(0, 2).map((entry) => entry.revision), [initial, main]);
  assert.equal(result.revisions.some((entry) => entry.revision === side), false);
  assert.equal(result.revisions.at(-1)!.parentRevision, main);
  await assert.rejects(listGitRevisions(root, { before: side }), /outside the current first-parent history/);
});

test("non-Git and unborn repositories expose no invented revisions", async (t) => {
  const plain = await fixture(t, false);
  assert.deepEqual((await listGitRevisions(plain.root)).revisions, []);
  const unborn = await fixture(t, true);
  assert.equal((await listGitRevisions(unborn.root)).headRevision, null);
});

test("clean HEAD adds no point; consecutive duplicates collapse and A to B to A remains exact", async (t) => {
  const { root, snapshotStore, history, commit } = await fixture(t);
  const revision = await commit("Initial");
  const head = await captureGitHead(root);
  assert.equal((await history.observe(await captureWorkingTree(root), head)).created, false);
  assert.equal((await history.list(revision)).changes.length, 0);
  const records = [];
  for (const value of [1, 2, 1]) {
    await writeFile(path.join(root, "code.js"), "export const read = () => " + value + ";\n");
    const snapshot = await captureWorkingTree(root);
    const observed = await history.observe(snapshot, head);
    assert.equal(observed.created, true);
    records.push(observed.record);
    assert.equal((await history.observe(snapshot, head)).created, false);
  }
  assert.deepEqual((await history.list(revision)).changes.map((record) => record.id), records.map((record) => record!.id));
  assert.equal(new Set(records.map((record) => record!.id)).size, 3);
  assert.equal(records[0]!.digest, records[2]!.digest);
  assert.deepEqual(await history.get(records[0]!.id), stored(records[0]));
  assert.equal(records[0]!.baseRevision, revision);
  assert.equal(records[0]!.originalId.startsWith("working-"), true);
  const second = new ChangeHistory(new SnapshotStore(snapshotStore.root));
  assert.equal((await second.observe(await captureWorkingTree(root), head)).created, false);
  assert.equal((await second.list()).changes.length, 3);
});

test("returning dirty to clean records an event; a new clean HEAD does not relabel old events", async (t) => {
  const { root, history, commit } = await fixture(t);
  const firstRevision = await commit("Initial");
  const firstHead = await captureGitHead(root);
  await history.observe(await captureWorkingTree(root), firstHead);
  await writeFile(path.join(root, "code.js"), "export const read = () => 1;\n");
  await history.observe(await captureWorkingTree(root), firstHead);
  await writeFile(path.join(root, "code.js"), "export const read = () => 0;\n");
  assert.equal((await history.observe(await captureWorkingTree(root), firstHead)).created, true);
  await writeFile(path.join(root, "code.js"), "export const read = () => 2;\n");
  const secondRevision = await commit("Second");
  assert.equal((await history.observe(await captureWorkingTree(root), await captureGitHead(root))).created, false);
  assert.equal((await history.list(firstRevision)).changes.length, 2);
  assert.equal((await history.list(secondRevision)).changes.length, 0);
});

test("non-Git initial observation becomes a baseline and incomplete/corrupt input is rejected", async (t) => {
  const { root, history } = await fixture(t, false);
  const first = await captureWorkingTree(root);
  const observed = await history.observe(first, null);
  assert.equal(observed.created, true);
  assert.equal(observed.record!.baseRevision, null);
  assert.equal((await history.observe(first, null)).created, false);
  await assert.rejects(history.observe({ ...first, complete: false }, null), /Invalid or incomplete change snapshot/);
  const file = path.join(history.directory, observed.record!.id + ".yaml");
  const original = await readFile(file, "utf8");
  await writeFile(file, original.replace("sequence: 1", "sequence: 2"));
  assert.match((await history.list()).diagnostics.join("\n"), /record digest mismatch/);
  await assert.rejects(history.observe(first, null), /refusing to append/);
});

test("late import is idempotent, preserves exact provenance and cannot rewind the current cursor", async (t) => {
  const { root, history, commit } = await fixture(t);
  const revision = await commit("Initial");
  const head = await captureGitHead(root);
  const snapshots = [];
  for (const value of [1, 2, 3]) {
    await writeFile(path.join(root, "code.js"), "export const read = () => " + value + ";\n");
    snapshots.push(await captureWorkingTree(root));
  }
  await history.observe(snapshots[2], head);
  const imported = await history.importSnapshots(snapshots.slice(0, 2), { baseRevision: revision, source: "verified-raw-publications" });
  assert.equal(imported.imported, 2);
  assert.equal((await history.importSnapshots(snapshots.slice(0, 2), { baseRevision: revision, source: "verified-raw-publications" })).imported, 0);
  assert.equal((await history.observe(snapshots[2], head)).created, false);
  const result = await history.list(revision);
  assert.deepEqual(result.changes.map((record) => record.digest), snapshots.map((snapshot) => snapshot.digest));
  assert.deepEqual(result.changes.map((record) => record.capturedAt), snapshots.map((snapshot) => snapshot.capturedAt));
  assert.equal(imported.changes[0].originalId, snapshots[0].id);
  assert.equal(imported.changes[0].provenance.source, "verified-raw-publications");
});

test("simultaneous observations append once and a missing cursor recovers without phantom changes", async (t) => {
  const { root, snapshotStore, history } = await fixture(t, false);
  const second = new ChangeHistory(new SnapshotStore(snapshotStore.root));
  const snapshot = await captureWorkingTree(root);
  const results = await Promise.all([history.observe(snapshot), second.observe(snapshot)]);
  assert.equal(results.filter((entry) => entry.created).length, 1);
  await rm(path.join(history.directory, ".cursor.yaml"));
  assert.equal((await history.observe(snapshot)).created, false);
  assert.equal((await history.list()).changes.length, 1);
  assert.equal((await readdir(history.directory)).some((name) => name.startsWith(".pending-") || name === ".lock"), false);
});
