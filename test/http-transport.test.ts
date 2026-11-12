import { writeModuleTree } from "./support.js";
import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
/** Проверяет, что некорректная цель запроса становится ответом транспорта, а не падением сервера. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { createArchiView } from "../src/archiview/http.js";

test("standalone CLI serves the shell before opening a project session", { timeout: 15000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "archiview-cli-start-"));
  const entry = fileURLToPath(new URL("../src/archiview/packaged-cli.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", "tsx", entry, "--root", root, "--port", "0"], { windowsHide: true });
  const closed = once(child, "close");
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      const match = /^ArchiView Local: (http:\/\/127\.0\.0\.1:\d+)$/.exec(line);
      if (!match) continue;
      assert.equal((await fetch(match[1])).status, 200);
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
  await writeModuleTree(root, { root: "." });
  await writeFile(path.join(root, ".archiview/modules/root.yaml"), stringify({ schema_version: 1, id: "root", title: "Пример",
    kind: "module", purpose: "Возвращать значение.", responsibilities: { R1: "Возвращать значение." },
    boundaries: {}, invariants: {} }));
  await writeFile(path.join(root, "code.js"), "export const value = 1;\n");
  const app = await createArchiView({ root });
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(() => new Promise<void>((resolve) => { app.server.closeAllConnections(); app.server.close(() => resolve()); }));
  return { ...app, root, url: "http://127.0.0.1:" + (app.server.address() as AddressInfo).port };
}

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

test("HTTP serves the published view and rejects malformed publication selectors", async (t) => {
  const app = await serve(t);
  const url = app.url + "/api/comparison?published=";
  assert.equal((await fetch(url + "sometimes")).status, 400);
  assert.equal((await fetch(url + "true&historyLimit=0")).status, 400);
  const current = await (await fetch(url + "false")).json();
  const published = await (await fetch(url + "true")).json();
  assert.equal(current.published, undefined);
  assert.equal(published.published, true);
  assert.equal(published.after.id, current.after.id);
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
