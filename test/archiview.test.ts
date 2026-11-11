import type { ComparisonResponse, ModuleResponse } from "./support.js";
import type { AddressInfo } from "node:net";
/** Проверки реального HTTP-контракта просмотра, удалённых модулей и снимков. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createArchiView } from "../src/archiview/http.js";

test("serves tree and historical documents; snapshot creation preserves selected baseline", async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "archiview-http-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "project");
  await mkdir(path.join(root, "gone"), { recursive: true });
  await writeFile(path.join(root, "module.md"), "# Root responsibility");
  await writeFile(path.join(root, "gone/module.md"), "# Historical responsibility");
  await writeFile(path.join(root, "gone/code.js"), "export const old = true;");
  const { server } = await createArchiView({ root,
    stateDirectory: path.join(temporary, "snapshots") });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes("ArchiView"));
  for (const asset of ["/app.mjs", "/review.mjs", "/styles.css"]) {
    assert.equal((await fetch(url + asset)).status, 200);
  }
  const first = await ((await fetch(url + "/api/comparison")).json() as Promise<ComparisonResponse>);
  await rm(path.join(root, "gone"), { recursive: true });
  const view = await ((await fetch(url + "/api/comparison?baseline=" + first.before.id)).json() as Promise<ComparisonResponse>);
  assert.equal(view.counts.removed, 1);
  const detail = await ((await fetch(url + "/api/module?" + new URLSearchParams({
    view: view.id, path: "gone",
  }))).json() as Promise<ModuleResponse>);
  assert.equal(detail.before!.document.text, "# Historical responsibility");
  assert.equal(detail.after, null);
  assert.ok(detail.diff.some((row) => row.kind === "removed"));
  const saved = await fetch(url + "/api/snapshots", { method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ view: view.id, label: "Review checkpoint" }) });
  assert.equal(saved.status, 201);
  const updated = await ((await fetch(url + "/api/comparison?baseline=" + first.before.id)).json() as Promise<ComparisonResponse>);
  assert.equal(updated.before.id, first.before.id);
  assert.ok(updated.baselines.some((entry) => entry.label === "Review checkpoint"));
  assert.equal((await fetch(url + "/api/module?view=invalid&path=gone")).status, 409);
  assert.equal((await fetch(url + "/api/module?" + new URLSearchParams({
    view: view.id, path: "../../private",
  }))).status, 404);
  assert.equal((await fetch(url + "/package.json")).status, 404);
  assert.equal((await fetch(url + "/api/snapshots", { method: "POST",
    headers: { Origin: "https://another-origin.invalid", "Content-Type": "application/json" },
    body: JSON.stringify({ view: view.id }) })).status, 403);
});
