import { randomUUID } from "node:crypto";
import { lstat, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isMap, isScalar, parseDocument, type Pair, type YAMLMap } from "yaml";
import { assertModuleDirectory, MAX_DOCUMENT_BYTES, MODULE_DIRECTORY, moduleDocumentPath, readContractStorageFile, readModuleTree } from "../analyse/project/module-tree.js";
import { contractDocument, currentContractYaml } from "../framework/contracts/document.js";
import { clauseEntries, isPrototype, type ContractDocument, type Section, type StoredContract } from "../framework/contracts/types.js";
import { assertStateLocation, STATE_DIRECTORY } from "../analyse/project/paths.js";
import { repositoryDirectoryOwnership } from "../analyse/project/workspace.js";
import type { SnapshotModule } from "../framework/snapshots/types.js";
import { withFileLock } from "../analyse/project/file-lock.js";
import { nextClauseId, rememberClauseId } from "../analyse/project/clause-ids.js";
import type { ClauseChange, DeletedClause } from "./api.js";
import { ApplicationError } from "./errors.js";

const stale = () => new ApplicationError("STALE_VIEW", "Контракт изменился. Откройте актуальную версию пункта.");
const normalize = (text: string) => text.replace(/\r\n?/g, "\n");

// Include the key and its separator so an empty flow map can become a block map.
function sectionRange(doc: ReturnType<typeof parseDocument>, section: Section) {
  if (!isMap(doc.contents) || doc.contents.flow) return;
  const pair = doc.contents.items.find(item => isScalar(item.key) && item.key.value === section);
  if (pair && isScalar(pair.key) && pair.key.range && (isMap(pair.value) || isScalar(pair.value)) && pair.value.range)
    return { start: pair.key.range[0], end: pair.value.range[2] };
}

type ClauseWrite = { section: Section; clauseId: string } & ({ action: "add" | "edit"; text: string } | { action: "delete" });
const pairKey = (pair?: Pair) => isScalar(pair?.key) ? pair.key.value : undefined;

/** Keep the deleted YAML entry, including its comments and place among surviving neighbours. */
function clausePosition(source: string, section: Section, clauseId: string) {
  const map = parseDocument(source, { intAsBigInt: true }).get(section, true);
  if (!isMap(map)) return;
  const index = map.items.findIndex(pair => pairKey(pair) === clauseId);
  if (index >= 0) return { pair: map.items[index], index, next: pairKey(map.items[index + 1]), previous: pairKey(map.items[index - 1]) };
}

type ClausePosition = NonNullable<ReturnType<typeof clausePosition>>;

function insertRestoredClause(map: YAMLMap, position: ClausePosition, baselineOrder: string[]) {
  const indices = new Map(map.items.map((pair, index) => [pairKey(pair), index]));
  function between(next: unknown, previous: unknown) {
    const following = indices.get(next);
    if (following !== undefined) return following;
    const preceding = indices.get(previous);
    if (preceding !== undefined) return preceding + 1;
  }
  let index = between(position.next, position.previous);
  const base = baselineOrder.findIndex(key => key === pairKey(position.pair));
  if (index === undefined && base >= 0) {
    const next = baselineOrder.slice(base + 1).find(key => indices.has(key));
    const previous = baselineOrder.slice(0, base).findLast(key => indices.has(key));
    index = between(next, previous);
  }
  map.items.splice(index ?? position.index, 0, position.pair.clone());
}

function changedText(source: string, stored: StoredContract, change: ClauseWrite, position?: ClausePosition, baselineOrder: string[] = []) {
  const { section, clauseId, action } = change;
  const { responsibilities, ...expected } = stored;
  const doc = parseDocument(source, { intAsBigInt: true });
  const original = sectionRange(doc, section);
  if (section === "purpose") {
    if (action !== "edit" || clauseId !== "purpose" || !change.text.trim())
      throw new ApplicationError("INVALID_ARGUMENT", "Назначение модуля должно содержать текст");
    if (expected.purpose === change.text) return source;
    doc.set(section, change.text);
    expected.purpose = change.text;
  } else {
    if (!expected.purpose) throw new ApplicationError("INVALID_ARGUMENT", "Сначала укажите назначение модуля");
    const clauses = new Map(Object.entries(expected[section]));
    if (action === "add" && clauses.has(clauseId)) throw new ApplicationError("INVALID_ARGUMENT", "Такой ID уже есть в разделе");
    if (action !== "add" && !clauses.has(clauseId)) throw stale();
    if (action === "edit" && clauses.get(clauseId) === change.text) return source;
    if (action === "delete") {
      doc.deleteIn([section, clauseId]);
      clauses.delete(clauseId);
    } else {
      const map = doc.get(section, true);
      if (position && isMap(map)) insertRestoredClause(map, position, baselineOrder);
      else doc.setIn([section, clauseId], change.text);
      clauses.set(clauseId, change.text);
      if (action === "add" && isMap(map) && map.items.length === 1 && isMap(doc.contents) && !doc.contents.flow) map.flow = false;
    }
    expected[section] = Object.fromEntries(clauses);
  }
  const formatted = doc.toString({ lineWidth: 0, flowCollectionPadding: false });
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

/** Restore one clause into the checked working document, leaving independent edits intact. */
export function createContractEditor(root: string) {
  const deletions = new Map<string, { file: string; clause: DeletedClause; position: ReturnType<typeof clausePosition> }>();
  let exactUndo: { token: string; before: string; after: string } | undefined;
  async function changeClause(module: SnapshotModule, change: ClauseChange, baseline?: ContractDocument) {
    const contract = module.document.contract;
    if (!contract || module.document.text == null) throw stale();
    const expected = normalize(module.document.text);
    const relative = moduleDocumentPath(contract.id);
    const { section } = change;
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
      const clauseId = change.action === "add" ? change.clauseId ?? await nextClauseId(root, contract, change.section, baseline?.contract) : change.clauseId;
      const key = JSON.stringify([relative, section, clauseId]);
      const editable = currentContractYaml(source);
      const original = baseline?.contract && clauseEntries(baseline.contract, section);
      let result: string;
      if (change.action === "restore") {
        const deleted = deletions.get(key);
        if (!deleted || deleted.clause.undoToken !== change.undoToken || Object.hasOwn(clauseEntries(contract, section), clauseId)) throw stale();
        result = exactUndo?.token === change.undoToken && exactUndo.after === source ? exactUndo.before :
          changedText(editable, contract, { action: "add", section, clauseId, text: deleted.clause.text }, deleted.position, Object.keys(original ?? {}));
      } else if (change.action === "revert") {
        if (!original || !Object.hasOwn(original, clauseId))
          throw new ApplicationError("INVALID_ARGUMENT", "В базе сравнения нет такого пункта");
        const action = section === "purpose" || Object.hasOwn(contract[section], clauseId) ? "edit" : "add";
        const position = action === "add" && baseline?.text ? clausePosition(baseline.text, section, clauseId) : undefined;
        result = changedText(editable, contract, { action, section, clauseId, text: original[clauseId] }, position, Object.keys(original));
      } else result = changedText(editable, contract, { ...change, clauseId });
      if (result === source) return { clauseId };
      if (Buffer.byteLength(result) > MAX_DOCUMENT_BYTES) throw new ApplicationError("REQUEST_TOO_LARGE", "Контракт превышает 128 КиБ");
      const temporary = path.join(directory, ".edit-" + randomUUID());
      try {
        await writeFile(temporary, result, { flag: "wx", mode: (await lstat(file)).mode });
        if (section !== "purpose" && (change.action === "add" || change.action === "delete"))
          await rememberClauseId(root, contract.id, section, clauseId);
        await checkOwner();
        if (await readContractStorageFile(root, relative) !== source) throw stale();
        await rename(temporary, file);
      } finally { await rm(temporary, { force: true }); }
      if (change.action === "delete") {
        const undoToken = randomUUID();
        deletions.set(key, { file: relative, clause: { section, clauseId, undoToken, text: clauseEntries(contract, section)[clauseId] },
          position: clausePosition(editable, section, clauseId) });
        exactUndo = { token: undoToken, before: editable, after: result };
        return { clauseId, undoToken };
      }
      deletions.delete(key);
      return { clauseId };
    });
  }
  function deletedClauses(module: SnapshotModule) {
    const contract = module.document.contract;
    if (!contract) return [];
    return Array.from(deletions.values()).filter(({ file, clause }) => file === module.documentPath &&
      !Object.hasOwn(clauseEntries(contract, clause.section), clause.clauseId)).map(({ clause }) => ({ ...clause }));
  }
  return { changeClause, deletedClauses };
}
