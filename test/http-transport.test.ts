import type { AddressInfo } from "node:net";
import type { TestContext } from "node:test";
/** Проверяет, что некорректная цель запроса становится ответом транспорта, а не падением сервера. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { stringify } from "yaml";
import { createArchiView } from "../src/archiview/http.js";

/** Изолированный проект и порт принадлежат тесту; рабочие исходники пользователя не читаются. */
async function serve(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "archiview-transport-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "arch.yaml"), stringify({ schema_version: 1, id: "root", title: "Пример",
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

test("malformed JSON returns a client error without breaking later operations", async (t) => {
  const app = await serve(t);
  const response = await fetch(app.url + "/api/analysis", { method: "POST", body: "{" });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, "INVALID_ARGUMENT");
  assert.equal((await fetch(app.url + "/api/comparison")).status, 200);
});
