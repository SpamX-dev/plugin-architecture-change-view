import { randomUUID } from "node:crypto";
import { lstat, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isMap, isScalar, parseDocument } from "yaml";
import { assertModuleDirectory, MAX_DOCUMENT_BYTES, MODULE_DIRECTORY, moduleDocumentPath, readContractStorageFile, readModuleTree } from "../contracts/module-tree.js";
import { contractDocument } from "../contracts/document.js";
import type { Contract, Section } from "../contracts/types.js";
import { isPrototype } from "../contracts/types.js";
import { assertStateLocation, STATE_DIRECTORY } from "../project/paths.js";
import { repositoryDirectoryOwnership } from "../project/workspace.js";
import type { SnapshotModule } from "../snapshots/types.js";
import { withFileLock } from "../storage/file-lock.js";
import type { ClauseChange } from "./api.js";
import { ApplicationError } from "./errors.js";

const stale = () => new ApplicationError("STALE_VIEW", "Контракт изменился. Откройте актуальную версию пункта.");
const normalize = (text: string) => text.replace(/\r\n?/g, "\n");

// Include the key and its separator so an empty flow map can become a block map.
function sectionRange(doc: ReturnType<typeof parseDocument>, section: Section) {
  if (!isMap(doc.contents) || doc.contents.flow) return;
  const pair = doc.contents.items.find(item => isScalar(item.key) && item.key.value === section);
  if (pair && isScalar(pair.key) && pair.key.range && isMap(pair.value) && pair.value.range)
    return { start: pair.key.range[0], end: pair.value.range[2] };
}

function changedText(source: string, contract: Contract, change: Exclude<ClauseChange, { action: "restore" }>) {
  const { section, clauseId, action } = change;
  const present = Object.hasOwn(contract[section], clauseId);
  if (action === "add" && present) throw new ApplicationError("INVALID_ARGUMENT", "Такой ID уже есть в разделе");
  if (action !== "add" && !present) throw stale();
  if (action === "delete" && section === "responsibilities" && Object.keys(contract[section]).length === 1)
    throw new ApplicationError("INVALID_ARGUMENT", "В разделе ответственности нужен хотя бы один пункт");
  if (action === "edit" && contract[section][clauseId] === change.text) return source;
  const doc = parseDocument(source, { intAsBigInt: true });
  const original = sectionRange(doc, section);
  const keys = [section, clauseId];
  if (action === "delete") doc.deleteIn(keys);
  else doc.setIn(keys, change.text);
  const map = doc.get(section, true);
  if (action === "add" && isMap(map) && map.items.length === 1 && isMap(doc.contents) && !doc.contents.flow) map.flow = false;
  const formatted = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
  const clauses = new Map(Object.entries(contract[section]));
  if (action === "delete") clauses.delete(clauseId);
  else clauses.set(clauseId, change.text);
  const expected = { ...contract, [section]: Object.fromEntries(clauses) };
  const range = sectionRange(parseDocument(formatted), section);
  const eol = (s: string) => source.includes("\r\n") ? s.replaceAll("\n", "\r\n") : s;
  if (range && original) {
    const result = source.slice(0, original.start) + eol(formatted.slice(range.start, range.end)) + source.slice(original.end);
    if (isDeepStrictEqual(contractDocument(result).contract, expected)) return result;
  }
  if (!isDeepStrictEqual(contractDocument(formatted).contract, expected))
    throw new ApplicationError("INVALID_ARGUMENT", "Не удалось сохранить пункт в формате контракта");
  return eol(formatted);
}

/** A session can undo its last deletion as long as the on-disk result still matches. */
export function createContractEditor(root: string) {
  let deleted: { token: string; file: string; section: Section; clauseId: string; before: string; after: string } | undefined;
  async function changeClause(module: SnapshotModule, change: ClauseChange): Promise<{ undoToken?: string }> {
    const contract = module.document.contract;
    if (!contract || module.document.text == null) throw stale();
    const expected = normalize(module.document.text);
    const relative = moduleDocumentPath(contract.id);
    const file = path.join(root, relative);
    const directory = path.join(root, MODULE_DIRECTORY);
    await assertStateLocation(root, path.join(root, STATE_DIRECTORY), directory);
    return withFileLock(directory, ".contract-edit.lock", async () => {
      const checkOwner = async () => {
        if ((await readModuleTree(root)).get(module.directory) !== contract.id ||
            !await repositoryDirectoryOwnership(root)(module.directory)) throw stale();
        await assertModuleDirectory(root, module.directory, isPrototype(contract));
      };
      await checkOwner();
      const source = await readContractStorageFile(root, relative);
      if (source === null || normalize(source) !== expected) throw stale();
      let result: string;
      if (change.action === "restore") {
        if (!deleted || deleted.token !== change.undoToken || deleted.file !== file ||
            deleted.section !== change.section || deleted.clauseId !== change.clauseId || deleted.after !== source) throw stale();
        result = deleted.before;
      } else result = changedText(source, contract, change);
      if (result === source) return {};
      if (Buffer.byteLength(result) > MAX_DOCUMENT_BYTES) throw new ApplicationError("REQUEST_TOO_LARGE", "Контракт превышает 128 КиБ");
      const temporary = path.join(directory, ".edit-" + randomUUID());
      try {
        await writeFile(temporary, result, { flag: "wx", mode: (await lstat(file)).mode });
        await checkOwner();
        if (await readContractStorageFile(root, relative) !== source) throw stale();
        await rename(temporary, file);
      } finally { await rm(temporary, { force: true }); }
      if (change.action === "delete") {
        deleted = { token: randomUUID(), file, section: change.section, clauseId: change.clauseId, before: source, after: result };
        return { undoToken: deleted.token };
      }
      if (deleted?.file === file) deleted = undefined;
      return {};
    });
  }
  function deletedClause(module: SnapshotModule) {
    if (deleted && deleted.file === path.join(root, module.documentPath) &&
        module.document.text != null && normalize(deleted.after) === normalize(module.document.text))
      return { section: deleted.section, clauseId: deleted.clauseId, undoToken: deleted.token };
  }
  return { changeClause, deletedClause };
}
