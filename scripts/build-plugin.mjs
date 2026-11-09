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
