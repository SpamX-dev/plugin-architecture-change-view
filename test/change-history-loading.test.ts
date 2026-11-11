import type { TestContext } from "node:test";
/** История после наблюдения берётся из того же проверенного чтения без потери событий. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { stringify } from "yaml";
import { ChangeHistory } from "../src/storage/change-history.js";
import { SnapshotStore } from "../src/storage/snapshot-store.js";
import { captureGitHead, captureWorkingTree } from "../src/snapshots/capture.js";

const run = promisify(execFile);
const stored = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Изолированный проект создаёт настоящие снимки; его данные удаляются вместе с фикстурой. */
async function fixture(t: TestContext, useGit = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "archiview-history-loading-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "source");
  await mkdir(root);
  await writeFile(path.join(root, "arch.yaml"), stringify({ schema_version: 1, id: "root", title: "Root", kind: "module",
    purpose: "Читать записи.", responsibilities: { R1: "Читать записи." }, boundaries: {}, invariants: {} }));
  const edit = (value: number) => writeFile(path.join(root, "code.js"), "export const value = " + value + ";\n");
  await edit(0);
  const git = async (...args: string[]) => (await run("git", args, { cwd: root, windowsHide: true })).stdout.trim();
  const commit = async () => {
    await git("add", "arch.yaml", "code.js");
    await git("-c", "user.name=ArchiView Test", "-c", "user.email=archiview@example.invalid", "commit", "--quiet", "-m", "Snapshot");
    return captureGitHead(root);
  };
  if (useGit) await git("init", "--quiet", "--initial-branch=main");
  return { root, edit, commit, history: new ChangeHistory(new SnapshotStore(root)) };
}

test("observe includes the newly appended event and returns the same history for a duplicate", async (t) => {
  const { root, edit, history } = await fixture(t);
  for (const value of [0, 1, 2]) {
    await edit(value);
    const current = await captureWorkingTree(root);
    const observed = await history.observe(current, null, { includeHistory: true });
    assert.equal(observed.created, true);
    assert.equal(observed.history!.changes.at(-1)!.id, observed.record!.id);
    assert.deepEqual(stored(observed.history), await history.list(null));
    const duplicate = await history.observe(current, null, { includeHistory: true });
    assert.equal(duplicate.created, false);
    assert.deepEqual(stored(duplicate.history), await history.list(null));
    assert.deepEqual(duplicate.history!.changes.map((record) => record.sequence), Array.from({ length: value + 1 }, (_, i) => i + 1));
  }
  const ordinary = await history.observe(await captureWorkingTree(root));
  assert.deepEqual(Object.keys(ordinary).sort(), ["created", "record"]);
});

test("clean and changed HEAD observations include exactly the history anchored to that revision", async (t) => {
  const { root, edit, commit, history } = await fixture(t, true);
  const firstHead = await commit();
  const clean = await history.observe(await captureWorkingTree(root), firstHead, { includeHistory: true });
  assert.equal(clean.record, null);
  assert.equal(clean.created, false);
  assert.deepEqual(clean.history, await history.list(firstHead!.revision));
  assert.equal(clean.history.changes.length, 0);

  await edit(1);
  const changed = await history.observe(await captureWorkingTree(root), firstHead, { includeHistory: true });
  assert.equal(changed.created, true);
  assert.deepEqual(stored(changed.history), await history.list(firstHead!.revision));

  await edit(0);
  const returned = await history.observe(await captureWorkingTree(root), firstHead, { includeHistory: true });
  assert.equal(returned.created, true);
  assert.equal(returned.history!.changes.length, 2);
  assert.deepEqual(stored(returned.history), await history.list(firstHead!.revision));

  await edit(2);
  const secondHead = await commit();
  const next = await history.observe(await captureWorkingTree(root), secondHead, { includeHistory: true });
  assert.equal(next.created, false);
  assert.deepEqual(next.history, await history.list(secondHead!.revision));
  assert.equal(next.history.changes.length, 0);
  assert.equal((await history.list(firstHead!.revision)).changes.length, 2);
});

test("observe rereads external changes and refuses corrupted history even for unchanged input", async (t) => {
  const { root, edit, history } = await fixture(t);
  const first = await captureWorkingTree(root);
  await history.observe(first, null, { includeHistory: true });
  await edit(1);
  const current = await captureWorkingTree(root);
  const second = new ChangeHistory(new SnapshotStore(root));
  const external = await second.observe(current);
  const observed = await history.observe(current, null, { includeHistory: true });
  assert.equal(observed.created, false);
  assert.equal(observed.history!.changes.length, 2);
  assert.equal(observed.history!.changes.at(-1)!.id, external.record!.id);

  const file = path.join(history.directory, external.record!.id + ".yaml");
  const text = await readFile(file, "utf8");
  await writeFile(file, text.replace("sequence: 2", "sequence: 9"));
  await assert.rejects(history.observe(current, null, { includeHistory: true }), /Change history is damaged; refusing to append/);
  assert.match((await history.list(null)).diagnostics.join("\n"), /record digest mismatch/);
});
