import { commitTestFiles, writeModuleTree } from "./support.js";
/** Real browser acceptance of the built standalone app; never opens a host client. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import type { Server } from "node:http";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { parse, stringify } from "yaml";
import type { ReviewInput } from "../framework/static-report/types.js";
import { createArchiView } from "../web/web-backend/web-service/http.js";
import type { ComparisonView } from "../module-operations/api.js";
import { createReviewInput } from "../analyse/module-review/review-input.js";
import { digest } from "../framework/serialization/digest.js";
import { captureWorkingTree } from "../analyse/git-changes/capture.js";

const browserOptions = { skip: process.env.ARCHIVIEW_BROWSER_TEST !== "1", timeout: 60_000 };

type DeferCleanup = (close: () => Promise<void>) => void;

// Close the browser and HTTP server before deleting the project they are reading.
function fixtureCleanup(t: TestContext): DeferCleanup {
  const pending: (() => Promise<void>)[] = [];
  t.after(async () => {
    const errors: unknown[] = [];
    for (const close of pending.reverse()) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Browser fixture cleanup failed");
  });
  return (close) => { pending.push(close); };
}

async function browserProject(defer: DeferCleanup) {
  const root = await mkdtemp(path.join(os.tmpdir(), "archiview-browser-"));
  defer(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  await mkdir(path.join(root, "src"));
  const contract = (id: string, title: string) => stringify({ schema_version: 1, id, title, kind: "module",
    purpose: "Предоставлять функцию", boundaries: {}, invariants: {} });
  await writeModuleTree(root, { "browser-project": ".", "browser-feature": "src" });
  await writeFile(path.join(root, ".archiview/modules/browser-project.yaml"), contract("browser-project", "Браузерный проект"));
  await writeFile(path.join(root, ".archiview/modules/browser-feature.yaml"), contract("browser-feature", "Функция браузера"));
  await writeFile(path.join(root, "src/feature.ts"), "export const feature = 1;\n");
  const run = promisify(execFile);
  const git = (args: string[]) => run("git", args, { cwd: root, windowsHide: true });
  await git(["init", "-q"]);
  await git(["add", "."]);
  await git(["-c", "user.name=Browser Test", "-c", "user.email=browser@example.test", "commit", "-qm", "Initial feature"]);
  await writeFile(path.join(root, ".archiview/modules/browser-project.yaml"), contract("browser-project", "Новый заголовок проекта"));
  await git(["add", ".archiview/modules/browser-project.yaml"]);
  await git(["-c", "user.name=Browser Test", "-c", "user.email=browser@example.test", "commit", "-qm", "Update root contract"]);
  await writeFile(path.join(root, "src/feature.ts"), "export const feature = 2;\n");
  return root;
}

async function listen(defer: DeferCleanup, server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  defer(async () => {
    const closed = once(server, "close");
    server.close();
    server.closeAllConnections();
    await closed;
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return "http://127.0.0.1:" + address.port;
}

async function browserContext(defer: DeferCleanup) {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.ARCHIVIEW_CHROMIUM_PATH ? { executablePath: process.env.ARCHIVIEW_CHROMIUM_PATH } : {}) });
  defer(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"] });
  context.setDefaultTimeout(15_000);
  return context;
}

async function cliOrigin(defer: DeferCleanup, project: string) {
  const child = spawn(process.execPath, ["dist/cli.mjs", "--root", project, "--port", "0"], { windowsHide: true });
  defer(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const stopped = once(child, "exit");
    child.kill();
    await stopped;
  });
  let diagnostics = "";
  child.stderr.on("data", (part) => { diagnostics += part; });
  for await (const line of createInterface({ input: child.stdout })) {
    const match = /^ArchiView Local: (http:\/\/127\.0\.0\.1:\d+)$/.exec(line);
    if (match) return match[1];
  }
  throw new Error("Built CLI exited before listening. " + diagnostics);
}

test("standalone browser loads modules, navigates history, copies analysis and fits mobile", browserOptions, async (t) => {
  const defer = fixtureCleanup(t);
  const root = await browserProject(defer);
  const origin = await cliOrigin(defer, root);
  const context = await browserContext(defer);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(origin);
  const feature = page.getByRole("treeitem").filter({ hasText: "Функция браузера" });
  const icon = await page.locator('link[rel="icon"]').evaluate((link: HTMLLinkElement) => link.href);
  const fallback = await page.request.get(origin + "/favicon.ico");
  assert.equal(fallback.url(), icon);
  assert.equal(fallback.status(), 200);
  assert.match(fallback.headers()["content-type"], /image\/svg\+xml/);
  await feature.waitFor();
  await feature.click();
  await page.getByRole("heading", { name: "Функция браузера", exact: true }).waitFor();
  assert.equal(await page.locator("#module-meta #review-status .meta-value").innerText(), "Требует анализа");
  assert.equal(await feature.locator(".review-marker").getAttribute("title"), "Требует анализа");
  assert.equal(await page.locator('.tree-row[data-key="."] .review-marker').getAttribute("title"), "Требует анализа");
  await page.getByRole("tab", { name: /^Файлы/ }).click();
  await page.locator("#document-panel").getByText("feature.ts", { exact: true }).waitFor();
  await page.getByRole("tab", { name: "Контракт", exact: true }).click();
  await page.getByRole("button", { name: "Копировать промпт", exact: true }).click();
  await page.getByText("Промпт скопирован. Вставьте его в чат с агентом.", { exact: false }).waitFor();
  const prompt = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(prompt, /browser-feature/);
  assert.match(prompt, /--complete-analysis/);
  const timeline = page.locator("#timeline");
  const revision = await timeline.locator("option").evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value).find((value) => value.startsWith("git-")));
  assert.ok(revision);
  await timeline.selectOption(revision);
  await page.waitForFunction((id) => (document.querySelector("#timeline") as HTMLSelectElement).value === id && !(document.querySelector("#timeline") as HTMLSelectElement).disabled, revision);
  await timeline.selectOption("current");
  await page.waitForFunction(() => document.querySelector<HTMLSelectElement>("#timeline")?.value === "current"
    && !document.querySelector<HTMLSelectElement>("#timeline")?.disabled);
  await page.getByRole("button", { name: "Обновить", exact: true }).click();
  await page.getByRole("heading", { name: "Функция браузера", exact: true }).waitFor();
  const artifacts = path.resolve("dist/verification");
  await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, "web-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Модули", exact: true }).waitFor();
  await page.locator("#module-meta #review-status").waitFor({ state: "visible" });
  assert.equal(await page.locator("#review-status .meta-value").innerText(), "Требует анализа");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await page.screenshot({ path: path.join(artifacts, "web-mobile.png"), fullPage: true });
  // Own reviews remain independent: a parent relays a pending child only while collapsed.
  let childRequiresAnalysis = true;
  defer(() => page.unrouteAll({behavior:"wait"}));
  await page.route(url => url.pathname === "/api/review-statuses", async route => {
    const response = await route.fetch();
    const view: ComparisonView = await response.json();
    for (const module of view.modules) {
      for (const scope of [module.reviewStatus!.self, module.reviewStatus!.subtree]) {
        Object.assign(scope.current, { status: "fresh", conflict: false });
        Object.assign(scope.change, { status: "stale", conflict: true });
      }
      if (childRequiresAnalysis) {
        module.reviewStatus!.subtree.current.status = "stale";
        if (module.key === "src") module.reviewStatus!.self.current.status = "stale";
      }
    }
    await route.fulfill({ response, json: view });
  });
  await page.getByRole("button", { name: "Обновить", exact: true }).click();
  await page.waitForFunction(() => !(document.querySelector("#refresh") as HTMLButtonElement).disabled &&
    !document.querySelector("#updated")?.textContent?.includes("Загружаем"));
  await page.setViewportSize({ width: 1440, height: 1000 });
  const parentRow = page.locator('.tree-row[data-key="."]');
  assert.equal(await parentRow.getAttribute("aria-expanded"), "true");
  assert.equal(await parentRow.locator(".review-marker").count(), 0);
  assert.equal(await feature.locator(".review-marker").getAttribute("title"), "Требует анализа");
  await parentRow.click();
  await page.getByRole("heading", { name: "Новый заголовок проекта", exact: true }).waitFor();
  assert.equal(await page.locator("#review-status").count(), 0, "the parent's card only shows its own analysis");
  await parentRow.locator("[data-toggle]").click();
  assert.equal(await parentRow.getAttribute("aria-expanded"), "false");
  assert.equal(await parentRow.locator(".review-marker").getAttribute("title"), "Вложенные модули требуют анализа");
  await page.screenshot({ path: path.join(artifacts, "web-analysis-collapsed.png"), fullPage: true });
  await page.getByRole("searchbox").fill("Функция браузера");
  assert.equal(await parentRow.getAttribute("aria-expanded"), "true");
  assert.equal(await parentRow.locator(".review-marker").count(), 0, "search reveals the pending child");
  await page.getByRole("searchbox").fill("");
  assert.equal(await parentRow.getAttribute("aria-expanded"), "false");
  assert.equal(await parentRow.locator(".review-marker").count(), 1);
  await parentRow.locator("[data-toggle]").click();
  assert.equal(await parentRow.locator(".review-marker").count(), 0);
  assert.equal(await feature.locator(".review-marker").count(), 1);
  await page.screenshot({ path: path.join(artifacts, "web-analysis-expanded.png"), fullPage: true });
  // An outdated comparison assessment alone does not demand current-input analysis.
  childRequiresAnalysis = false;
  await page.getByRole("button", { name: "Обновить", exact: true }).click();
  await page.waitForFunction(() => !(document.querySelector("#refresh") as HTMLButtonElement).disabled &&
    !document.querySelector("#updated")?.textContent?.includes("Загружаем"));
  assert.equal(await page.locator("#review-status").count(), 0);
  assert.equal(await page.locator(".tree-row .review-marker").count(), 0);
  assert.deepEqual(errors, []);
});

test("a user can create, edit, reopen and delete a module prototype", browserOptions, async t => {
  const defer = fixtureCleanup(t);
  const root = await browserProject(defer);
  const app = await createArchiView({ root });
  const page = await (await browserContext(defer)).newPage();
  await page.goto(await listen(defer, app.server));
  const button = (name: string) => page.getByRole("button", { name, exact: true });
  const dialog = page.getByRole("dialog");
  for (const rootPath of ["", "/"]) {
    await button("Новый прототип").click();
    await dialog.getByLabel("Путь от корня репозитория").fill(rootPath);
    for (const label of ["ID модуля", "Название", "Назначение"])
      await dialog.getByLabel(label, { exact: true }).fill("aaa");
    await button("Создать").click();
    await page.locator('.tree-row[data-directory="aaa"][aria-selected="true"]').waitFor();
    assert.equal(parse(await readFile(path.join(root, ".archiview/modules.tree"), "utf8")).aaa, "aaa");
    await button("Удалить прототип").click();
    await dialog.getByRole("button", { name: "Удалить", exact: true }).click();
    await page.locator('.tree-row[data-directory="aaa"]').waitFor({ state: "detached" });
  }
  await button("Новый прототип").click();
  await dialog.getByLabel("Путь от корня репозитория").fill("future/catalog");
  await dialog.getByLabel("ID модуля").fill("catalog");
  await dialog.getByLabel("Название", { exact: true }).fill("Каталог");
  assert.equal(await dialog.getByLabel("Первая обязанность", { exact: true }).count(), 0);
  await dialog.getByLabel("Назначение").fill("Выдавать карточку товара");
  await button("Создать").click();
  await page.getByRole("heading", { name: "Каталог", exact: true }).waitFor();
  await button("Редактировать контракт").click();
  const yaml = dialog.getByLabel("Контракт YAML");
  assert.match(await yaml.inputValue(), /^purpose:/m);
  assert.doesNotMatch(await yaml.inputValue(), /^responsibilities:/m);
  await yaml.fill((await yaml.inputValue()).replace("title: Каталог", "title: Каталог магазина"));
  await button("Сохранить").click();
  await page.getByRole("heading", { name: "Каталог магазина", exact: true }).waitFor();
  await page.reload();
  await button("Удалить прототип").click();
  await dialog.getByRole("button", { name: "Отмена" }).click();
  await button("Удалить прототип").click();
  await dialog.getByRole("button", { name: "Удалить", exact: true }).click();
  await page.locator('.tree-row[data-directory="future/catalog"]').waitFor({ state: "detached" });
  await assert.rejects(stat(path.join(root, ".archiview/modules/catalog.yaml")), { code: "ENOENT" });
  await page.locator("#timeline").selectOption({ label: "HEAD" });
  await button("Новый прототип").waitFor({ state: "hidden" });
});

test("the prototype parent picker builds the saved path from the chosen module and ID", browserOptions, async t => {
  const defer = fixtureCleanup(t);
  const root = await browserProject(defer);
  await mkdir(path.join(root, "src/tools"));
  await writeFile(path.join(root, "src/tools/format.ts"), "export const format = String;");
  const app = await createArchiView({ root });
  const origin = await listen(defer, app.server);
  const page = await (await browserContext(defer)).newPage();
  await page.goto(origin);
  await page.getByRole("button", { name: "Новый прототип" }).click();
  const dialog = page.getByRole("dialog");
  const trigger = dialog.getByRole("button", { name: /Родительский модуль/ });
  const tree = dialog.getByRole("tree", { name: "Родительский модуль" });
  const id = dialog.getByLabel("ID модуля", { exact: true });
  const directory = dialog.getByLabel("Путь от корня репозитория");
  await id.fill("catalog");
  assert.equal(await directory.inputValue(), "catalog");
  await trigger.click();
  const src = tree.getByRole("treeitem", { name: /Функция браузера/ });
  await src.locator(".prototype-branch-toggle").click();
  await tree.getByRole("treeitem", { name: /src\/tools/ }).click();
  await tree.waitFor({ state: "hidden" });
  assert.equal(await directory.inputValue(), "src/tools/catalog");
  await id.fill("stock");
  assert.equal(await directory.inputValue(), "src/tools/stock");
  await directory.fill("custom/manual");
  await id.fill("items");
  assert.equal(await directory.inputValue(), "custom/manual");
  await trigger.click();
  await tree.getByRole("treeitem", { name: "Корень репозитория" }).click();
  assert.equal(await directory.inputValue(), "items");
  await trigger.press("ArrowDown");
  await src.focus();
  await src.press("ArrowRight");
  await page.keyboard.press("Enter");
  assert.equal(await directory.inputValue(), "src/tools/items");
  await trigger.click();
  await page.keyboard.press("Escape");
  assert.equal(await trigger.getAttribute("aria-expanded"), "false");
  for (const label of ["Название", "Назначение"])
    await dialog.getByLabel(label, { exact: true }).fill("Товары");
  await dialog.getByRole("button", { name: "Создать", exact: true }).click();
  await page.locator('.tree-row[data-directory="src/tools/items"][aria-selected="true"]').waitFor();
  assert.equal(parse(await readFile(path.join(root, ".archiview/modules.tree"), "utf8")).items, "src/tools/items");
});

test("contract clauses can be edited, added, deleted and restored from the working tree", browserOptions, async t => {
  const defer = fixtureCleanup(t);
  const root = await browserProject(defer);
  const file = path.join(root, ".archiview/modules/browser-feature.yaml");
  const base = parse(await readFile(file, "utf8"));
  base.boundaries = { B1: "Первая граница", B2: "Вторая граница", B3: "Третья граница" };
  await writeFile(file, stringify(base));
  commitTestFiles(root);
  const working = structuredClone(base);
  working.boundaries.B1 = "Изменение перед удалением";
  delete working.boundaries.B2;
  await writeFile(file, stringify(working));
  const app = await createArchiView({ root });
  const origin = await listen(defer, app.server);
  const page = await (await browserContext(defer)).newPage();
  await page.goto(origin + "/#src");
  const button = (name: string) => page.getByRole("button", { name, exact: true });
  const dialog = page.getByRole("dialog");
  const finish = async (name: string) => {
    await dialog.getByRole("button", { name, exact: true }).click();
    await dialog.waitFor({ state: "detached" });
  };
  const row = (id: string) => page.locator('.clause-row[data-clause-id="' + id + '"]');
  await page.locator(".contract-paper").getByRole("button", { name: "Редактировать назначение" }).click();
  assert.equal(await button("Удалить").count(), 0);
  await dialog.getByLabel("Текст пункта").fill("Новая формулировка обязанности");
  await finish("Сохранить");
  assert.equal(parse(await readFile(file, "utf8")).purpose, "Новая формулировка обязанности");
  for (const id of ["B1", "B3"]) {
    await button("Редактировать " + id).click();
    await finish("Удалить");
    assert.equal(await row(id).getAttribute("data-change-status"), "removed");
    assert.equal(await page.getByText("Пункт " + id + " удалён", { exact: true }).count(), 0);
  }
  for (const [section, id] of [["Границы", "B4"], ["Инварианты", "I1"]]) {
    await button("Добавить пункт · " + section).click();
    assert.equal(await dialog.getByRole("textbox").count(), 1);
    await dialog.getByLabel("Текст пункта").fill("Текст " + id);
    await finish("Добавить");
    await button("Редактировать " + id).waitFor();
  }
  await page.reload();
  await button("Редактировать B1").click();
  assert.equal(await dialog.getByLabel("Текст пункта").inputValue(), working.boundaries.B1);
  assert.equal(await dialog.getByLabel("Текст пункта").isEditable(), false);
  await finish("Восстановить");
  assert.deepEqual(parse(await readFile(file, "utf8")).boundaries, { B1: working.boundaries.B1, B4: "Текст B4" });
  await button("Редактировать B1").click();
  await finish("Откатить");
  assert.equal(await row("B1").getAttribute("data-change-status"), "unchanged");
  for (const id of ["B2", "B3"]) {
    await button("Редактировать " + id).click();
    assert.equal(await dialog.getByLabel("Текст пункта").inputValue(), base.boundaries[id]);
    await finish("Восстановить");
  }
  await button("Редактировать B4").click();
  await finish("Удалить");
  assert.equal(await row("B4").count(), 0);
  assert.deepEqual(Object.entries(parse(await readFile(file, "utf8")).boundaries), Object.entries(base.boundaries));
  await button("Добавить пункт · Границы").click();
  await finish("Восстановить B4");
  assert.equal(await row("B4").getAttribute("data-change-status"), "added");
  await button("Редактировать назначение").click();
  await finish("Откатить");
  assert.equal(parse(await readFile(file, "utf8")).purpose, base.purpose);
  await button("Редактировать I1").click();
  await dialog.getByLabel("Текст пункта").fill("Черновик");
  const external = (await readFile(file, "utf8")).replace("Текст I1", "Внешняя правка");
  await writeFile(file, external);
  await button("Сохранить").click();
  await dialog.getByRole("alert").filter({ hasText: "Контракт изменился" }).waitFor();
  assert.equal(await dialog.getByLabel("Текст пункта").inputValue(), "Черновик");
  assert.equal(await readFile(file, "utf8"), external);
  await button("Отмена").click();
  await page.locator("#timeline").selectOption({ label: "HEAD" });
  await button("Редактировать назначение").waitFor({ state: "detached" });
  await page.locator(".clause-row p").filter({ hasText: "Предоставлять функцию" }).waitFor();
  assert.equal(await page.getByRole("button", { name: /Редактировать|Добавить пункт|Восстановить/ }).count(), 0);
});

test("a native watch updates the selected files and review status after atomic saves, removals and commits", browserOptions, async t => {
  const defer = fixtureCleanup(t);
  const root = await browserProject(defer);
  const app = await createArchiView({ root });
  const origin = await listen(defer, app.server);
  const initial = await app.getComparison();
  for (const key of [".", "src"]) {
    const request = await app.prepareAnalysis({ view: initial.id, path: key });
    const folder = path.join(root, ".archiview/snapshots/analysis", request.id);
    const input: ReviewInput = parse(await readFile(path.join(folder, "input.yaml"), "utf8"));
    input.report.analysis.model = input.manifest.model = { provider: "test", id: "watch-fixture" };
    input.report.analysis.prompt_digest = input.manifest.prompt_digest = digest("Watch integration fixture");
    input.report.assessment.current = { verdict: "consistent", summary: "Fixture" };
    await writeFile(path.join(folder, "result.yaml"), stringify(input, { aliasDuplicateObjects: false }));
    await app.analysis.complete(request.id);
  }
  const page = await (await browserContext(defer)).newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin + "/#src");
  await page.getByRole("tab", {name: /^Файлы/}).click();
  const panel = page.locator("#document-panel");
  const source = panel.getByText("feature.ts", {exact: true});
  await source.waitFor();
  await page.waitForFunction(() => document.querySelector("#updated")?.textContent?.startsWith("Обновлено") &&
    !document.querySelector("#updated")?.textContent?.includes("Загружаем"));
  assert.equal(await page.locator("#review-status").count(), 0);
  // Atomic replacement with the HEAD bytes clears an existing diff, while the previous analysis expires.
  const temp = path.join(root, "src/editor.tmp");
  await writeFile(temp, "export const feature = 1;\n");
  const saved = performance.now();
  await rename(temp, path.join(root, "src/feature.ts"));
  await page.locator("#review-status").getByText("Требует анализа").waitFor();
  await panel.locator('.file-row[title="src/feature.ts"] .unchanged').waitFor();
  t.diagnostic("Atomic save to visible status and files: " + Math.round(performance.now() - saved) + " ms");
  assert.equal(await page.locator('.tree-row[data-key="."] .review-marker').count(), 0);
  const added = path.join(root, "src/new-file.ts");
  const name = panel.getByText("new-file.ts", {exact:true});
  await writeFile(added, "export const newValue = 1;\n");
  await name.waitFor();
  await rm(added);
  await name.waitFor({state:"hidden"});
  await writeFile(added, "export const newValue = 2;\n");
  await name.waitFor();
  const git = (...args: string[]) => promisify(execFile)("git", args, {cwd:root, windowsHide:true});
  await git("add", "src/new-file.ts");
  await git("-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "Add watched file");
  await panel.locator('.file-row[title="src/new-file.ts"] .unchanged').waitFor();
  assert.equal(await page.locator("#tab-files").getAttribute("aria-selected"), "true");
  assert.equal(new URL(page.url()).hash, "#src");
  const timeline = page.locator("#timeline");
  const revision = "git-" + (await git("rev-parse", "HEAD")).stdout.trim();
  await timeline.selectOption(revision);
  await page.waitForFunction(id => {
    const select = document.querySelector<HTMLSelectElement>("#timeline");
    return select?.value === id && !select.disabled;
  }, revision);
  let unexpectedReads = 0;
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname === "/api/comparison" && url.searchParams.get("target") === "current") unexpectedReads++;
  });
  await writeFile(path.join(root, "src/in-history.ts"), "later\\n");
  const untouched = await app.getComparison();
  assert.ok(untouched.modules.find(m => m.key === "src")?.filesChanged);
  assert.equal(await timeline.inputValue(), revision);
  assert.equal(unexpectedReads, 0);
  await timeline.selectOption("current");
  await panel.getByText("in-history.ts", {exact:true}).waitFor();
  assert.deepEqual(errors, []);
});

test("module files keep their directory and status on both sides of the comparison", browserOptions, async t => {
  const defer = fixtureCleanup(t);
  const root = await browserProject(defer);
  await mkdir(path.join(root, "docs"), { recursive: true });
  const oldPath = path.join(root, "docs/guide.md");
  await writeFile(oldPath, "Original guide");
  await writeFile(path.join(root, "docs/notes.md"), "Old notes\n");
  await writeFile(path.join(root, "docs/reference.md"), "First reference line\nSecond reference line\n");
  await promisify(execFile)("git", ["add", "docs"], { cwd: root });
  await promisify(execFile)("git", ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-qm", "Add guide"], { cwd: root });
  await rm(oldPath);
  await writeFile(path.join(root, "docs/notes.md"), "Updated notes\n");
  await mkdir(path.join(root, "docs/v2"));
  await writeFile(path.join(root, "docs/v2/guide.md"), "New guide");
  await writeFile(path.join(root, "guide.md"), "Project guide");
  await writeFile(path.join(root, "binary.dat"), Buffer.from([0, 255]));
  await writeFile(path.join(root, "empty.txt"), "");

  const origin = await cliOrigin(defer, root);
  const page = await (await browserContext(defer)).newPage();
  await page.goto(origin);
  await page.getByRole("tab", { name: /^Файлы/ }).click();
  const files = page.locator(".files-box");
  const docs = files.locator(":scope > details").filter({ has: page.getByTitle("docs/", { exact: true }) });
  await docs.locator(':scope > .file-row[title="docs/guide.md"] .removed').waitFor();
  await files.locator(':scope > .file-row[title="guide.md"] .new').waitFor();
  const nested = docs.locator(':scope > details > .file-row[title="docs/v2/guide.md"]');
  await nested.locator(".new").waitFor();
  await nested.getByRole("button", { name: "Копировать путь docs/v2/guide.md" }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "docs/v2/guide.md");

  const dialog = page.getByRole("dialog", { name: "Просмотр файла" });
  assert.equal(await nested.getByRole("button").count(), 2, "only the status and copy-path actions are present");
  await nested.getByRole("button", { name: "Новый — docs/v2/guide.md" }).click();
  await dialog.getByText("New guide", { exact: true }).waitFor();
  assert.deepEqual(await dialog.locator(".added .line-number").allTextContents(), ["", "1"]);
  await dialog.getByText("Нет перевода строки в конце файла").waitFor();
  await page.keyboard.press("Escape");
  await files.getByRole("button", { name: "Удалён — docs/guide.md", exact: true }).click();
  await dialog.getByText("Original guide", { exact: true }).waitFor();
  assert.deepEqual(await dialog.locator(".removed .line-number").allTextContents(), ["1", ""]);
  await dialog.getByRole("button", { name: "Закрыть" }).click();
  for (const [file, message] of [["binary.dat", "Двоичный файл"], ["empty.txt", "Добавлен пустой файл."]]) {
    await files.getByRole("button", { name: "Новый — " + file, exact: true }).click();
    await dialog.getByText(message, { exact: false }).waitFor();
    await page.keyboard.press("Escape");
  }
  await files.getByRole("button", { name: "Изменён — docs/notes.md" }).press("Enter");
  await dialog.locator(".added").getByText("Updated notes", { exact: true }).waitFor();
  assert.equal(await dialog.locator(".removed .line-content").innerText(), "Old notes");
  await page.keyboard.press("Escape");
  const unchanged = files.getByRole("button", { name: "Без изменений — docs/reference.md" });
  await unchanged.press("Space");
  await dialog.getByText("Second reference line", { exact: true }).waitFor();
  assert.deepEqual(await dialog.locator(".same .line-content").allTextContents(), ["First reference line", "Second reference line"]);
  assert.equal(await dialog.locator(".added, .removed").count(), 0);
  await page.keyboard.press("Escape");
  assert.ok(await unchanged.evaluate(button => button === document.activeElement));

  await docs.locator(":scope > summary").press("Enter");
  await nested.waitFor({ state: "hidden" });
  await page.getByRole("tab", { name: "Контракт", exact: true }).click();
  await page.getByRole("tab", { name: /^Файлы/ }).click();
  await docs.locator(":scope > summary").waitFor();
  assert.equal(await docs.getAttribute("open"), null);
  await docs.locator(":scope > summary").click();
  await nested.waitFor();
});

test("the file viewer keeps its header in place while scrolling and loading more rows", browserOptions, async t => {
  const defer = fixtureCleanup(t);
  const root = await browserProject(defer);
  await writeFile(path.join(root, "long.md"), Array.from({ length: 550 }, (_, i) => "Line " + (i + 1)).join("\n"));
  const app = await createArchiView({ root });
  const origin = await listen(defer, app.server);
  const page = await (await browserContext(defer)).newPage();
  await page.goto(origin);
  await page.getByRole("tab", { name: /^Файлы/ }).click();
  await page.getByRole("button", { name: "Новый — long.md" }).click();
  const dialog = page.getByRole("dialog", { name: "Просмотр файла" });
  const rows = dialog.locator(".diff-lines");
  await rows.getByText("Line 1", { exact: true }).waitFor();
  const header = dialog.locator(".evidence-heading, .diff-heading, .diff-labels");
  const positions = () => header.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
  const initial = await positions();
  const more = rows.getByRole("button", { name: "Показать ещё" });
  await more.scrollIntoViewIfNeeded();
  assert.ok(await rows.evaluate(node => node.scrollTop > 0));
  assert.deepEqual(await positions(), initial);
  await more.click();
  await rows.getByText("Line 550", { exact: true }).scrollIntoViewIfNeeded();
  assert.deepEqual(await positions(), initial);
  await dialog.getByRole("button", { name: "Закрыть" }).click();
  await dialog.waitFor({ state: "hidden" });
});

test("the file tab starts at each snapshot's module directory and excludes its contract", browserOptions, async t => {
  const defer = fixtureCleanup(t);
  const root = await browserProject(defer);
  const name = "browser-feature.yaml";
  await mkdir(path.join(root, "src/docs"));
  await writeFile(path.join(root, "src/docs", name), "module notes");
  commitTestFiles(root);
  const contractPath = path.join(root, ".archiview/modules", name);
  await writeFile(contractPath, (await readFile(contractPath, "utf8")).replace("Функция браузера", "Новый заголовок"));

  const origin = await cliOrigin(defer, root);
  const page = await (await browserContext(defer)).newPage();
  await page.goto(origin + "/#src");
  await page.getByRole("heading", { name: "Новый заголовок", exact: true }).waitFor();
  await page.getByRole("tab", { name: /^Файлы/ }).click();
  const files = page.locator(".files-box");
  await files.getByText("2 всего").waitFor();
  assert.equal(await page.locator("#files-count").isVisible(), false);
  assert.equal(await page.locator("#module-meta").getByText("Описание изменено").isVisible(), true);
  await files.locator(':scope > .file-row[title="src/feature.ts"]').waitFor();
  assert.deepEqual(await files.locator("summary").allTextContents(), ["docs/"]);
  await files.getByRole("button", { name: "Копировать путь src/docs/" + name }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), "src/docs/" + name);

  await rename(path.join(root, "src"), path.join(root, "renamed"));
  await writeModuleTree(root, { "browser-project": ".", "browser-feature": "renamed" });
  await page.goto(origin + "/#renamed");
  await page.reload();
  await page.getByRole("tab", { name: /^Файлы/ }).click();
  await files.getByText("4 всего").waitFor();
  assert.equal(await page.locator("#files-count").innerText(), "4");
  assert.deepEqual(await files.locator("summary").allTextContents(), ["docs/"]);
  const docs = files.locator(":scope > details");
  await docs.getByRole("button", { name: "Удалён — src/docs/" + name }).click();
  await page.getByRole("dialog").getByText("module notes", { exact: true }).waitFor();
  await page.keyboard.press("Escape");
  await docs.getByRole("button", { name: "Новый — renamed/docs/" + name }).waitFor();
});

test("files remain browsable while independent review statuses load, fail and retry", browserOptions, async t => {
  const defer = fixtureCleanup(t);
  const root = await browserProject(defer);
  const origin = await cliOrigin(defer, root);
  const page = await (await browserContext(defer)).newPage();
  let capture!: (route: import("playwright").Route) => void;
  const pending = new Promise<import("playwright").Route>(resolve => { capture = resolve; });
  await page.route("**/api/review-statuses?**", route => capture(route), {times:1});
  await page.goto(origin);
  const request = await pending;
  await page.locator('.tree-row[data-key="src"]').click();
  await page.getByRole("tab", {name:/^Файлы/}).click();
  await page.locator("#document-panel").getByText("feature.ts", {exact:true}).waitFor();
  assert.equal(await page.locator(".review-marker").count(),0);
  await request.fulfill({status:500,json:{error:"Ошибка чтения анализа"}});
  await page.locator("#updated").filter({hasText:"Ошибка чтения анализа"}).waitFor();
  await page.locator("#tab-findings").click();
  await page.getByRole("button",{name:"Повторить"}).click();
  await page.locator('.tree-row[data-key="src"] .review-marker').waitFor();
});

test("a reused directory retains its exact module under search and status filters", browserOptions, async (t) => {
  const defer = fixtureCleanup(t);
  const root = await browserProject(defer);
  const child = path.join(root, "src/undocumented");
  await mkdir(child);
  await writeFile(path.join(child, "child.ts"), "export const child = 1;");
  await writeFile(path.join(root, ".archiview/modules/browser-feature.yaml"), "\nextensions:\n  archiview.roles: [queue-consumer, queue-producer]\n", { flag: "a" });
  const rootDocument = path.join(root, ".archiview/modules/browser-project.yaml");
  const rootText = await readFile(rootDocument, "utf8");
  const setRootRoles = (ids: string[]) => writeFile(rootDocument, rootText + stringify({ extensions: { "archiview.roles": ids } }));
  await setRootRoles(["domain", "storage"]);
  const git = (args: string[]) => promisify(execFile)("git", args, { cwd: root, windowsHide: true });
  await git(["add", ".archiview/modules/browser-project.yaml", "src/undocumented", ".archiview/modules/browser-feature.yaml"]);
  await git(["-c", "user.name=Browser Test", "-c", "user.email=browser@example.test", "commit", "-qm", "Add child before replacement"]);
  await rm(child, { recursive: true });
  await setRootRoles(["ui", "domain"]);
  await rm(path.join(root, ".archiview/modules/browser-feature.yaml"));
  await writeModuleTree(root, { "browser-project": ".", replacement: "src" });
  await writeFile(path.join(root, ".archiview/modules/replacement.yaml"), stringify({ schema_version: 1, id: "replacement", title: "Новая функция",
    kind: "module", purpose: "Показать замену", boundaries: {}, invariants: {},
    extensions: { "archiview.roles": ["http-client"], "example.owner": "team" } }));
  const origin = await listen(defer, (await createArchiView({ root })).server);
  const page = await (await browserContext(defer)).newPage();
  await page.goto(origin);
  const rows = page.locator('.tree-row[data-directory="src"]');
  await rows.last().waitFor();
  assert.equal(await rows.count(), 2);
  const rootRow = page.locator('.tree-row[data-directory="."]');
  const badges = (selector: string) => page.locator(selector + " .role-badge").evaluateAll(nodes =>
    nodes.map(node => [node.textContent, (node as HTMLElement).dataset.changeStatus]));
  assert.deepEqual(await badges('.tree-row[data-directory="."]'), [["ui", "added"], ["domain", "unchanged"]]);
  await rootRow.click();
  await page.getByRole("heading", { name: "Роли по контракту" }).waitFor();
  assert.deepEqual((await page.locator(".contract-paper h3").allTextContents()).slice(0, 4),
    ["Роли по контракту", "Назначение", "Границы", "Инварианты"]);
  assert.equal(await page.locator("[data-clause-section=purpose]").count(), 1);
  assert.deepEqual(await badges(".contract-roles"), [["ui", "added"], ["domain", "unchanged"], ["storage", "removed"]]);
  await page.locator(".filter-chip.removed").click();
  assert.deepEqual(await rows.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.key)), ["src::removed"]);
  assert.equal(await rows.locator(".tree-roles").count(), 0);
  await rows.click();
  await page.getByRole("heading", { name: "Функция браузера", exact: true }).waitFor();
  await page.locator('.clause-row[data-change-status="removed"]').waitFor();
  assert.deepEqual(await badges(".contract-roles"), [["queue-consumer", "removed"], ["queue-producer", "removed"]]);
  const removedChild = page.locator('.tree-row[data-directory="src/undocumented"]');
  await removedChild.click();
  await page.getByRole("button", { name: "Открыть описание родителя" }).click();
  await page.getByRole("heading", { name: "Функция браузера", exact: true }).waitFor();
  await removedChild.click();
  await page.locator("#breadcrumbs").getByRole("button", { name: "src", exact: true }).click();
  await page.getByRole("heading", { name: "Функция браузера", exact: true }).waitFor();
  await page.locator(".filter-chip.all").click();
  await page.locator("#search").fill("replacement");
  assert.deepEqual(await rows.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.key)), ["src::new"]);
  assert.equal(await rows.locator('.role-badge[data-change-status="added"]').innerText(), "http-client");
  await rows.click();
  await page.getByRole("heading", { name: "Новая функция", exact: true }).waitFor();
  await page.locator('.clause-row[data-change-status="added"]').waitFor();
  assert.deepEqual(await page.locator(".contract-roles li").allTextContents(), ["http-client"]);
  assert.match(await page.locator(".contract-extra").first().innerText(), /example\.owner/);
});

test("a workspace keeps identical modules, history and deep links scoped to each repository", browserOptions, async (t) => {
  const defer = fixtureCleanup(t);
  const root = await mkdtemp(path.join(os.tmpdir(), "archiview-browser-workspace-"));
  defer(() => rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const revisions = new Map<string, string>();
  for (const name of ["alpha", "beta"]) {
    const repo = path.join(root, name);
    await mkdir(path.join(repo, "src"), { recursive: true });
    await writeModuleTree(repo, { project: ".", feature: "src" });
    for (const id of ["project", "feature"]) {
      await writeFile(path.join(repo, ".archiview/modules", id + ".yaml"), stringify({
        schema_version: 1, id, kind: "module", title: name + " " + id,
        purpose: name + " implementation", boundaries: {}, invariants: {},
      }));
    }
    await writeFile(path.join(repo, "src/feature.ts"), "export const feature = 1;\n");
    const git = (args: string[]) => promisify(execFile)("git", args, { cwd: repo, windowsHide: true });
    await git(["init", "-q"]);
    await git(["add", "."]);
    await git(["-c", "user.name=Browser Test", "-c", "user.email=test@example.invalid", "commit", "-qm", name + " initial"]);
    revisions.set(name, "git-" + (await git(["rev-parse", "HEAD"])).stdout.trim());
  }
  const origin = await listen(defer, (await createArchiView({ root })).server);
  const page = await (await browserContext(defer)).newPage();
  await page.goto(origin);
  const alpha = page.locator('[data-repository="alpha"][data-key="src"]');
  const beta = page.locator('[data-repository="beta"][data-key="src"]');
  await alpha.click();
  await page.getByRole("heading", { name: "alpha feature", exact: true }).waitFor();
  assert.ok(await page.getByRole("searchbox", { name: "Найти модуль в загруженных репозиториях" }).isVisible());
  assert.match(await page.locator("#module-total").getAttribute("title") ?? "", /1 из 2/);
  await page.locator('[data-repository-root="beta"]').click();
  await beta.click();
  await page.getByRole("heading", { name: "beta feature", exact: true }).waitFor();
  await page.locator(".contract-purpose").getByText("beta implementation", { exact: true }).waitFor();
  assert.ok(await page.getByRole("searchbox", { name: "Найти модуль", exact: true }).isVisible());
  assert.equal(await page.locator("#module-total").getAttribute("title"), "");
  assert.ok(await alpha.isVisible(), "the other open repository stays accessible");
  assert.equal(await alpha.getAttribute("aria-selected"), "false");
  assert.equal(await beta.getAttribute("aria-selected"), "true");
  const timeline = page.locator("#timeline");
  const betaRevision = revisions.get("beta")!;
  assert.equal(await timeline.locator('option[value="' + revisions.get("alpha") + '"]').count(), 0);
  await timeline.selectOption(betaRevision);
  await page.waitForFunction((id) => {
    const node = document.querySelector<HTMLSelectElement>("#timeline");
    return node?.value === id && !node.disabled;
  }, betaRevision);
  await alpha.click();
  await page.getByRole("heading", { name: "alpha feature", exact: true }).waitFor();
  assert.equal(await timeline.locator('option[value="' + betaRevision + '"]').count(), 0);
  await beta.click();
  await page.getByRole("heading", { name: "beta feature", exact: true }).waitFor();
  assert.equal(await timeline.inputValue(), betaRevision);

  let capture!: (route: import("playwright").Route) => void;
  const pendingAlpha = new Promise<import("playwright").Route>((resolve) => { capture = resolve; });
  await page.route("**/api/module?**", (route) => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get("repository") === "alpha" && query.get("path") === "src") return capture(route);
    return route.continue();
  });
  await alpha.click();
  const late = await pendingAlpha;
  const oldDetail = await late.fetch();
  await beta.click();
  await page.locator(".contract-purpose").getByText("beta implementation", { exact: true }).waitFor();
  const received = page.waitForResponse((response) => response.url() === late.request().url());
  await late.fulfill({ response: oldDetail });
  await received;
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.ok(await page.locator(".contract-purpose").getByText("beta implementation", { exact: true }).isVisible());
  assert.equal(await beta.getAttribute("aria-selected"), "true");

  const repositoriesRequested: (string | null)[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/comparison") repositoriesRequested.push(url.searchParams.get("repository"));
  });
  await page.reload();
  await page.getByRole("heading", { name: "beta feature", exact: true }).waitFor();
  await page.locator("#updated").filter({ hasText: /^Обновлено/ }).waitFor();
  assert.deepEqual(repositoriesRequested, ["beta"]);
  await page.getByRole("button", { name: "Копировать промпт", exact: true }).click();
  await page.getByText("Промпт скопирован. Вставьте его в чат с агентом.", { exact: false }).waitFor();
  const prompt = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(prompt.includes('"project":' + JSON.stringify(path.join(root, "beta"))));

  repositoriesRequested.length = 0;
  await page.evaluate(() => history.replaceState(null, "", "#?repository=removed&module=src"));
  await page.reload();
  await page.getByRole("heading", { name: "alpha project", exact: true }).waitFor();
  await page.locator("#updated").filter({ hasText: /^Обновлено/ }).waitFor();
  assert.deepEqual(repositoriesRequested, ["removed", null]);

  repositoriesRequested.length = 0;
  await page.route("**/api/comparison?**", (route) => route.fulfill({
    status: 500, json: { code: "INTERNAL_ERROR", error: "Ошибка чтения истории beta" },
  }));
  await page.evaluate(() => history.replaceState(null, "", "#?repository=beta&module=src"));
  await page.reload();
  await page.getByText("Ошибка чтения истории beta", { exact: true }).waitFor();
  assert.deepEqual(repositoriesRequested, ["beta"]);
});

test("analysis reuses a prepared request after clipboard denial and refreshes only after import", browserOptions, async t => {
  const defer = fixtureCleanup(t);
  const root = await browserProject(defer);
  const app = await createArchiView({ root });
  const page = await (await browserContext(defer)).newPage();
  let preparedCount = 0;
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/analysis") preparedCount++;
  });
  await page.goto(await listen(defer, app.server) + "/#src");
  await page.evaluate(() => {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true, value: Promise.reject.bind(Promise, new DOMException("Нет разрешения", "NotAllowedError")),
    });
  });
  const copy = page.getByRole("button", { name: "Копировать промпт", exact: true });
  const preparation = page.waitForResponse(response => new URL(response.url()).pathname === "/api/analysis");
  await copy.click();
  const request = await (await preparation).json();
  const status = page.locator("#analysis-status");
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>("#analyze-module")?.disabled);
  assert.match(await status.textContent() ?? "", /Не удалось скопировать промпт: Нет разрешения/);
  await page.evaluate(() => Reflect.deleteProperty(navigator.clipboard, "writeText"));
  await copy.click();
  await status.filter({hasText: "Ожидаем импорт"}).waitFor();
  assert.equal(preparedCount, 1);
  assert.equal((await page.evaluate(() => navigator.clipboard.readText())).replace(/\r\n/g, "\n"), request.prompt);
  assert.equal((await app.getAnalysis({ id: request.id })).status, "prepared");

  const folder = path.join(root, ".archiview/snapshots/analysis", request.id);
  const result: ReviewInput = parse(await readFile(path.join(folder, "input.yaml"), "utf8"));
  result.report.analysis.model = result.manifest.model = { provider: "test", id: "browser-import" };
  result.report.analysis.prompt_digest = result.manifest.prompt_digest = digest("Standalone import fixture");
  result.report.assessment.current = { verdict: "consistent", summary: "Проверка из браузерного теста" };
  await writeFile(path.join(folder, "result.yaml"), stringify(result, { aliasDuplicateObjects: false }));
  assert.equal((await app.getAnalysis({ id: request.id })).status, "prepared");
  await app.analysis.complete(request.id);
  await status.filter({hasText: "Анализ выбранного снимка сохранён"}).waitFor();
  await page.locator("#tab-checks").click();
  await page.getByText("Полный отчёт", { exact: true }).click();
  await page.locator(".raw-document pre").filter({ hasText: "Проверка из браузерного теста" }).waitFor();
});

test("navigation cancels an in-flight analysis poll and resumes it only on return", browserOptions, async (t) => {
  const defer = fixtureCleanup(t);
  const root = await browserProject(defer);
  const app = await createArchiView({ root });
  const origin = await listen(defer, app.server);
  const context = await browserContext(defer);
  const page = await context.newPage();
  await page.clock.install();
  let received!: (route: import("playwright").Route) => void;
  const firstPoll = new Promise<import("playwright").Route>((resolve) => { received = resolve; });
  let pollCount = 0;
  await page.route("**/api/analysis/*", (route) => {
    if (++pollCount === 1) { received(route); return; }
    return route.continue();
  });
  await page.goto(origin);
  await page.getByRole("button", { name: "Копировать промпт", exact: true }).click();
  await page.locator("#analysis-status").filter({hasText: "Промпт скопирован."}).waitFor();
  await page.clock.fastForward(3100);
  const oldPoll = await firstPoll;
  const status = await (await oldPoll.fetch()).json();

  const targets: string[] = [];
  let selected!: (route: import("playwright").Route) => void;
  const firstNavigation = new Promise<import("playwright").Route>((resolve) => { selected = resolve; });
  await page.route("**/api/comparison?**", (route) => {
    const target = new URL(route.request().url()).searchParams.get("target")!;
    targets.push(target);
    if (targets.length === 1) { selected(route); return; }
    return route.continue();
  });
  const timeline = page.locator("#timeline");
  const revision = await timeline.getByRole("option", { name: "HEAD", exact: true }).getAttribute("value");
  assert.ok(revision);
  await timeline.selectOption(revision);
  const selection = await firstNavigation;
  await oldPoll.fulfill({ json: { ...status, status: "completed" } });
  await selection.fulfill({ status: 500, json: { error: "История временно недоступна" } });
  const retry = page.getByRole("button", { name: "Повторить", exact: true });
  await retry.waitFor();
  await page.clock.runFor(6100);
  assert.equal(pollCount, 1, "the failed history selection must keep its retry without resuming the previous poll");
  await retry.click();
  const waitForTarget = (id: string) => page.waitForFunction((target) => {
    const select = document.querySelector<HTMLSelectElement>("#timeline");
    return select?.value === target && !select.disabled;
  }, id);
  await waitForTarget(revision);
  assert.deepEqual(targets, [revision, revision], "late completion cannot supersede the user's history selection");
  await page.clock.fastForward(6000);
  assert.equal(pollCount, 1);

  // The inactive response was discarded. Re-entering that exact view must ask the server again.
  await timeline.selectOption("current");
  await waitForTarget("current");
  const resumed = page.waitForResponse((response) => new URL(response.url()).pathname.startsWith("/api/analysis/"));
  await page.clock.fastForward(3100);
  await resumed;
  await timeline.selectOption(revision);
  await waitForTarget(revision);
  await page.clock.fastForward(6000);
  assert.equal(pollCount, 2, "a prepared request in another view must stay idle");
});

test("retry preserves the failed navigation and reloads a comparison only for an expired module view", browserOptions, async (t) => {
  const defer = fixtureCleanup(t);
  const root = await browserProject(defer);
  const app = await createArchiView({ root });
  const origin = await listen(defer, app.server);
  const page = await (await browserContext(defer)).newPage();
  await page.goto(origin);
  await page.locator(".contract-paper").waitFor();
  const timeline = page.locator("#timeline");
  const revision = await timeline.getByRole("option", { name: "HEAD", exact: true }).getAttribute("value");
  assert.ok(revision);

  const comparisons: string[] = [];
  await page.route("**/api/comparison?**", (route) => {
    comparisons.push(new URL(route.request().url()).search);
    if (comparisons.length === 1) return route.fulfill({ status: 500, json: { error: "История недоступна" } });
    return route.continue();
  });
  const modules: string[] = [];
  let received!: (route: import("playwright").Route) => void;
  const previousModule = new Promise<import("playwright").Route>((resolve) => { received = resolve; });
  let nextModule: "hold" | "fail" | "expire" | undefined = "hold";
  await page.route("**/api/module?**", (route) => {
    const action = nextModule;
    nextModule = undefined;
    modules.push(new URL(route.request().url()).search);
    if (action === "hold") { received(route); return; }
    if (action === "fail") return route.fulfill({ status: 500, json: { error: "Модуль недоступен" } });
    if (action === "expire") return route.fulfill({ status: 409, json: { code: "STALE_VIEW", error: "Сравнение устарело" } });
    return route.continue();
  });
  const treeItem = (label: string) => page.getByRole("treeitem").filter({ hasText: label });
  await treeItem("Функция браузера").click();
  const held = await previousModule;
  await timeline.selectOption(revision);
  await page.getByText("История недоступна", { exact: true }).waitFor();
  await held.fulfill({ status: 500, json: { error: "Поздний отказ прежнего модуля" } });
  const retry = page.getByRole("button", { name: "Повторить", exact: true });
  await retry.click();
  await page.locator(".contract-paper").waitFor();
  assert.equal(await timeline.inputValue(), revision);
  assert.deepEqual(comparisons, [comparisons[0], comparisons[0]]);
  assert.equal(new URLSearchParams(comparisons[0]).get("target"), revision);

  nextModule = "fail";
  await treeItem("Новый заголовок проекта").click();
  await page.getByText("Модуль недоступен", { exact: true }).waitFor();
  const failedModule = modules.at(-1);
  await retry.click();
  await page.locator(".contract-paper").waitFor();
  assert.equal(modules.at(-1), failedModule, "retry uses the same view and module");
  assert.equal(comparisons.length, 2);

  nextModule = "expire";
  await treeItem("Функция браузера").click();
  await page.getByText("Сравнение устарело", { exact: true }).waitFor();
  await retry.click();
  await page.locator(".contract-paper").waitFor();
  assert.equal(comparisons.length, 3);
  assert.equal(comparisons[2], comparisons[1]);
  assert.equal(new URLSearchParams(modules.at(-1)).get("path"), "src");
});

test("retrying a finding link reveals the original clause only after its document loads", browserOptions, async (t) => {
  const defer = fixtureCleanup(t);
  const root = await browserProject(defer);
  const app = await createArchiView({ root });
  const origin = await listen(defer, app.server);
  const review = createReviewInput(digest(app.store.snapshotRoot), null, await captureWorkingTree(root), "browser-project");
  const reference = review.report.checks.find((check) => check.contract.id === "purpose")!.contract;
  review.report.analysis.model = review.manifest.model = { provider: "test", id: "browser-fixture" };
  review.report.analysis.prompt_digest = review.manifest.prompt_digest = digest("Finding navigation fixture");
  review.report.analysis.input_digest = digest(review.manifest);
  review.report.findings = [{ id: "finding-link", kind: "responsibility_gap", severity: "warning",
    certainty: "confirmed", lifecycle: "unknown", summary: "Проверить пункт", clauses: [reference],
    evidence: [{ snapshot: "current", fact_id: review.current.facts[0].id }] }];
  await app.reports.saveReview(review);

  const page = await (await browserContext(defer)).newPage();
  await page.goto(origin);
  await page.locator("#tab-findings").click();
  await page.getByRole("button", { name: "Копировать промпт исправления", exact: true }).click();
  await page.locator(".finding-fix-status").filter({hasText: "Промпт скопирован."}).waitFor();
  const fixPrompt = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(fixPrompt.includes("finding-link"));
  assert.ok(fixPrompt.includes(JSON.stringify(root)));
  const link = page.locator(".finding-clauses button").first();
  await link.waitFor();
  const requested: string[] = [];
  await page.route("**/api/module?**", (route) => {
    requested.push(new URL(route.request().url()).search);
    if (requested.length === 1) return route.fulfill({ status: 500, json: { error: "Документ временно недоступен" } });
    if (requested.length === 2) return route.fulfill({ status: 409, json: { code: "STALE_VIEW", error: "Обновите сравнение" } });
    return route.continue();
  });
  await link.click();
  const retry = page.getByRole("button", { name: "Повторить", exact: true });
  for (const error of ["Документ временно недоступен", "Обновите сравнение"]) {
    await page.getByText(error, { exact: true }).waitFor();
    assert.equal(await page.locator("[data-historical-clause]").count(), 0);
    await retry.click();
  }
  const clause = page.locator(".clause-target:focus");
  await clause.waitFor();
  assert.equal(await clause.getAttribute("data-clause-id"), reference.id);
  assert.equal(requested[1], requested[0], "the first retry must keep the same module and view");
});

test("native own finding navigates to its saved ancestor clause and retains historical text after changes", browserOptions, async (t) => {
  const defer = fixtureCleanup(t);
  const root = await browserProject(defer);
  const contractFile = path.join(root, ".archiview/modules/browser-project.yaml");
  const savedText = "Граница предка из сохранённого снимка.";
  const contract = (await readFile(contractFile, "utf8")).replace("boundaries: {}", "boundaries:\n  B1: " + savedText);
  await writeFile(contractFile, contract);
  const app = await createArchiView({ root });
  const origin = await listen(defer, app.server);
  const input = createReviewInput(digest(app.store.snapshotRoot), null, await captureWorkingTree(root), "browser-feature");
  const reference = { snapshot: "current", module_id: "browser-project", section: "boundaries", id: "B1" } as const;
  input.report.analysis.model = input.manifest.model = { provider: "test", id: "ancestor-navigation-fixture" };
  input.report.analysis.prompt_digest = input.manifest.prompt_digest = digest("Own review ancestor finding browser fixture");
  input.report.analysis.input_digest = digest(input.manifest);
  input.report.findings = [{ id: "ancestor-link", kind: "boundary_violation", severity: "warning", certainty: "confirmed",
    lifecycle: "unknown", summary: "Проверить ограничение предка", clauses: [reference],
    evidence: [{ snapshot: "current", fact_id: input.current.facts[0].id }] }];
  assert.ok(input.manifest.contracts.current.every(item => item.reference.module_id === "browser-feature"));
  await app.reports.saveReview(input);

  const page = await (await browserContext(defer)).newPage();
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  async function openFinding() {
    await page.getByRole("treeitem").filter({ hasText: "Функция браузера" }).click();
    await page.getByRole("heading", { name: "Функция браузера", exact: true }).waitFor();
    await page.locator("#tab-findings").click();
    const link = page.locator(".finding-clauses button").first();
    await link.waitFor();
    await link.click();
  }
  await openFinding();
  const target = page.locator(".clause-target:focus");
  await target.waitFor();
  assert.equal(await target.getAttribute("data-clause-id"), "B1");
  assert.equal(await target.getAttribute("data-clause-section"), "boundaries");
  assert.match(await target.innerText(), new RegExp(savedText));
  assert.equal(await page.locator("[data-historical-clause]").count(), 0);

  await writeFile(contractFile, contract.replace(savedText, "Позднейшая граница с тем же ID."));
  await page.locator("#refresh").click();
  await page.waitForFunction(() => !(document.querySelector("#refresh") as HTMLButtonElement).disabled);
  await openFinding();
  const historical = page.locator("[data-historical-clause]:focus");
  await historical.waitFor();
  assert.equal(await historical.locator(".historical-clause-text").innerText(), savedText);
  assert.equal(await historical.locator(".historical-clause-missing").count(), 0);
  assert.match(await historical.locator(".historical-clause-origin").innerText(), /проверенная версия/);
  assert.deepEqual(errors, []);
});
