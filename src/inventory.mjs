/**
 * Читает дерево исходников и контракты module.md внутри одного корня проекта.
 * Не разбирает AST и не выводит ответственность эвристически. Git используется
 * для учёта ignore-правил; вне репозитория применяется ограниченный обход.
 */
import { execFile } from "node:child_process";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

/** Каталоги зависимостей и результатов сборки, исключаемые из обоих обходов. */
const EXCLUDED = new Set([
  ".git", ".hg", ".svn", "node_modules", "target", "dist", "build", "coverage",
  ".venv", "venv", "__pycache__", ".next", ".nuxt", ".cache", "obj",
]);
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
/** Максимальный размер одного описания, читаемого в контекст агента. */
const MAX_DOCUMENT_BYTES = 128 * 1024;

/**
 * Проверяет вложенность уже разрешённых путей; допускает сам корень.
 * Работает с разделителями и регистрами, принятыми платформой Node.js.
 */
function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) &&
    relative !== ".." && !relative.startsWith(".." + path.sep));
}

/** Приводит путь к относительному формату ответа MCP независимо от платформы. */
function portable(value) {
  return value.split(path.sep).join("/") || ".";
}

/**
 * Отсекает внешние пути, исключённые каталоги и символические ссылки.
 * Отсутствующий после Git-фильтра файл считается удалённым, а не исходником.
 */
async function regularProjectFile(root, relative) {
  const parts = relative.split(/[\\/]/);
  if (parts.some((part) => EXCLUDED.has(part))) return false;
  const candidate = path.resolve(root, relative);
  if (!within(root, candidate)) return false;
  try {
    const resolved = await realpath(candidate);
    if (!within(root, resolved)) return false;
    const info = await lstat(candidate);
    return info.isFile() && !info.isSymbolicLink();
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Получает учитываемые файлы и признак полноты. Ошибка Git внутри репозитория
 * не маскируется полным результатом обхода: причина возвращается диагностикой.
 */
async function projectFiles(root, maxFiles) {
  const diagnostics = [];
  let gitRoot;
  try {
    gitRoot = await runFile("git", ["rev-parse", "--show-toplevel"], {
      cwd: root, timeout: 15000, windowsHide: true,
    });
  } catch (error) {
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
      const files = [...new Set(output.stdout.split("\0").filter(Boolean))];
      const limited = files.length > maxFiles;
      if (limited) diagnostics.push("File limit reached: " + maxFiles);
      return { files: files.slice(0, maxFiles), discovery: "git",
        complete: !limited, diagnostics };
    } catch (error) {
      diagnostics.push("Git file listing failed: " + error.message);
    }
  }
  const files = [];
  const pending = [root];
  while (pending.length > 0 && files.length < maxFiles) {
    const directory = pending.pop();
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      diagnostics.push("Cannot list " + portable(path.relative(root, directory)) +
        ": " + error.message);
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.isSymbolicLink() || EXCLUDED.has(entry.name)) continue;
      const candidate = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile()) files.push(path.relative(root, candidate));
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

/**
 * Читает один контракт, различая отсутствие, пустой текст и ошибку чтения.
 * Внешняя ссылка и чрезмерно большой документ отвергаются явно.
 */
async function documentAt(root, directory) {
  const file = path.join(directory, "module.md");
  try {
    const resolved = await realpath(file);
    if (!within(root, resolved)) throw new Error("module.md resolves outside project");
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error("module.md must be a regular file");
    }
    if (info.size > MAX_DOCUMENT_BYTES) throw new Error("module.md exceeds 128 KiB");
    const text = await readFile(file, "utf8");
    return { directory: portable(path.relative(root, directory)),
      document: portable(path.relative(root, file)),
      status: text.trim() ? "documented" : "empty", text };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { directory: portable(path.relative(root, directory)),
      document: portable(path.relative(root, file)), status: "missing" };
  }
}

/**
 * Возвращает покрытие каждого каталога дерева исходников, включая предков.
 * Отдельно сохраняет каталоги с module.md без исходников для планируемых блоков.
 */
export async function moduleInventory(projectRoot, options = {}) {
  const root = await realpath(projectRoot);
  const extensions = options.extensions ?? SOURCE_EXTENSIONS;
  const maxFiles = options.maxFiles ?? 50000;
  const listed = await projectFiles(root, maxFiles);
  const directories = new Map();
  let sourceFiles = 0;
  for (const file of listed.files) {
    const source = extensions.has(path.extname(file).toLowerCase());
    const documented = path.basename(file) === "module.md";
    if (!source && !documented) continue;
    try {
      if (!await regularProjectFile(root, file)) continue;
    } catch (error) {
      listed.complete = false;
      listed.diagnostics.push(file + ": " + error.message);
      continue;
    }
    let directory = path.dirname(file);
    if (source) sourceFiles += 1;
    while (true) {
      const record = directories.get(directory) ?? { sourceFiles: 0 };
      if (source) record.sourceFiles += 1;
      directories.set(directory, record);
      if (!source || directory === ".") break;
      directory = path.dirname(directory);
    }
  }
  const modules = [];
  for (const [directory, counts] of [...directories].sort(([a], [b]) =>
    a.localeCompare(b))) {
    try {
      const { text, ...document } = await documentAt(root, path.resolve(root, directory));
      modules.push({ ...document, sourceFiles: counts.sourceFiles,
        required: counts.sourceFiles > 0 });
    } catch (error) {
      listed.complete = false;
      listed.diagnostics.push(directory + ": " + error.message);
      modules.push({ directory: portable(directory), document: portable(
        path.join(directory, "module.md")), status: "unreadable",
        sourceFiles: counts.sourceFiles, required: counts.sourceFiles > 0 });
    }
  }
  return { schema_version: 1, root, complete: listed.complete,
    discovery: listed.discovery, sourceFiles, modules,
    diagnostics: listed.diagnostics };
}

/**
 * Возвращает цепочку контрактов от корня до целевого каталога, включая пропуски.
 * Абсолютный путь, выход через .. и ссылка за пределы проекта отклоняются.
 */
export async function moduleContext(projectRoot, directory = ".") {
  const root = await realpath(projectRoot);
  if (path.isAbsolute(directory)) throw new Error("directory must be relative");
  const requested = path.resolve(root, directory);
  if (!within(root, requested)) throw new Error("directory is outside project");
  const target = await realpath(requested);
  if (!within(root, target)) throw new Error("directory resolves outside project");
  if (!(await lstat(target)).isDirectory()) throw new Error("directory is not a directory");
  const chain = [];
  let current = requested;
  while (true) {
    chain.push(await documentAt(root, current));
    if (current === root) break;
    current = path.dirname(current);
  }
  return { schema_version: 1, root, directory: portable(path.relative(root, requested)),
    contracts: chain.reverse() };
}
