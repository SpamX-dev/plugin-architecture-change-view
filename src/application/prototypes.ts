import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isMap, parseDocument, stringify } from "yaml";
import { validateArch } from "../contracts/document.js";
import {
  assertModuleDirectory, listModuleContractPaths, MAX_DOCUMENT_BYTES, MAX_TREE_BYTES, MODULE_DIRECTORY,
  MODULE_TREE_FILE, moduleDocumentPath, parseModuleTree, readContractStorageFile, validateModuleMapping,
} from "../contracts/module-tree.js";
import { isPrototype, PROTOTYPE_EXTENSION, type Contract } from "../contracts/types.js";
import { assertStateLocation, STATE_DIRECTORY } from "../project/paths.js";
import { repositoryDirectoryOwnership, resolveWorkspaceRepository } from "../project/workspace.js";
import { errorDetails } from "../runtime/errors.js";
import { parseYaml } from "../serialization/yaml.js";
import type { SnapshotModule } from "../snapshots/types.js";
import { withFileLock } from "../storage/file-lock.js";
import { ApplicationError } from "./errors.js";

const invalid = (message: string) => new ApplicationError("INVALID_ARGUMENT", message);
const stale = () => new ApplicationError("STALE_VIEW", "Карта или контракт изменились. Обновите дерево.");
const normalize = (text: string) => text.replace(/\r\n?/g, "\n");

/** An agent supplies the same contract fields as in modules/<id>.yaml, plus the future directory. */
export const SCAFFOLD_DESCRIPTION = "Create a module scaffold in one Git repository. Pass plan as a YAML list. " +
  "Each entry requires directory (relative, / separator), id, title, purpose and responsibilities (ID to text map). " +
  "Optional contract fields include kind, boundaries, invariants and extensions. No source directories are created.";

function prototypeEntry(value: unknown) {
  if (!value || typeof value !== "object" || !("directory" in value) || typeof value.directory !== "string")
    throw invalid("Для каждого модуля нужен путь directory");
  const { directory, ...fields } = value;
  const contract = validateArch({ schema_version: 1, kind: "module", boundaries: {}, invariants: {}, ...fields });
  contract.extensions = { ...contract.extensions, [PROTOTYPE_EXTENSION]: true };
  const text = stringify(contract, { lineWidth: 0 });
  checkSize(text, MAX_DOCUMENT_BYTES);
  // Validate before using the path to inspect any part of the filesystem.
  validateModuleMapping(contract.id, directory);
  return { directory, contract, text };
}

function checkSize(text: string, limit: number) {
  if (Buffer.byteLength(text) > limit)
    throw new ApplicationError("REQUEST_TOO_LARGE", "Превышен размер документа " + limit / 1024 + " КиБ");
}

async function locked<T>(root: string, change: (source: string | null) => Promise<T>) {
  const directory = path.join(root, MODULE_DIRECTORY);
  await assertStateLocation(root, path.join(root, STATE_DIRECTORY), directory);
  await mkdir(directory, { recursive: true });
  return withFileLock(directory, ".contract-edit.lock", async () => change(await readContractStorageFile(root, MODULE_TREE_FILE)));
}

async function publishTree(root: string, before: string | null, after: string) {
  const target = path.join(root, MODULE_TREE_FILE);
  const temporary = path.join(path.dirname(target), ".tree-" + randomUUID());
  try {
    await writeFile(temporary, after, { flag: "wx", mode: before === null ? undefined : (await lstat(target)).mode });
    if (await readContractStorageFile(root, MODULE_TREE_FILE) !== before) throw stale();
    await rename(temporary, target);
  } finally { await rm(temporary, { force: true }); }
}

function treeText(doc: ReturnType<typeof parseDocument>, before: string | null) {
  const text = doc.toString({ lineWidth: 0 });
  const result = before?.includes("\r\n") ? text.replaceAll("\n", "\r\n") : text;
  checkSize(result, MAX_TREE_BYTES);
  parseModuleTree(result);
  return result;
}

async function checkDirectory(root: string, directory: string, owns = repositoryDirectoryOwnership(root)) {
  if (!await owns(directory))
    throw invalid("Каталог находится вне исходников выбранного репозитория: " + directory);
  await assertModuleDirectory(root, directory, true);
}

export async function createPrototypes(root: string, values: unknown) {
  if (!Array.isArray(values) || !values.length) throw invalid("Каркас должен содержать хотя бы один модуль");
  let entries: ReturnType<typeof prototypeEntry>[];
  try { entries = values.map(prototypeEntry); }
  catch (error) { throw error instanceof ApplicationError ? error : invalid(errorDetails(error).message); }
  const ids = new Set(entries.map(entry => entry.contract.id.toLowerCase()));
  const paths = new Set(entries.map(entry => entry.directory.toLowerCase()));
  if (ids.size !== entries.length || paths.size !== entries.length) throw invalid("В каркасе повторяется ID или путь модуля");
  return locked(root, async before => {
    const registered = before === null ? new Map<string, string>() : parseModuleTree(before);
    const doc = parseDocument(before ?? "{}");
    if (before === null && isMap(doc.contents)) doc.contents.flow = false;
    const owns = repositoryDirectoryOwnership(root);
    const occupied = new Set((await listModuleContractPaths(root)).map(file => file.toLowerCase()));
    const additions = [];
    for (const entry of entries) {
      const { contract, directory } = entry;
      await checkDirectory(root, directory, owns);
      const file = moduleDocumentPath(contract.id);
      if (registered.get(directory) === contract.id) {
        const existing = await readContractStorageFile(root, file);
        if (existing && isDeepStrictEqual(parseYaml(existing, validateArch), contract)) continue;
      }
      if (occupied.has(file.toLowerCase()) || doc.has(contract.id))
        throw invalid("ID модуля уже используется: " + contract.id);
      doc.set(contract.id, directory);
      additions.push(entry);
    }
    if (additions.length) {
      let after: string;
      try { after = treeText(doc, before); }
      catch (error) { throw error instanceof ApplicationError ? error : invalid(errorDetails(error).message); }
      const created: string[] = [];
      try {
        for (const { contract, text } of additions) {
          const target = path.join(root, moduleDocumentPath(contract.id));
          const temporary = path.join(path.dirname(target), ".create-" + randomUUID());
          try {
            await writeFile(temporary, text, { flag: "wx" });
            await link(temporary, target);
            created.push(target);
          } finally { await rm(temporary, { force: true }); }
        }
        await publishTree(root, before, after);
      } catch (error) {
        for (const file of created) await rm(file);
        throw error;
      }
    }
    return { modules: entries.map(({ directory, contract }) => ({ directory, id: contract.id })) };
  });
}

export async function createScaffold(workspace: string, repository: unknown, plan: unknown) {
  if (repository !== undefined && typeof repository !== "string" || typeof plan !== "string")
    throw invalid("Передайте репозиторий и YAML каркаса");
  const root = await resolveWorkspaceRepository(workspace, repository ?? ".");
  checkSize(plan, MAX_TREE_BYTES);
  return createPrototypes(root, parseYaml(plan, value => value));
}

export async function changeExistingPrototype(root: string, module: SnapshotModule, replacement?: string) {
  const contract = module.document.contract;
  if (!contract || !isPrototype(contract) || !module.document.text) throw invalid("Выберите прототип модуля");
  const { directory } = module;
  const expected = normalize(module.document.text);
  const relative = moduleDocumentPath(contract.id);
  return locked(root, async before => {
    if (!before || parseModuleTree(before).get(directory) !== contract.id) throw stale();
    await checkDirectory(root, directory);
    const target = path.join(root, relative);
    const source = await readContractStorageFile(root, relative);
    if (source === null || normalize(source) !== expected) throw stale();
    const temporary = path.join(path.dirname(target), ".prototype-" + randomUUID());
    if (replacement !== undefined) {
      checkSize(replacement, MAX_DOCUMENT_BYTES);
      let updated: Contract;
      try { updated = parseYaml(replacement, validateArch); } catch (error) { throw invalid(errorDetails(error).message); }
      if (updated.id !== contract.id || !isPrototype(updated)) throw invalid("Сохраните ID модуля и отметку archiview.prototype");
      try {
        const text = source.includes("\r\n") ? normalize(replacement).replaceAll("\n", "\r\n") : replacement;
        checkSize(text, MAX_DOCUMENT_BYTES);
        await writeFile(temporary, text, { flag: "wx", mode: (await lstat(target)).mode });
        if (await readContractStorageFile(root, relative) !== source || await readContractStorageFile(root, MODULE_TREE_FILE) !== before) throw stale();
        await rename(temporary, target);
      } finally { await rm(temporary, { force: true }); }
    } else {
      const doc = parseDocument(before);
      doc.delete(contract.id);
      const after = treeText(doc, before);
      await rename(target, temporary);
      try { await publishTree(root, before, after); }
      catch (error) { await rename(temporary, target); throw error; }
      await rm(temporary);
    }
    return { directory };
  });
}
