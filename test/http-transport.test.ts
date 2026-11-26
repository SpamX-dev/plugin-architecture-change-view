import { commitTestFiles, initTestRepository } from "./support.js";
import { writeModuleTree } from "./support.js";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
/** Проверяет, что некорректная цель запроса становится ответом транспорта, а не падением сервера. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { execFileSync, execSync, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { parse, stringify } from "yaml";
import { createArchiView } from "../web/web-backend/web-service/http.js";
import { projectReviewSettings } from "../web/web-backend/project-review-settings.js";
import type { ComparisonView } from "../module-operations/api.js";

test("standalone CLI serves its startup UI even after a rebuild, before opening a project session", { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "archiview-cli-start-"));
  initTestRepository(root);
  const distribution = path.join(root, "dist");
  await cp(new URL("../dist/", import.meta.url), distribution, { recursive: true });
  const script = path.join(distribution, "web/archiview/app.mjs");
  const original = await readFile(script, "utf8");
  const child = spawn(process.execPath, [path.join(distribution, "cli.mjs"), "--root", root, "--port", "0"], { cwd: distribution, windowsHide: true });
  const closed = once(child, "close");
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      const match = /^ArchiView Local: (http:\/\/127\.0\.0\.1:\d+)$/.exec(line);
      if (!match) continue;
      assert.equal((await fetch(match[1])).status, 200);
      await writeFile(script, "export const version = 'next';");
      assert.equal(await (await fetch(match[1] + "/app.mjs")).text(), original);
      await assert.rejects(stat(path.join(root, ".archiview")), { code: "ENOENT" });
      return;
    }
    assert.fail("CLI stopped before serving the workspace");
  } finally {
    child.kill();
    await closed;
    await rm(root, { recursive: true, force: true });
  }
});

/** Изолированный проект и порт принадлежат тесту; рабочие исходники пользователя не читаются. */
async function serve(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "archiview-transport-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  initTestRepository(root);
  await writeModuleTree(root, { root: "." });
  await writeFile(path.join(root, ".archiview/modules/root.yaml"), stringify({ schema_version: 1, id: "root", title: "Пример",
    kind: "module", purpose: "Возвращать значение.",
    boundaries: {}, invariants: {} }));
  await writeFile(path.join(root, "code.js"), "export const value = 1;\n");
  const app = await createArchiView({ root });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(() => new Promise<void>((resolve) => { app.server.closeAllConnections(); app.server.close(() => resolve()); }));
  return { ...app, root, url: "http://127.0.0.1:" + (app.server.address() as AddressInfo).port };
}

test("review settings repair partial hooks, preserve other handlers and reject redirected files", async t => {
  const app = await serve(t);
  const url = app.url + "/api/review-settings";
  const set = (enabled: boolean) => fetch(url, {method:"POST", headers:{"content-type":"application/json"},
    body:JSON.stringify({setting:"codexHooks", enabled})});
  assert.deepEqual(await (await fetch(url)).json(), {autoAnalysis:false, codexHooks:"off"});
  const folder = path.join(app.root, ".codex");
  const file = path.join(folder, "hooks.json");
  await mkdir(folder);
  const custom = {type:"command", command:"echo existing", statusMessage:"ArchiView · проверка изменённых модулей"};
  const foreign = {description:"User settings", hooks:{Stop:[{hooks:[custom]}], SessionStart:[{hooks:[custom]}]}};
  await writeFile(file, JSON.stringify(foreign));
  assert.equal((await (await set(true)).json()).codexHooks, "on");
  const installed = JSON.parse(await readFile(file, "utf8"));
  const managed = installed.hooks.Stop[1].hooks[0];
  assert.match(managed.command, /--turn-hook codex$/);
  installed.hooks.Stop = [{hooks:[custom, managed]}];
  delete installed.hooks.UserPromptSubmit;
  await writeFile(file, JSON.stringify(installed));
  assert.equal((await (await fetch(url)).json()).codexHooks, "partial");
  assert.equal((await (await set(true)).json()).codexHooks, "on");
  const repaired = await readFile(file, "utf8");
  await set(true);
  assert.equal(await readFile(file, "utf8"), repaired);
  assert.equal((await (await set(false)).json()).codexHooks, "off");
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), foreign);
  const oldHook = {type:"command", command:'node "/old/installation/dist/cli.mjs" --turn-hook codex'};
  await writeFile(file, JSON.stringify({description:"Проверка изменённых модулей ArchiView",
    hooks:{UserPromptSubmit:[{hooks:[oldHook]}], Stop:[{hooks:[custom, oldHook]}]}}));
  assert.equal((await (await fetch(url)).json()).codexHooks, "partial");
  assert.equal((await (await set(true)).json()).codexHooks, "on");
  const migrated = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(migrated.hooks.Stop.flatMap((group: {hooks: unknown[]}) => group.hooks), [custom, managed]);
  await writeFile(file, "broken JSON");
  assert.equal((await set(true)).ok, false);
  assert.equal(await readFile(file, "utf8"), "broken JSON");
  await rm(folder, {recursive:true});
  const other = await mkdtemp(path.join(os.tmpdir(),"archiview-foreign-hooks-"));
  t.after(() => rm(other, {recursive:true, force:true}));
  await symlink(other, folder, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await set(true)).ok, false);
  await assert.rejects(stat(path.join(other, "hooks.json")), {code:"ENOENT"});
});

test("a generated Codex hook passes shell-sensitive external storage paths intact", async t => {
  const app = await serve(t);
  const external = await mkdtemp(path.join(os.tmpdir(), "ArchiView & ' %PATH% "));
  t.after(() => rm(external, {recursive:true, force:true}));
  const settings = projectReviewSettings(app.root, external);
  await settings.set({setting:"autoAnalysis", enabled:true});
  await settings.set({setting:"codexHooks", enabled:true});
  const hooks = JSON.parse(await readFile(path.join(app.root, ".codex", "hooks.json"), "utf8")).hooks;
  const event = {hook_event_name:"UserPromptSubmit", session_id:"author", turn_id:"1", cwd:app.root};
  const json = execSync(hooks.UserPromptSubmit[0].hooks[0].command, {cwd:app.root, input:JSON.stringify(event), encoding:"utf8", windowsHide:true});
  const context = JSON.parse(json).hookSpecificOutput.additionalContext;
  assert.ok(context.includes(JSON.stringify(external)));
});

test("automatic clause IDs follow each section's Git, staged and uncommitted numbering across sessions", async t => {
  const app = await serve(t);
  const file = ".archiview/modules/root.yaml";
  const target = path.join(app.root, file);
  const base = parse(await readFile(target, "utf8"));
  const write = (boundaries: Record<string, string>, invariants: Record<string, string>) =>
    writeFile(target, stringify({ ...base, boundaries, invariants }));
  await write({ B12: "Историческая граница" }, {});
  commitTestFiles(app.root);
  const boundaries = { B2: "Граница", legacy: "Словесный ID", I99: "Другой префикс" };
  await write(boundaries, {});
  commitTestFiles(app.root);
  await write(boundaries, { I8: "В индексе" });
  execFileSync("git", ["add", "--", file], { cwd: app.root, windowsHide: true });
  await write(boundaries, {});
  const current = await app.getComparison();
  const add = (view: string, section: "boundaries" | "invariants") => fetch(app.url + "/api/contract-clause", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ view, section, path: ".", action: "add", text: "Новый пункт" }),
  });
  const race = await Promise.all([add(current.id, "boundaries"), add(current.id, "boundaries")]);
  assert.deepEqual(race.map(response => response.status).sort(), [200, 409]);
  assert.equal((await race.find(response => response.ok)!.json()).clauseId, "B13");
  assert.equal((await (await add((await app.getComparison()).id, "invariants")).json()).clauseId, "I9");
  await app.changeClause({ view: (await app.getComparison()).id, path: ".", section: "boundaries", action: "delete", clauseId: "B13" });

  const reopened = await createArchiView({ root: app.root });
  t.after(() => reopened.close());
  const result = await reopened.changeClause({ view: (await reopened.getComparison()).id, path: ".",
    section: "boundaries", action: "add", text: "После удаления" });
  assert.equal(result.clauseId, "B14");
  const contract = parse(await readFile(target, "utf8"));
  assert.deepEqual(contract.boundaries, { ...boundaries, B14: "После удаления" });
  assert.deepEqual(contract.invariants, { I9: "Новый пункт" });
});

test("clause writes require the live mapping and source version; undo restores original YAML bytes", async t => {
  const app = await serve(t);
  const file = path.join(app.root, ".archiview/modules/root.yaml");
  const original = [
    "# Contract", "schema_version: 1", "id: root", "title: 'Пример'", "kind: module",
    "rationale: >-", "  Первая строка", "  и продолжение.", "purpose: Пример",
    "boundaries:", "  legacy.id: Прежний ключ # комментарий", "  B7: Другой пункт", "invariants: {}", "",
  ].join("\r\n");
  await writeFile(file, original);
  commitTestFiles(app.root);
  const live = await app.getComparison();
  const post = (body: object) => fetch(app.url + "/api/contract-clause", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: ".", view: live.id, ...body }) });
  const deletion = { section: "boundaries", action: "delete", clauseId: "legacy.id" };
  const commit = await app.getComparison({ target: live.timeline.find(entry => entry.kind === "git")!.id });
  assert.equal((await post({ ...deletion, view: commit.id })).status, 400);
  assert.equal((await post({ action: "delete", section: "responsibilities", clauseId: "R1" })).status, 400);
  assert.equal((await post({ action: "add", section: "boundaries", clauseId: "B7", text: "Повтор" })).status, 400);
  const race = await Promise.all([post(deletion), post(deletion)]);
  assert.deepEqual(race.map(r => r.status).sort(), [200, 409]);
  const undo = await race.find(r => r.ok)!.json();
  assert.equal(await readFile(file, "utf8"), original.replace("  legacy.id: Прежний ключ # комментарий\r\n", ""));
  const current = await app.getComparison();
  const restore = { ...deletion, view: current.id, action: "restore", undoToken: undo.undoToken };
  assert.equal((await post({ ...restore, undoToken: "expired" })).status, 409);
  assert.equal((await post(restore)).status, 200);
  assert.equal(await readFile(file, "utf8"), original);
  const multiline = "Первая строка\n" + "Длинное значение ".repeat(450);
  assert.equal((await post({ action: "add", section: "invariants", clauseId: "__proto__", text: multiline })).status, 200);
  const edited = await app.getComparison();
  const detail = await app.getModule({ view: edited.id, path: "." });
  const field = detail.contractDiff.fields.find(item => item.key === "invariants.__proto__");
  assert.equal(field?.status, "added");
  assert.equal(field.after, multiline);
  const beforeSecondDeletion = await readFile(file, "utf8");
  const second = await post({ ...deletion, view: edited.id });
  assert.equal(second.status, 200);
  const secondToken = (await second.json()).undoToken;
  const absent = await app.getComparison();
  assert.equal((await post({ view: absent.id, action: "edit", section: "boundaries", clauseId: "B7", text: "Соседняя правка" })).status, 200);
  const changed = await app.getComparison();
  assert.equal((await post({ ...restore, view: changed.id })).status, 409);
  assert.equal((await post({ ...restore, view: changed.id, undoToken: secondToken })).status, 200);
  assert.equal(await readFile(file, "utf8"), beforeSecondDeletion.replace("Другой пункт", "Соседняя правка"));
  const beforeRemap = await readFile(file, "utf8");
  const mapped = await app.getComparison();
  await writeModuleTree(app.root, { other: "." });
  assert.equal((await post({ ...deletion, view: mapped.id })).status, 409);
  assert.equal(await readFile(file, "utf8"), beforeRemap);
});

/**
 * Отправляет сырую строку запроса: fetch не позволяет передать синтаксически
 * некорректный request-target, который реально доходит до HTTP-парсера Node.
 */
function rawRequest(port: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write("GET " + target + " HTTP/1.1\r\nHost: 127.0.0.1:" + port + "\r\nConnection: close\r\n\r\n");
    });
    let text = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { text += chunk; });
    socket.on("error", reject);
    socket.on("close", () => resolve(text));
    socket.setTimeout(5000, () => { socket.destroy(); resolve(text); });
  });
}

test("a malformed request-target returns 400 and the server keeps serving", async (t) => {
  const app = await serve(t);
  const port = (app.server.address() as AddressInfo).port;
  const response = await rawRequest(port, "http://[");
  assert.match(response, /^HTTP\/1\.1 400 /);
  assert.match(response, /"code":"INVALID_ARGUMENT"/);
  // Разбор цели не завершает процесс: следующий запрос обслуживается тем же сервером.
  const next = await fetch(app.url + "/api/comparison");
  assert.equal(next.status, 200);
  assert.equal((await next.json()).complete, true);
});

test("API validates browser request context and preserves direct local clients", async t => {
  const app = await serve(t);
  const get = (headers?: Record<string, string>) => fetch(app.url + "/api/review-settings", { headers });
  const localReferer = app.url + "/";
  const foreignReferer = "https://example.invalid/";
  const nonLocalContexts: Record<string, string>[] = [
    { "Sec-Fetch-Site": "cross-site" }, { "Sec-Fetch-Site": "same-site" }, { Referer: foreignReferer },
  ];
  for (const headers of nonLocalContexts) {
    assert.equal((await get(headers)).status, 403);
  }
  assert.equal((await get()).status, 200);
  assert.equal((await get({ "Sec-Fetch-Site": "none" })).status, 200);
  assert.equal((await get({ "Sec-Fetch-Site": "same-origin", Referer: localReferer })).status, 200);
});

test("CLI shutdown releases an active watch connection when another server takes the same port", async t => {
  const app = await serve(t);
  const view: ComparisonView = await (await fetch(app.url + "/api/comparison?watch=true")).json();
  assert.ok(view.watchCursor);
  const changes = app.url + "/api/changes?cursor=" + view.watchCursor;
  const received = once(app.server, "request");
  const waiting = fetch(changes, { signal: AbortSignal.timeout(5000) });
  await received;
  const stopped = once(app.server, "close");
  app.server.shutdown();

  const replacement = await createArchiView({ root: app.root });
  replacement.server.listen(Number(new URL(app.url).port), "127.0.0.1");
  await once(replacement.server, "listening");
  t.after(() => replacement.server.shutdown());
  const last = await waiting;
  assert.equal(last.status, 200);
  assert.equal(last.headers.get("connection"), "close");
  assert.equal((await last.json()).cursor, view.watchCursor);
  await stopped;

  const next = await (await fetch(changes)).json();
  assert.notEqual(next.cursor.split(".")[0], view.watchCursor.split(".")[0]);
  assert.equal(next.reviewsChanged, true);
});

test("HTTP serves the published view and rejects malformed publication selectors", async (t) => {
  const app = await serve(t);
  const url = app.url + "/api/comparison?published=";
  assert.equal((await fetch(url + "sometimes")).status, 400);
  assert.equal((await fetch(url + "true&historyLimit=0")).status, 400);
  const current = await (await fetch(url + "false")).json();
  await app.buildReview({ view: current.id, path: "." });
  const published = await (await fetch(url + "true")).json();
  assert.equal(current.published, undefined);
  assert.equal(published.published, true);
  assert.equal(published.modules[0].moduleId, current.modules[0].moduleId);
  const detail = await fetch(app.url + "/api/module?" + new URLSearchParams({ view: published.id, path: "." }));
  assert.equal((await detail.json()).moduleId, "root");
});

test("malformed JSON returns a client error without breaking later operations", async (t) => {
  const app = await serve(t);
  const response = await fetch(app.url + "/api/analysis", { method: "POST", body: "{" });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "INVALID_ARGUMENT");
  assert.equal((await fetch(app.url + "/api/comparison")).status, 200);
});
