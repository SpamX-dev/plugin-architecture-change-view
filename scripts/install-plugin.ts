/**
 * Явная установка локального пакета Codex. Native legacy-загрузчик не раскрывает
 * PLUGIN_ROOT в .mcp.json, поэтому после штатной установки пути привязываются к
 * возвращённому каталогу кеша. Сборка и остальные плагины конфигурацию не меняют.
 */
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, copyFile, readFile, readdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

interface InstalledServer {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}
interface CodexConfiguration { mcpServers: { archiview: InstalledServer } }
interface CodexManifest { name: string; version: string; mcpServers: string }
interface CodexOptions { executable?: string; cwd?: string }
interface InstallResult { pluginId: string; installedPath: string; [key: string]: unknown }
function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** Сохраняет исходный шаблон и разрешает только конфигурацию MCP установленного ArchiView. */
export async function configureInstalledCodexPlugin(installedPath: string) {
  const root = await realpath(installedPath);
  const manifest = JSON.parse(await readFile(path.join(root, ".codex-plugin/plugin.json"), "utf8")) as CodexManifest;
  if (manifest.name !== "archiview" || manifest.mcpServers !== "./.mcp.json") throw new Error("Unexpected installed ArchiView manifest");
  const file = path.join(root, ".mcp.json");
  const configuration = JSON.parse(await readFile(file, "utf8")) as CodexConfiguration;
  const server = configuration.mcpServers?.archiview;
  const bundledNode = path.join(root, "runtime", "node.exe");
  const usesBundledNode = server?.command === "${PLUGIN_ROOT}/runtime/node.exe" || server?.command === bundledNode;
  if ((server?.command !== "node" && !usesBundledNode) || !Array.isArray(server.args) || !server.args.every((argument) => typeof argument === "string") || !server.args.includes("--panel")) throw new Error("Unexpected installed ArchiView server");
  if (usesBundledNode) await access(bundledNode, constants.X_OK);
  // Оригинальный шаблон сохраняется один раз; повторная настройка идемпотентна.
  try { await copyFile(file, path.join(root, ".mcp.json.template"), constants.COPYFILE_EXCL); }
  catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
  if (usesBundledNode) server.command = bundledNode;
  server.args = server.args.map((argument) => argument.replaceAll("${PLUGIN_ROOT}", root));
  // Без cwd Codex передаёт рабочую папку чата, в том числе до первого сообщения.
  // Каталог установки нужен только для поиска кода и не должен подменять этот контекст.
  delete server.cwd;
  server.env = { ...server.env, PLUGIN_ROOT: root };
  await writeFile(file, JSON.stringify(configuration, null, 2) + "\n");
  return { installedPath: root, version: manifest.version, configuration };
}

/**
 * Приложение Windows хранит CLI в каталоге сборки и добавляет его в PATH своих
 * процессов, но обычный терминал может этого пути не получить. Ищем настоящий
 * codex.exe в установке текущего пользователя; каталоги других рантаймов пропускаем.
 * При нескольких сборках выбираем наиболее свежий исполняемый файл.
 */
async function installedWindowsCodex() {
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) return null;
  const directory = path.join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin");
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (errorCode(error) === "ENOENT") return null; throw error; }
  const candidates = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const executable = path.join(directory, entry.name, "codex.exe");
    try {
      const info = await stat(executable);
      return info.isFile() ? { executable, modified: info.mtimeMs } : null;
    } catch (error) { if (errorCode(error) === "ENOENT") return null; throw error; }
  }));
  return candidates.filter((candidate) => candidate !== null).sort((a, b) => b.modified - a.modified || a.executable.localeCompare(b.executable))[0]?.executable ?? null;
}

/**
 * Сначала учитывает явный путь и PATH; только отсутствие команды разрешает поиск
 * CLI приложения Windows. Ошибки самой установки не запускают повторную установку.
 * Аргументы передаются напрямую процессу, без shell и подстановки путей в команду.
 */
export async function runCodex(args: string[], { executable = process.env.ARCHIVIEW_CODEX_EXECUTABLE,
  cwd = fileURLToPath(new URL("../", import.meta.url)) }: CodexOptions = {}) {
  const run = (command: string) => promisify(execFile)(command, args, { cwd, windowsHide: true });
  let result;
  try { result = await run(executable || "codex"); }
  catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    const fallback = !executable ? await installedWindowsCodex() : null;
    if (!fallback) throw new Error("Не найден CLI Codex. Добавьте codex в PATH или задайте ARCHIVIEW_CODEX_EXECUTABLE полным путём к codex.exe.", { cause: error });
    result = await run(fallback);
  }
  return result;
}

/** Штатный CLI выбирает версию и каталог кеша, после чего разрешаются пути MCP. */
export async function installCodexPlugin(options: CodexOptions = {}) {
  const { stdout } = await runCodex(["plugin", "add", "archiview@archiview-local", "--json"], options);
  const installed = JSON.parse(stdout) as InstallResult;
  if (installed.pluginId !== "archiview@archiview-local" || typeof installed.installedPath !== "string") throw new Error("Unexpected Codex install result");
  const configured = await configureInstalledCodexPlugin(installed.installedPath);
  return { ...installed, installedPath: configured.installedPath, mcpPathsResolved: true };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const installed = await installCodexPlugin();
  process.stdout.write(JSON.stringify(installed, null, 2) + "\n");
}
