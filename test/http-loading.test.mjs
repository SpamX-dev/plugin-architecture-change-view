/** Проверки загрузки без повторного чтения отчётов и потери точных снимков. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { createArchiView } from "../src/archiview/http.mjs";
import { ReportStore } from "../src/report-store.mjs";
import { captureWorkingTree, compareSnapshots } from "../src/snapshots.mjs";

/** Изолированный проект и порт принадлежат тесту; реальные данные пользователя не читаются. */
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "archiview-loading-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const contract = { schema_version: 1, id: "root", title: "Пример", kind: "module",
    purpose: "Возвращать значение.", responsibilities: { R1: "Возвращать значение." }, boundaries: {}, invariants: {} };
  await writeFile(path.join(root, "arch.yaml"), stringify(contract));
  await writeFile(path.join(root, "code.js"), "export const value = 1;\n");
  const app = await createArchiView({ root });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(() => new Promise((resolve) => { app.server.closeAllConnections(); app.server.close(resolve); }));
  const url = "http://127.0.0.1:" + app.server.address().port;
  const get = async (query = "") => {
    const response = await fetch(url + "/api/comparison" + query);
    const value = await response.json();
    assert.equal(response.status, 200, JSON.stringify(value));
    return value;
  };
  return { ...app, root, url, get, contract };
}

/** Фиксирует публикацию побайтово, чтобы неполный и исторический просмотр не заменили work. */
async function workBytes(app) {
  const names = (await readdir(app.reports.work)).sort();
  return Promise.all(names.map(async (name) => [name, await readFile(path.join(app.reports.work, name), "utf8")]));
}

test("complete refresh reuses publication and history while preserving saved and previous working selectors", async (t) => {
  const app = await fixture(t);
  t.mock.method(app.reports, "list", () => { throw new Error("Unexpected second report read"); });
  t.mock.method(app.reports, "publishedComparison", () => { throw new Error("Unexpected published comparison read"); });
  t.mock.method(app.changes, "list", () => { throw new Error("Unexpected second change history read"); });
  const list = app.store.list;
  const savedReader = t.mock.method(app.store, "list", function (options) {
    assert.equal(options.includePublished, false);
    return list.call(this, options);
  });
  const first = await app.get("?baseline=auto");
  const second = await app.get("?baseline=auto");
  assert.equal(first.complete, true);
  assert.equal(second.before.id, first.before.id);
  assert.equal(second.after.id, first.after.id);
  assert.equal(Object.hasOwn(second, "reportModel"), false);
  await writeFile(path.join(app.root, "code.js"), "export const value = 2;\n");
  const changed = await app.get("?baseline=auto");
  assert.notEqual(changed.after.digest, first.after.digest);
  assert.equal(changed.modules[0].status, "changed");
  const previousWorking = await app.get("?baseline=" + changed.after.id);
  assert.equal(previousWorking.before.id, changed.after.id);
  assert.equal(previousWorking.modules[0].status, "unchanged");
  const response = await fetch(app.url + "/api/snapshots", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ view: previousWorking.id, label: "Сохранённая база" }) });
  assert.equal(response.status, 201);
  const saved = await response.json();
  const selected = await app.get("?baseline=" + saved.id);
  assert.equal(selected.before.id, saved.id);
  assert.ok(selected.baselines.some((entry) => entry.id === saved.id && entry.label === "Сохранённая база"));
  assert.equal(savedReader.mock.callCount(), 5);
});

test("incomplete working capture reads existing diagnostics and leaves the publication intact", async (t) => {
  const app = await fixture(t);
  await app.get();
  const before = await workBytes(app);
  await writeFile(path.join(app.root, "arch.yaml"), stringify({ ...app.contract, purpose: "X".repeat(140 * 1024) }));
  t.mock.method(app.reports, "rebuild", () => { throw new Error("Incomplete capture must not publish"); });
  const list = app.reports.list;
  const reader = t.mock.method(app.reports, "list", async function () {
    const history = await list.call(this);
    return { ...history, diagnostics: [...history.diagnostics, "Диагностика сохранённой публикации"] };
  });
  const view = await app.get();
  assert.equal(view.complete, false);
  assert.ok(view.diagnostics.some((message) => message.includes("128 KiB")));
  assert.ok(view.reviewDiagnostics.includes("Диагностика сохранённой публикации"));
  assert.equal(reader.mock.callCount(), 1);
  assert.deepEqual(await workBytes(app), before);
});

test("historical refresh reuses loaded history and preserves the current publication", async (t) => {
  const app = await fixture(t);
  const first = await app.get();
  const historicalId = first.timeline.find((entry) => entry.kind === "change").id;
  const firstDetail = await (await fetch(app.url + "/api/module?" + new URLSearchParams({ view: first.id, path: "." }))).json();
  await writeFile(path.join(app.root, "code.js"), "export const value = 2;\n");
  await app.get();
  const before = await workBytes(app);
  t.mock.method(app.reports, "list", () => { throw new Error("Historical view must reuse current publication history"); });
  t.mock.method(app.reports, "publishedComparison", () => { throw new Error("Known history must not reload publication"); });
  const view = await app.get("?target=" + historicalId + "&baseline=auto");
  assert.equal(view.target.id, historicalId);
  const detail = await (await fetch(app.url + "/api/module?" + new URLSearchParams({ view: view.id, path: "." }))).json();
  assert.equal(detail.after.files.find((file) => file.path === "code.js").hash,
    firstDetail.after.files.find((file) => file.path === "code.js").hash);
  assert.deepEqual(await workBytes(app), before);
});

test("an explicit snapshot published by another store remains available through a lazy lookup", async (t) => {
  const app = await fixture(t);
  await writeFile(path.join(app.root, "code.js"), "export const value = 2;\n");
  const externalSnapshot = await captureWorkingTree(app.root);
  const external = new ReportStore(app.store);
  await external.rebuild(null, externalSnapshot, compareSnapshots(null, externalSnapshot).modules);
  const read = app.reports.publishedComparison;
  const reader = t.mock.method(app.reports, "publishedComparison", function () { return read.call(this); });
  const view = await app.get("?" + new URLSearchParams({ target: externalSnapshot.id, baseline: "initial" }));
  assert.equal(view.after.id, externalSnapshot.id);
  assert.equal(view.after.digest, externalSnapshot.digest);
  assert.equal(reader.mock.callCount(), 1);
  await app.get("?baseline=auto");
  assert.equal(reader.mock.callCount(), 1);
});
