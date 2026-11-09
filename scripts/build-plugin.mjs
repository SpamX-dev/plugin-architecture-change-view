/**
 * Автономная локальная поставка: бандлы Node и самодостаточный UI SDK исключают
 * npm install внутри кеша плагинов. Результат всегда находится только в dist/codex.
 */
import { build } from "esbuild";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const output = new URL("dist/codex/", root);
await mkdir(new URL("src/", output), { recursive: true });
// Панель должна выполнить ui/initialize без загрузки скриптов с loopback:
// хост может применять отдельную CSP для ресурсов и сетевых запросов.
const panelBundle = await build({
  entryPoints: [fileURLToPath(new URL("web/archiview/app.mjs", root))],
  bundle: true, write: false, platform: "browser", target: "es2022", format: "esm",
  plugins: [{ name: "panel-sdk", setup(builder) {
    builder.onResolve({ filter: /^\.\/mcp-app-sdk\.mjs$/ }, () => ({
      path: fileURLToPath(new URL(import.meta.resolve("@modelcontextprotocol/ext-apps/app-with-deps"))),
    }));
  } }],
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
  entryPoints: { server: fileURLToPath(new URL("src/server.mjs", root)), cli: fileURLToPath(new URL("src/cli.mjs", root)) },
  outdir: fileURLToPath(new URL("src/", output)), outExtension: { ".js": ".mjs" },
  bundle: true, platform: "node", target: "node22", format: "esm",
  banner: { js: 'import { createRequire as archiviewCreateRequire } from "node:module"; const require = archiviewCreateRequire(import.meta.url);' },
});
for (const name of ["web", "skills", "docs"]) await cp(new URL(name, root), new URL(name, output), { recursive: true });
for (const name of ["plugin.json", "mcp.json", "package.json", "README.md", "LICENSE"])
  await cp(new URL(name, root), new URL(name, output));
await cp(new URL(import.meta.resolve("@modelcontextprotocol/ext-apps/app-with-deps")),
  new URL("web/archiview/mcp-app-sdk.mjs", output));
// Версии npm и плагина согласованы; пакет не требует установки зависимостей в кеше.
const metadata = JSON.parse(await readFile(new URL("package.json", output), "utf8"));
delete metadata.dependencies;
delete metadata.devDependencies;
delete metadata.scripts;
metadata.bin.archiview = "src/cli.mjs";
await writeFile(new URL("package.json", output), JSON.stringify(metadata, null, 2) + "\n");
process.stdout.write("Codex plugin built: " + fileURLToPath(output) + "\n");
