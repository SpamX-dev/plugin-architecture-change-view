import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { containingWorktree } from "../../analyse/project/workspace.js";
import type { ReviewSetting, ReviewSettings } from "../../module-operations/api.js";
import { ApplicationError } from "../../module-operations/errors.js";
import { errorDetails } from "../../node-errors.js";
import { withFileLock } from "../../storage/file-lock.js";
import { physicalPath } from "../../storage/paths.js";
import { codexHookStatus } from "./codex-hook-status.js";
import { bundledCli } from "./runtime/package-paths.js";

type Document = Record<string, unknown>;
const events = ["UserPromptSubmit", "Stop"] as const;
const marker = "ArchiView · проверка изменённых модулей";
const legacyDescription = "Проверка изменённых модулей ArchiView";
const pathRunner = 'node -e "const args=JSON.parse(Buffer.from(process.argv[1],\'base64url\'));const child=require(\'node:child_process\').spawnSync(process.execPath,args.concat(process.argv.slice(2)),{stdio:\'inherit\',windowsHide:true});process.exitCode=child.status??1" ';
const record = (value: unknown): value is Document => value !== null && typeof value === "object" && !Array.isArray(value);

async function checkPath(file: string) {
  if (path.relative(file, await physicalPath(file)) !== "") throw new Error("Файл настроек перенаправлен ссылкой: " + file);
}

async function readDocument(file: string): Promise<Document> {
  await checkPath(file);
  try {
    if (!(await lstat(file)).isFile()) throw new Error("Ожидался обычный файл настроек: " + file);
    const value: unknown = JSON.parse((await readFile(file, "utf8")).replace(/^\uFEFF/, ""));
    if (!record(value)) throw new Error("Ожидался объект JSON в " + file);
    return value;
  } catch (error) {
    if (errorDetails(error).code === "ENOENT") return {};
    if (error instanceof SyntaxError) throw new Error("Некорректный JSON в " + file);
    throw error;
  }
}

const autoFile = (root: string) => path.join(root, ".archiview", "agent-review.json");
export const readReviewConfiguration = (root: string) => readDocument(autoFile(root));

function commandFor(root: string, stateDirectory: string) {
  const cli = bundledCli.split(path.sep).join("/");
  const external = path.relative(path.join(root, ".archiview"), stateDirectory) !== "";
  const state = stateDirectory.split(path.sep).join("/");
  const plain = /^[\p{L}\p{N} ._:/()+,@-]+$/u;
  if (plain.test(cli) && (!external || plain.test(state)))
    return 'node "' + cli + '" --turn-hook codex' + (external ? ' --state-dir "' + state + '"' : "");
  // cmd, PowerShell and POSIX shells expand different characters inside quotes. Pass unusual paths as data.
  const paths = Buffer.from(JSON.stringify(external ? [cli, "--state-dir", state] : [cli])).toString("base64url");
  return pathRunner + paths + " --turn-hook codex";
}

type Group = Document & {hooks: unknown[]};
function hookGroups(hooks: Document, event: string): Group[] {
  const groups = hooks[event];
  if (groups === undefined) return [];
  if (!Array.isArray(groups) || !groups.every(g => record(g) && Array.isArray(g.hooks))) throw new Error("Некорректные группы " + event + " в .codex/hooks.json");
  return groups;
}
function hookMap(doc: Document): Document {
  if (doc.hooks === undefined) return {};
  if (!record(doc.hooks)) throw new Error("Некорректное поле hooks в .codex/hooks.json");
  return doc.hooks;
}
function matches(item: unknown, command: string) {
  return record(item) && item.type === "command" && item.command === command && item.async !== true &&
    (process.platform !== "win32" || item.commandWindows === undefined || item.commandWindows === command);
}
function owned(item: unknown, command: string, doc: Document) {
  if (!record(item) || item.type !== "command" || typeof item.command !== "string") return false;
  if (item.command === command) return true;
  if (item.statusMessage !== marker && doc.description !== legacyDescription) return false;
  // Recognize our previous installation path when a checkout moves, without claiming other shell commands.
  return /^node "[^"\r\n]+\/cli\.mjs" --turn-hook codex(?: --state-dir "[^"\r\n]+")?$/.test(item.command) ||
    item.command.startsWith(pathRunner) && /^[\w-]+ --turn-hook codex$/.test(item.command.slice(pathRunner.length));
}

function editHooks(doc: Document, command: string, enabled: boolean) {
  const hooks = hookMap(doc);
  for (const event of events) {
    const groups = hookGroups(hooks, event);
    const remaining: Group[] = [];
    let present = false;
    for (const group of groups) {
      const items = group.hooks.filter(item => {
        if (!owned(item, command, doc)) return true;
        if (!enabled || present || !matches(item, command)) return false;
        present = true;
        return true;
      });
      if (items.length === group.hooks.length) remaining.push(group);
      else if (items.length) remaining.push({...group, hooks:items});
    }
    if (enabled && !present) remaining.push({hooks:[{type:"command", command, statusMessage:marker}]});
    if (remaining.length) hooks[event] = remaining;
    else if (groups.length) delete hooks[event];
  }
  if (doc.hooks !== undefined || Object.keys(hooks).length) doc.hooks = hooks;
}

export function projectReviewSettings(root: string, stateDirectory: string) {
  const hooksFile = path.join(root, ".codex", "hooks.json");
  const command = commandFor(root, stateDirectory);
  async function requireRoot() {
    const top = await containingWorktree(root);
    if (!top || path.relative(top, root) !== "") throw new ApplicationError("INVALID_ARGUMENT", "Откройте корень Git-репозитория для настройки автопроверки");
  }
  async function read(): Promise<ReviewSettings> {
    await requireRoot();
    const [auto, doc] = await Promise.all([readReviewConfiguration(root), readDocument(hooksFile)]);
    const hooks = hookMap(doc);
    const groups = events.map(event => hookGroups(hooks, event).flatMap(g => g.hooks));
    const installed = groups.every(items => items.some(item => matches(item, command)));
    const partial = groups.some(items => items.some(item => owned(item, command, doc)));
    return {autoAnalysis:auto.enabled === true, codexHooks:installed ? "on" : partial ? "partial" : "off",
      ...(installed && {codexStatus:await codexHookStatus(root, command)})};
  }
  async function set({setting, enabled}: {setting: ReviewSetting; enabled: boolean}) {
    await requireRoot();
    const file = setting === "autoAnalysis" ? autoFile(root) : hooksFile;
    const dir = path.dirname(file);
    await checkPath(file);
    await mkdir(dir, {recursive:true});
    await withFileLock(dir, ".archiview-settings.lock", async () => {
      const doc = await readDocument(file);
      const before = JSON.stringify(doc);
      if (setting === "codexHooks") editHooks(doc, command, enabled);
      else if ((doc.enabled === true) !== enabled) doc.enabled = enabled;
      if (JSON.stringify(doc) === before) return;
      if (setting === "codexHooks" && enabled && !(await lstat(bundledCli)).isFile()) throw new Error("Не найден собранный CLI ArchiView: " + bundledCli);
      const temp = path.join(dir, ".archiview-settings-" + randomUUID());
      try {
        await writeFile(temp, JSON.stringify(doc, null, 2) + "\n", {flag:"wx", mode:0o600});
        if (JSON.stringify(await readDocument(file)) !== before)
          throw new ApplicationError("DECISION_CONFLICT", "Файл настроек изменился. Откройте настройки ещё раз.");
        await rename(temp, file);
      } finally { await rm(temp, {force:true}); }
    });
    return read();
  }
  return {read, set};
}
