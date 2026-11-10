/**
 * Явная установка локального пакета Codex. Native legacy-загрузчик не раскрывает
 * PLUGIN_ROOT в .mcp.json, поэтому после штатной установки пути привязываются к
 * возвращённому каталогу кеша. Сборка и остальные плагины конфигурацию не меняют.
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { copyFile, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

/** Сохраняет исходный шаблон и разрешает только конфигурацию MCP установленного ArchiView. */
export async function configureInstalledCodexPlugin(installedPath) {
  const root = await realpath(installedPath);
  const manifest = JSON.parse(await readFile(path.join(root, ".codex-plugin/plugin.json"), "utf8"));
  if (manifest.name !== "archiview" || manifest.mcpServers !== "./.mcp.json") throw new Error("Unexpected installed ArchiView manifest");
  const file = path.join(root, ".mcp.json");
  const configuration = JSON.parse(await readFile(file, "utf8"));
  const server = configuration.mcpServers?.archiview;
  if (server?.command !== "node" || !Array.isArray(server.args) || !server.args.includes("--panel")) throw new Error("Unexpected installed ArchiView server");
  // Оригинальный шаблон сохраняется один раз; повторная настройка идемпотентна.
  try { await copyFile(file, path.join(root, ".mcp.json.template"), constants.COPYFILE_EXCL); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  server.args = server.args.map((argument) => argument.replaceAll("${PLUGIN_ROOT}", root));
  // Без cwd Codex передаёт рабочую папку чата, в том числе до первого сообщения.
  // Каталог установки нужен только для поиска кода и не должен подменять этот контекст.
  delete server.cwd;
  server.env = { ...server.env, PLUGIN_ROOT: root };
  await writeFile(file, JSON.stringify(configuration, null, 2) + "\n");
  return { installedPath: root, version: manifest.version, configuration };
}

/** Установщик CLI выбирает версию и каталог; код не вычисляет путь кеша по имени пользователя. */
export async function installCodexPlugin({ executable = "codex", cwd = fileURLToPath(new URL("../", import.meta.url)) } = {}) {
  const { stdout } = await promisify(execFile)(executable,
    ["plugin", "add", "archiview@archiview-local", "--json"], { cwd, windowsHide: true });
  const installed = JSON.parse(stdout);
  if (installed.pluginId !== "archiview@archiview-local" || typeof installed.installedPath !== "string") throw new Error("Unexpected Codex install result");
  const configured = await configureInstalledCodexPlugin(installed.installedPath);
  return { ...installed, installedPath: configured.installedPath, mcpPathsResolved: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const installed = await installCodexPlugin();
  process.stdout.write(JSON.stringify(installed, null, 2) + "\n");
}
