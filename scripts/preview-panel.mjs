/**
 * Ручной протокольный стенд: настоящий UI и прикладной сервис во временном проекте,
 * с явно обозначенным тестовым хостом MCP Apps. Не запускает модель и не подменяет
 * проверку в настоящем Codex. Позволяет проверить bridge без сети в iframe и отказ отправки.
 */
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { stringify, parse } from "yaml";
import { createCodexPanel } from "../src/codex/panel.mjs";
import { createCodexProjectBinding } from "../src/codex/project-context.mjs";
import { AnalysisRequests } from "../src/application/analysis.mjs";
import { SnapshotStore } from "../src/snapshot-store.mjs";
import { ReportStore } from "../src/report-store.mjs";
import { digest } from "../src/formats.mjs";

const root = await mkdtemp(path.join(os.tmpdir(), "archiview-panel-preview-"));
await mkdir(path.join(root, "domain"));
for (const [directory, id, title] of [[".", "preview", "Тестовый проект"], ["domain", "domain", "Игровой модуль"]]) {
  await writeFile(path.join(root, directory, "arch.yaml"), stringify({ schema_version: 1, id, title,
    kind: "module", purpose: "Обслуживать тестовый игровой модуль.",
    responsibilities: { R1: "Вычислять значение без изменения состояния." },
    boundaries: { B1: "Не обращаться к сети." }, invariants: { I1: "Результат детерминирован." } }));
}
await writeFile(path.join(root, "domain/value.js"), "export const value = () => 42;\n");
const binding = process.argv.includes("--unknown-context") ? await createCodexProjectBinding(undefined, {
  readContext: async () => ({ status: "unknown" }),
}) : process.argv.includes("--select-project") ? undefined : root;
const panel = createCodexPanel(binding);
const resource = (await panel.resource()).contents[0];
// В iframe запрещена вся сеть; только тестовый хост снаружи пересылает MCP-сообщения.
const panelPolicy = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src data:; connect-src 'none'";
const constrainedHtml = resource.text.replace("<head>", `<head><meta http-equiv="Content-Security-Policy" content="${panelPolicy}">`);
const messages = [];
const host = createServer(async (request, response) => {
  if (request.url === "/tools" && request.method === "POST") {
    let body = ""; for await (const chunk of request) body += chunk;
    const call = JSON.parse(body);
    response.writeHead(200, { "Content-Type": "application/json" });
    return response.end(JSON.stringify(await panel.callUi(call.name, call.arguments)));
  }
  if (request.url === "/messages") {
    response.writeHead(200, { "Content-Type": "application/json" }); return response.end(JSON.stringify(messages));
  }
  if (request.url === "/message" && request.method === "POST") {
    let body = ""; for await (const chunk of request) body += chunk;
    messages.push(JSON.parse(body)); response.writeHead(204); return response.end();
  }
  if (request.url === "/complete" && request.method === "POST") {
    // Искусственный результат стенда явно помечен test; он хранится только во временном проекте.
    const store = new SnapshotStore(root); await store.open();
    const reports = new ReportStore(store);
    const directory = path.join(root, ".archiview/snapshots/analysis");
    const id = /"requestId":"([a-f0-9-]+)"/.exec(messages.at(-1)?.content?.[0]?.text ?? "")?.[1];
    if (!id) { response.writeHead(400); return response.end("No accepted request"); }
    const input = parse(await readFile(path.join(directory, id, "input.yaml"), "utf8"));
    input.report.analysis.model = { provider: "test", id: "UI protocol fixture" };
    input.report.analysis.prompt_digest = digest("UI protocol fixture");
    input.manifest.model = input.report.analysis.model;
    input.manifest.prompt_digest = input.report.analysis.prompt_digest;
    input.report.analysis.coverage = { status: "partial", limitations: ["Искусственный результат протокольного стенда; анализ кода не выполнялся."] };
    await writeFile(path.join(directory, id, "result.yaml"), stringify(input, { aliasDuplicateObjects: false }));
    await new AnalysisRequests(store, reports).complete(id);
    response.writeHead(204); return response.end();
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><title>ArchiView — тестовый хост MCP Apps</title>
    <style>body{margin:0;font:14px system-ui;background:#f4f6f5}header{padding:10px 16px;display:flex;gap:14px;align-items:center}iframe{width:100%;height:calc(100vh - 55px);border:0}#count{margin-left:auto}</style>
    <header><strong>Тестовый хост MCP Apps</strong><span id="connection">Ожидаем подключения</span><label><input id="reject" type="checkbox">Отклонять поручения</label><button id="complete">Импортировать тестовый результат</button><span id="count">Поручений: 0</span></header>
    <iframe id="panel" sandbox="allow-scripts allow-same-origin allow-forms allow-modals"></iframe>
    <script type="module">
      const frame = document.querySelector("iframe");
      const panelHtml = ${JSON.stringify(constrainedHtml).replace(/</g, "\\u003c")};
      let count = 0;
      window.addEventListener("message", async (event) => {
        if (event.source !== frame.contentWindow || !event.data?.method) return;
        if (event.data.method === "ui/notifications/initialized") document.querySelector("#connection").textContent = "MCP Apps подключён";
        if (event.data.id === undefined) return;
        const message = event.data;
        let result = {};
        if (message.method === "ui/initialize") result = { protocolVersion: message.params.protocolVersion,
          hostInfo: { name: "ArchiView protocol test host", version: "1" }, hostCapabilities: { message: { text: {} }, serverTools: {} },
          hostContext: { theme: "light", displayMode: "inline", availableDisplayModes: ["inline"] } };
        if (message.method === "ui/message") {
          result = { isError: document.querySelector("#reject").checked };
          if (!result.isError) {
            await fetch("/message", { method: "POST", body: JSON.stringify(message.params) });
            document.querySelector("#count").textContent = "Поручений: " + (++count);
          }
        }
        if (message.method === "tools/call") result = await (await fetch("/tools", { method: "POST", body: JSON.stringify(message.params) })).json();
        frame.contentWindow.postMessage({ jsonrpc: "2.0", id: message.id, result }, "*");
      });
      document.querySelector("#complete").onclick = () => fetch("/complete", { method: "POST" });
      frame.srcdoc = panelHtml;
    </script></html>`);
});
await new Promise((resolve) => host.listen(0, "127.0.0.1", resolve));
process.stdout.write("UI protocol preview: http://127.0.0.1:" + host.address().port + "\nTemporary project: " + root + "\n");
/** Убирает только временный проект, созданный этим стендом, и принадлежащие ему серверы. */
async function close() {
  host.closeAllConnections(); host.close();
  await panel.close();
  await rm(root, { recursive: true, force: true });
  process.exit();
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, close);
