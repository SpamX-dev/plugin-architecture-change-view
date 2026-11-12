/** Real browser acceptance of the built standalone app; never opens a host client. */
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { build } from "esbuild";
import { stringify } from "yaml";
import { createArchiView } from "../src/archiview/http.js";
import { createArchiViewSession } from "../src/application/session.js";
import { createRouteTable } from "../src/dsh/routes.js";
import { createReviewInput } from "../src/reports/review-input.js";
import { digest } from "../src/serialization/digest.js";
import { captureWorkingTree } from "../src/snapshots/capture.js";

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
    purpose: "Показывать проверяемую функцию", responsibilities: { R1: "Предоставлять функцию" }, boundaries: {}, invariants: {} });
  await writeFile(path.join(root, "arch.yaml"), contract("browser-project", "Браузерный проект"));
  await writeFile(path.join(root, "src/arch.yaml"), contract("browser-feature", "Функция браузера"));
  await writeFile(path.join(root, "src/feature.ts"), "export const feature = 1;\n");
  const run = promisify(execFile);
  const git = (args: string[]) => run("git", args, { cwd: root, windowsHide: true });
  await git(["init", "-q"]);
  await git(["add", "."]);
  await git(["-c", "user.name=Browser Test", "-c", "user.email=browser@example.test", "commit", "-qm", "Initial feature"]);
  await writeFile(path.join(root, "arch.yaml"), contract("browser-project", "Новый заголовок проекта"));
  await git(["add", "arch.yaml"]);
  await git(["-c", "user.name=Browser Test", "-c", "user.email=browser@example.test", "commit", "-qm", "Update root contract"]);
  await writeFile(path.join(root, "src/feature.ts"), "export const feature = 2;\n");
  return root;
}

async function listen(defer: DeferCleanup, server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  defer(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return "http://127.0.0.1:" + address.port;
}

async function browserContext(defer: DeferCleanup) {
  const browser = await chromium.launch({ headless: true,
    ...(process.env.ARCHIVIEW_CHROMIUM_PATH ? { executablePath: process.env.ARCHIVIEW_CHROMIUM_PATH } : {}) });
  defer(() => browser.close());
  return browser.newContext({ viewport: { width: 1440, height: 1000 }, permissions: ["clipboard-read", "clipboard-write"] });
}

/** Exercise a source checkout with installed dependencies and no generated assets. */
async function sourceCliOrigin(defer: DeferCleanup, project: string) {
  const checkout = await mkdtemp(path.join(os.tmpdir(), "archiview-source-start-"));
  defer(() => rm(checkout, { recursive: true, force: true, maxRetries: 5 }));
  for (const name of ["src", "web", "scripts", "tsconfig.json", "package.json"]) {
    await cp(path.resolve(name), path.join(checkout, name), { recursive: true });
  }
  await symlink(path.resolve("node_modules"), path.join(checkout, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  const args = ["--import", "tsx", "src/archiview/cli.ts", "--root", project];
  await promisify(execFile)(process.execPath, [...args, "--build-report", "--port", "unused"], { cwd: checkout, windowsHide: true });
  await assert.rejects(stat(path.join(checkout, "dist")), { code: "ENOENT" });
  const invalid = path.join(checkout, "web", "invalid.ts");
  await writeFile(invalid, "export const value: number = 'invalid';\n");
  await assert.rejects(promisify(execFile)(process.execPath, [...args, "--port", "0"], { cwd: checkout, windowsHide: true, timeout: 15000 }),
    (error: Error & { stdout?: string }) => /TS2322/.test(error.stdout ?? ""));
  await assert.rejects(stat(path.join(checkout, "dist", "web")), { code: "ENOENT" });
  await rm(invalid);
  const child = spawn(process.execPath, [...args, "--port", "0"], { cwd: checkout, windowsHide: true });
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
  throw new Error("Source CLI exited before listening. " + diagnostics);
}

test("standalone browser loads modules, navigates history, copies analysis and fits mobile", browserOptions, async (t) => {
  const defer = fixtureCleanup(t);
  const root = await browserProject(defer);
  const origin = await sourceCliOrigin(defer, root);
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
  await page.getByRole("button", { name: "Обновить", exact: true }).click();
  await page.getByRole("heading", { name: "Функция браузера", exact: true }).waitFor();
  const artifacts = path.resolve("dist/verification");
  await mkdir(artifacts, { recursive: true });
  await page.screenshot({ path: path.join(artifacts, "web-desktop.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Модули", exact: true }).waitFor();
  await page.locator("#review-status").waitFor({ state: "visible" });
  assert.match(await page.locator("#review-status").innerText(), /Модуль.*Поддерево/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  await page.screenshot({ path: path.join(artifacts, "web-mobile.png"), fullPage: true });
  assert.deepEqual(errors, []);
});

test("a reused directory retains its exact module under search and status filters", browserOptions, async (t) => {
  const defer = fixtureCleanup(t);
  const root = await browserProject(defer);
  const child = path.join(root, "src/undocumented");
  await mkdir(child);
  await writeFile(path.join(child, "child.ts"), "export const child = 1;");
  await writeFile(path.join(root, "src/arch.yaml"), "\nextensions:\n  archiview.roles: [queue-consumer, queue-producer]\n", { flag: "a" });
  const rootDocument = path.join(root, "arch.yaml");
  const rootText = await readFile(rootDocument, "utf8");
  const setRootRoles = (ids: string[]) => writeFile(rootDocument, rootText + stringify({ extensions: { "archiview.roles": ids } }));
  await setRootRoles(["domain", "storage"]);
  const git = (args: string[]) => promisify(execFile)("git", args, { cwd: root, windowsHide: true });
  await git(["add", "arch.yaml", "src/undocumented", "src/arch.yaml"]);
  await git(["-c", "user.name=Browser Test", "-c", "user.email=browser@example.test", "commit", "-qm", "Add child before replacement"]);
  await rm(child, { recursive: true });
  await setRootRoles(["ui", "domain"]);
  await writeFile(path.join(root, "src/arch.yaml"), stringify({ schema_version: 1, id: "replacement", title: "Новая функция",
    kind: "module", purpose: "Заменить прежнюю функцию", responsibilities: { R1: "Показать замену" }, boundaries: {}, invariants: {},
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

test("dsh browser ties delivery and navigation to the active host and comparison", browserOptions, async (t) => {
  const defer = fixtureCleanup(t);
  const root = await browserProject(defer);
  const session = await createArchiViewSession({ root });
  const routes = createRouteTable({ prefix: "/archiview", guard: () => false, getSession: () => session });
  const route = routes.find((entry) => entry.kind === "prefix")!;
  const hostBridge = await build({ entryPoints: ["src/dsh/client/frame-bridge.ts"], bundle: true,
    format: "iife", globalName: "archiviewBridge", write: false });
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/archiview/")) { void route.handler(request, response); return; }
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(`<style>body { margin: 0 } iframe { width: 100vw; height: 100vh; border: 0; display: block }</style>
    <button id="switch">Сменить чат</button><iframe src="/archiview/?session=fixture"></iframe><script>
      ${hostBridge.outputFiles[0].text}
      const frame = document.querySelector("iframe");
      const sendPrompt = location.search === "?send" ? window.recordDelivery : undefined;
      let detach = archiviewBridge.listenToFrame(frame, { sessionId: "fixture", sendPrompt });
      document.querySelector("#switch").onclick = () => {
        detach();
        detach = archiviewBridge.listenToFrame(frame, { sessionId: "next", sendPrompt });
      };
    </script>`);
  });
  const origin = await listen(defer, server);
  const page = await (await browserContext(defer)).newPage();
  let clipboardWrites = 0;
  const recipients: string[] = [];
  await page.exposeFunction("recordDelivery", (sessionId: string) => { recipients.push(sessionId); });
  const requests: { view: string; path: string }[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/archiview/api/analysis") requests.push(request.postDataJSON());
  });
  await page.exposeFunction("trackClipboard", () => { clipboardWrites++; });
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: Reflect.get(window, "trackClipboard") } });
  });
  await page.goto(origin);
  const panel = page.frameLocator("iframe");
  const analysis = panel.locator("[data-analysis]").first();
  await panel.locator(".contract-paper").waitFor();
  assert.ok(await analysis.isDisabled());
  await analysis.dispatchEvent("click");
  assert.equal(clipboardWrites, 0);
  assert.equal(requests.length, 0);

  await page.goto(origin + "/?send");
  await panel.getByRole("button", { name: "Анализировать модуль", exact: true }).click();
  await panel.getByText("Поручение передано агенту хоста.", { exact: false }).waitFor();
  const currentRequest = requests[0];
  assert.ok(currentRequest);
  const timeline = panel.locator("#timeline");
  const revision = await timeline.getByRole("option", { name: "HEAD", exact: true }).getAttribute("value");
  assert.ok(revision);
  await timeline.selectOption(revision);
  await panel.locator(".raw-document").waitFor();
  await panel.getByRole("button", { name: "Анализировать модуль", exact: true }).click();
  await panel.getByText("Поручение передано агенту хоста.", { exact: false }).waitFor();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].path, currentRequest.path);
  assert.notEqual(requests[1].view, currentRequest.view);

  await panel.locator(".raw-document > summary").click();
  await panel.getByRole("button", { name: "Диф arch.yaml" }).click();
  assert.match(await panel.locator(".diff-labels").innerText(), /Revision [a-f0-9]+ → HEAD/);
  await panel.getByRole("button", { name: "Закрыть", exact: true }).click();

  // An imported review and a manual refresh can overlap. Deliver the old failure last.
  let holdFirst = true;
  let captured!: (request: import("playwright").Route) => void;
  const held = new Promise<import("playwright").Route>((resolve) => { captured = resolve; });
  await page.route("**/archiview/api/comparison?**", (request) => {
    if (holdFirst) { holdFirst = false; captured(request); return; }
    return request.continue();
  });
  await panel.locator("#refresh").click();
  const old = await held;
  const updated = page.waitForResponse((response) => new URL(response.url()).pathname === "/archiview/api/module");
  await panel.locator("#refresh").dispatchEvent("click");
  await updated;
  await panel.locator(".contract-paper").waitFor();
  await old.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "old comparison failed" }) });
  const frame = page.frames().find((item) => new URL(item.url()).pathname === "/archiview/")!;
  await frame.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  assert.equal(await panel.getByText("old comparison failed").count(), 0);
  assert.ok(await panel.locator(".contract-paper").isVisible());
  assert.equal(clipboardWrites, 0);

  // postMessage queues SEND. Rebind the very same iframe before its parent receives it.
  const delayed = await frame.evaluate(async () => {
    const { connectPanel } = await import(new URL("panel-bridge.mjs", location.href).href);
    const bridge = await connectPanel();
    const pending = bridge.send("Отложенное поручение");
    parent.document.querySelector<HTMLButtonElement>("#switch")!.click();
    return pending.then(() => "sent", (error: Error) => error.message);
  });
  assert.match(delayed, /Чат поручения не совпадает/);
  assert.deepEqual(recipients, ["fixture", "fixture"]);
  await page.locator("iframe").evaluate((element) => element.setAttribute("src", "/archiview/?session=next"));
  await panel.getByRole("button", { name: "Анализировать модуль", exact: true }).click();
  await panel.getByText("Поручение передано агенту хоста.", { exact: false }).waitFor();
  assert.deepEqual(recipients, ["fixture", "fixture", "next"]);
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
  await page.locator("#analysis-status").getByText("Промпт скопирован.", { exact: false }).waitFor();
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
  const reference = review.report.checks.find((check) => check.contract.id === "R1")!.contract;
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
