import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as wait } from 'node:timers/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createArchiViewSession } from '../src/application/session.js';
import { ApplicationError } from '../src/application/errors.js';

/** Reproduce an actual interleaving between a cached action and a newer publication. */
test('a newer publication cannot be rolled back by an already running cached action', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archiview-publication-race-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'arch.yaml'), 'schema_version: 1\nid: root\ntitle: Root\nkind: module\npurpose: Provide a value.\nresponsibilities:\n  R1: Export a value.\nboundaries: {}\ninvariants: {}\n');
  await writeFile(path.join(root, 'value.ts'), 'export const value = 1;\n');
  const session = await createArchiViewSession({ root });
  const old = await session.getComparison();
  const rebuild = session.reports.rebuild.bind(session.reports);
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  session.reports.rebuild = async (...args: Parameters<typeof rebuild>) => {
    if (args[3]?.expectedComparison) { entered(); await blocked; }
    return rebuild(...args);
  };
  const pending = assert.rejects(session.buildReview({ view: old.id, path: '.' }),
    (error: unknown) => error instanceof ApplicationError && error.code === 'STALE_VIEW');
  await reached;
  try {
    await writeFile(path.join(root, 'value.ts'), 'export const value = 2;\n');
    const current = await session.getComparison();
    assert.notEqual(current.id, old.id);
    const latest = await session.reports.publishedComparison();
    assert.ok(latest);
    release();
    await pending;
    assert.deepEqual(await session.reports.publishedComparison(), latest);
  } finally { release(); }
});

test('a second process captures and records the live tree after the previous refresh publishes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archiview-live-order-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'value.ts');
  await writeFile(file, 'export const value = 0;');
  const session = await createArchiViewSession({ root });
  const original = session.reports.refreshWorking.bind(session.reports);
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { entered = resolve; });
  const resume = new Promise<void>((resolve) => { release = resolve; });
  t.mock.method(session.reports, 'refreshWorking', async (...args: Parameters<typeof original>) => {
    entered();
    await resume;
    return original(...args);
  });
  await writeFile(file, 'export const value = 1;');
  const first = session.getComparison();
  await reached;
  await writeFile(file, 'export const value = 2;');

  // A separate CLI must wait before capturing/observing, including during its startup publication.
  const cli = new URL('../src/cli.ts', import.meta.url);
  const child = promisify(execFile)(process.execPath, ['--import', import.meta.resolve('tsx'),
    fileURLToPath(cli), '--root', root, '--build-report', '--port', 'unused'], { windowsHide: true });
  try {
    const deadline = Date.now() + 10_000;
    while (!(await readdir(session.reports.control)).some((name) => name.startsWith('.owner-'))) {
      assert.ok(Date.now() < deadline, 'the other process did not reach the publication lock');
      await Promise.race([wait(20), child.then(() => { throw new Error('second process completed before the first publication'); })]);
    }
    await writeFile(file, 'export const value = 3;');
  } finally {
    release();
    await Promise.all([first, child]);
  }
  const content = (snapshot: { facts: { path: string; text: string }[] }) =>
    snapshot.facts.find((fact) => fact.path === 'value.ts')?.text;
  const publication = await session.reports.publishedComparison();
  assert.ok(publication);
  assert.equal(content(publication.current), 'export const value = 3;');
  const history = (await session.changes.list()).changes.sort((a, b) => a.sequence - b.sequence);
  assert.deepEqual(history.map(content), [0, 1, 3].map((value) => 'export const value = ' + value + ';'));
});

test('direct callers cannot change a cached comparison through its public DTOs', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archiview-view-ownership-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'value.ts'), 'export const value = 1;');
  const session = await createArchiViewSession({ root });
  const comparison = await session.getComparison();
  const args = { view: comparison.id, path: '.' };
  const details = await session.getModule(args);
  const original = structuredClone(details);
  assert.ok(comparison.modules[0].structure);
  comparison.modules[0].structure.diagnostics.push('client change');
  assert.ok(details.after);
  details.after.files.length = 0;
  assert.deepEqual(await session.getModule(args), original);
});

test('historical and default reads retain a baseline selected by another session', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archiview-shared-baseline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'value.ts'), 'export const value = 1;');
  const git = (args: string[]) => promisify(execFile)('git', args, { cwd: root, windowsHide: true });
  await git(['init', '-q']);
  await git(['add', '.']);
  await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'Start']);
  const first = await createArchiViewSession({ root });
  const second = await createArchiViewSession({ root });
  const head = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const initial = await first.getComparison({ baseline: 'initial' });
  assert.equal(initial.before.id, 'initial');
  const saved = await first.saveSnapshot({ view: initial.id, label: 'Pinned base' });
  for (const selected of ['initial', saved.id]) {
    await first.getComparison({ target: 'current', baseline: selected });
    await writeFile(path.join(root, 'value.ts'), 'export const value = ' + JSON.stringify(selected) + ';');
    const historical = await second.getComparison({ target: 'git-' + head, baseline: 'auto' });
    assert.equal(historical.before.id, 'initial');
    const publication = await first.reports.publishedComparison();
    assert.ok(publication);
    assert.equal(publication.baseline?.id ?? 'initial', selected);
    assert.equal((await second.getComparison()).before.id, selected);
  }
  assert.equal((await second.getComparison({ baseline: 'auto' })).before.id, 'git-' + head);
});

test('the first live read uses the completeness of the baseline selected by another session', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archiview-shared-incomplete-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (args: string[]) => promisify(execFile)('git', args, { cwd: root, windowsHide: true });
  const contract = path.join(root, 'arch.yaml');
  const valid = 'schema_version: 1\nid: root\ntitle: Root\nkind: module\nresponsibilities: {}\nboundaries: {}\ninvariants: {}\npurpose: ';
  const oversized = valid + 'X'.repeat(140 * 1024);
  const code = path.join(root, 'value.ts');
  await git(['init', '-q']);
  async function commitContract(text: string, message: string) {
    await writeFile(contract, text);
    await git(['add', 'arch.yaml', 'value.ts']);
    await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', message]);
  }
  await writeFile(code, 'export const value = 1;');
  await commitContract(oversized, 'Incomplete HEAD');
  await writeFile(contract, valid + 'Valid contract.');
  const reader = await createArchiViewSession({ root });
  const writer = await createArchiViewSession({ root });
  t.mock.method(reader.reports, 'list', () => { throw new Error('A complete working capture reads history only once'); });
  t.mock.method(reader.reports, 'publishedComparison', () => { throw new Error('Baseline selection must reuse the locked publication'); });

  // Reader cached the incomplete HEAD. Writer published the valid working tree with no baseline.
  await writer.getComparison({ baseline: 'initial' });
  await writeFile(code, 'export const value = 2;');
  const refreshed = await reader.getComparison();
  assert.equal(refreshed.complete, true);
  assert.equal(refreshed.before.id, 'initial');
  assert.ok(refreshed.modules[0].structure?.checkHash);
  assert.equal((await writer.reports.publishedComparison())?.current.digest, refreshed.after.digest);

  // Reader now remembers initial. Writer follows HEAD, which becomes incomplete on the next commit.
  await commitContract(valid + 'Valid contract.', 'Complete HEAD');
  await writer.getComparison({ baseline: 'auto' });
  const previous = await writer.reports.publishedComparison();
  await commitContract(oversized, 'Incomplete HEAD again');
  await writeFile(contract, valid + 'Working repair.');
  const incomplete = await reader.getComparison();
  assert.equal(incomplete.complete, false);
  assert.ok(incomplete.diagnostics.some((message) => message.includes('arch.yaml')));
  assert.equal(incomplete.modules[0].structure?.checkHash, null);
  assert.deepEqual(await writer.reports.publishedComparison(), previous);
});
