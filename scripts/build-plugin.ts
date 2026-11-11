/**
 * Автономная локальная поставка: бандлы Node и самодостаточный UI SDK исключают
 * npm install внутри кеша плагинов. Результат всегда находится только в dist/codex.
 */
import { build } from "esbuild";
import { buildWeb } from "./build-web.js";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
await buildWeb(root);
const output = new URL("dist/codex/", root);
await mkdir(new URL("src/", output), { recursive: true });
// Панель должна выполнить ui/initialize без загрузки скриптов с loopback:
// хост может применять отдельную CSP для ресурсов и сетевых запросов.
const panelBundle = await build({
  entryPoints: [fileURLToPath(new URL("src/codex/panel-entry.ts", root))],
  bundle: true, write: false, platform: "browser", target: "es2022", format: "esm",
});
const [template, styles] = await Promise.all([
  readFile(new URL("web/archiview/index.html", root), "utf8"),
  readFile(new URL("web/archiview/styles.css", root), "utf8"),
]);
const panelHtml = template
  .replace('<link rel="stylesheet" href="/styles.css">', () => `<style>${styles.replace(/<\/style/gi, "<\\/style")}</style>`)
  .replace('<script type="module" src="/app.mjs"></script>', () => `<script type="module">${panelBundle.outputFiles[0].text.replace(/<\/script/gi, "<\\/script")}</script>`);
await writeFile(new URL("dist/panel.html", root), panelHtml);
await mkdir(new URL("dist/", output), { recursive: true });
await writeFile(new URL("dist/panel.html", output), panelHtml);
await build({
  entryPoints: { server: fileURLToPath(new URL("src/server.ts", root)), cli: fileURLToPath(new URL("src/archiview/packaged-cli.ts", root)) },
  outdir: fileURLToPath(new URL("src/", output)), outExtension: { ".js": ".mjs" },
  bundle: true, platform: "node", target: "node22", format: "esm",
  banner: { js: 'import { createRequire as archiviewCreateRequire } from "node:module"; const require = archiviewCreateRequire(import.meta.url);' },
});
for (const name of ["skills", "docs"]) await cp(new URL(name, root), new URL(name, output), { recursive: true });
await cp(new URL("dist/web/", root), new URL("web/", output), { recursive: true });
for (const name of ["package.json", "README.md", "LICENSE"])
  await cp(new URL(name, root), new URL(name, output));
// Формат Codex поддерживает env_vars: переносимый mcp.json v1 не умеет
// передавать канал контекста из окружения хоста. Общий portable-пакет не меняется.
const portablePlugin = JSON.parse(await readFile(new URL("plugin.json", root), "utf8"));
const portableMcp = JSON.parse(await readFile(new URL("mcp.json", root), "utf8"));
await mkdir(new URL(".codex-plugin/", output), { recursive: true });
await writeFile(new URL(".codex-plugin/plugin.json", output), JSON.stringify({
  name: portablePlugin.name, version: portablePlugin.version, description: portablePlugin.description,
  skills: "./skills/", mcpServers: "./.mcp.json", requires_local_executor: true,
  interface: portablePlugin.extensions["com.openai"].interface,
}, null, 2) + "\n");
const codexServer = { ...portableMcp.mcpServers.archiview,
  args: ["${PLUGIN_ROOT}/src/server.mjs", "--panel"],
  env_vars: ["CODEX_APP_TOOLS_PIPE_PATH", "CODEX_APP_TOOLS_CALLER_HOST_ID"] };
delete codexServer.type;
await writeFile(new URL(".mcp.json", output), JSON.stringify({ mcpServers: { archiview: codexServer } }, null, 2) + "\n");
// Оставшиеся от прежних сборок portable-манифесты перекрыли бы конфигурацию Codex.
for (const name of ["plugin.json", "mcp.json", "src/codex/session-start.mjs"])
  await rm(new URL(name, output), { force: true });
await cp(new URL(import.meta.resolve("@modelcontextprotocol/ext-apps/app-with-deps")),
  new URL("web/archiview/mcp-app-sdk.mjs", output));
// Автономный пакет использует версию Codex-плагина; общая npm/dsh-версия не меняется.
const metadata = JSON.parse(await readFile(new URL("package.json", output), "utf8"));
metadata.version = portablePlugin.version;
delete metadata.dependencies;
delete metadata.devDependencies;
delete metadata.scripts;
// dist/codex — самостоятельный пакет Codex: записи плагина dsh здесь не публикуются.
delete metadata.main;
delete metadata.exports;
delete metadata.dsh;
delete metadata.peerDependencies;
delete metadata.peerDependenciesMeta;
metadata.bin.archiview = "src/cli.mjs";
metadata.bin["plugin-architecture-change-view"] = "src/server.mjs";
metadata.files = ["src", "web", "skills", "docs", "dist/panel.html", ".codex-plugin", ".mcp.json", "README.md", "LICENSE"];
await writeFile(new URL("package.json", output), JSON.stringify(metadata, null, 2) + "\n");
process.stdout.write("Codex plugin built: " + fileURLToPath(output) + "\n");
