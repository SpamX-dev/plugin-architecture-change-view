import { initTestRepository, commitTestFiles } from "./support.js";
import { writeModuleTree } from "./support.js";
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
  initTestRepository(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeModuleTree(root, { root: "." });
  await writeFile(path.join(root, '.archiview/modules/root.yaml'), 'schema_version: 1\nid: root\ntitle: Root\nkind: module\npurpose: Provide a value.\nresponsibilities:\n  R1: Export a value.\nboundaries: {}\ninvariants: {}\n');
  await writeFile(path.join(root, 'value.ts'), 'export const value = 1;\n');
  const session = await createArchiViewSession({ root });
  const old = await session.getComparison();
  await writeFile(path.join(root, 'value.ts'), 'export const value = 2;');
  const current = await session.getComparison();
  await session.buildReview({view:current.id,path:'.'});
  const published = await session.reports.publishedComparison();
  await assert.rejects(session.buildReview({view:old.id,path:'.'}), {code:'STALE_VIEW'});
  assert.deepEqual(await session.reports.publishedComparison(),published);
});

test('direct callers cannot change a cached comparison through its public DTOs', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archiview-view-ownership-'));
  initTestRepository(root);
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'value.ts'), 'export const value = 1;');
  const session = await createArchiViewSession({ root });
  const comparison = await session.getComparison();
  const args = { view: comparison.id, path: '.' };
  const details = await session.getModule(args);
  const original = structuredClone(details);
  comparison.diagnostics.push('client change');
  comparison.modules[0].filesChanged = 500;
  assert.ok(details.after);
  details.after.files.length = 0;
  assert.deepEqual(await session.getModule(args), original);
});

test('default reads use HEAD even after an explicit comparison selects a different baseline', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'archiview-head-'));
  t.after(() => rm(root, {recursive:true,force:true}));
  initTestRepository(root);
  await writeFile(path.join(root,'value.ts'),'value');
  commitTestFiles(root);
  const session = await createArchiViewSession({root});
  assert.equal((await session.getComparison({baseline:'initial'})).before.id,'initial');
  assert.equal((await session.getComparison()).before.kind,'git');
});
