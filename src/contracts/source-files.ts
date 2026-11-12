import { execFile } from "node:child_process";
import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { excludedProjectPath, within } from "../project/paths.js";
export { excludedProjectPath } from "../project/paths.js";
import { errorDetails } from "../runtime/errors.js";

/** Расширения исходного кода; список можно дополнить при запуске сервера. */
export const SOURCE_EXTENSIONS = new Set((
  ".c .h .cc .cpp .cxx .hpp .hxx .cs .fs .fsx .vb .java .kt .kts .scala " +
  ".swift .m .mm .js .jsx .mjs .cjs .ts .tsx .mts .cts .py .pyi .go .rs " +
  ".rb .php .lua .gd .sh .bash .zsh .ps1 .psm1 .pl .pm .r .sql .proto " +
  ".dart .zig .ex .exs .erl .hrl .clj .cljs .cljc .vue .svelte .css .scss " +
  ".less .html .htm .bsl .os .wsdl .xsd"
).split(" "));
/** Асинхронный запуск Git без оболочки и интерполяции пользовательских строк. */
const runFile = promisify(execFile);

/** Приводит путь к относительному формату ответа MCP независимо от платформы. */
export function portable(value: string) {
  return value.split(path.sep).join("/") || ".";
}

/**
 * Отсекает внешние пути, исключённые каталоги и символические ссылки.
 * Отсутствующий после Git-фильтра файл считается удалённым, а не исходником.
 */
export async function regularProjectFile(root: string, relative: string) {
  if (excludedProjectPath(relative)) return false;
  const candidate = path.resolve(root, relative);
  if (!within(root, candidate)) return false;
  try {
    const resolved = await realpath(candidate);
    if (!within(root, resolved) || excludedProjectPath(path.relative(root, resolved))) return false;
    const info = await lstat(candidate);
    return info.isFile() && !info.isSymbolicLink();
  } catch (errorCause) { const error = errorDetails(errorCause);
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Получает учитываемые файлы и признак полноты. Ошибка Git внутри репозитория
 * не маскируется полным результатом обхода: причина возвращается диагностикой.
 */
export async function projectFiles(root: string, maxFiles: number, ownsDirectory: (relative: string) => boolean | Promise<boolean>) {
  const diagnostics = [];
  let gitRoot;
  try {
    gitRoot = await runFile("git", ["rev-parse", "--show-toplevel"], {
      cwd: root, timeout: 15000, windowsHide: true,
    });
  } catch (errorCause) { const error = errorDetails(errorCause);
    if (error.code !== "ENOENT" &&
        !String(error.stderr).includes("not a git repository")) {
      diagnostics.push("Git discovery failed: " + error.message);
    }
  }
  if (gitRoot) {
    try {
      const output = await runFile("git",
        ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
        { cwd: root, timeout: 15000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
      const files: string[] = [];
      for (const file of new Set(output.stdout.split("\0"))) {
        if (!file || excludedProjectPath(file) || !await ownsDirectory(path.posix.dirname(file))) continue;
        files.push(file);
        if (files.length > maxFiles) break;
      }
      const limited = files.length > maxFiles;
      if (limited) diagnostics.push("File limit reached: " + maxFiles);
      return { files: files.slice(0, maxFiles), discovery: "git",
        complete: !limited, diagnostics };
    } catch (errorCause) { const error = errorDetails(errorCause);
      diagnostics.push("Git file listing failed: " + error.message);
    }
  }
  const files = [];
  const pending = [root];
  while (pending.length > 0 && files.length < maxFiles) {
    const directory = pending.pop()!;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (errorCause) { const error = errorDetails(errorCause);
      diagnostics.push("Cannot list " + portable(path.relative(root, directory)) +
        ": " + error.message);
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (excludedProjectPath(entry.name)) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (await ownsDirectory(portable(path.relative(root, candidate)))) pending.push(candidate);
      }
      else if (entry.isFile()) {
        files.push(path.relative(root, candidate));
      }
      if (files.length >= maxFiles) {
        if (index < entries.length - 1 || pending.length > 0) {
          diagnostics.push("File limit reached: " + maxFiles);
        }
        break;
      }
    }
  }
  return { files, discovery: "filesystem", complete: diagnostics.length === 0,
    diagnostics };
}
