import type { SnapshotData, SourceFile, SnapshotModule } from "../snapshots/types.js";
import type { Contract } from "../contracts/types.js";
import type { FileInput, ModuleState } from "./types.js";
import path from "node:path";
import { canonical, digest } from "../serialization/digest.js";

const NORMALIZATION = "archiview/module-state/v1";
export const SEMANTIC_FIELDS = ["id", "kind", "purpose", "responsibilities", "boundaries", "invariants"] as const;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export const sorted = <T>(values: Iterable<T>, key: (value:T) => string = (v) => canonical(v)) => [...values].sort((a, b) => compare(key(a), key(b)));

export const normalizeText = (text: string) => text.replace(/\r\n?/g, "\n");
export const moduleId = (module: SnapshotModule) => module?.document?.state === "documented" && module.document.contract?.id || "directory:" + module.directory;

/**
 * Переиспользует вычисления только внутри одной синхронной операции модели.
 * Контекст не выходит наружу и не живёт между версиями изменяемого снимка;
 * возвращаемые карты служат внутренними входами и не дополняются потребителями.
 */
export class ModuleStateContext {
  #states = new WeakMap<SnapshotData, Map<string, ModuleState>>();

  states(snapshot: SnapshotData | null): Map<string, ModuleState> {
    if (!snapshot) return new Map();
    if (!this.#states.has(snapshot)) this.#states.set(snapshot, buildModuleStates(snapshot));
    return this.#states.get(snapshot)!;
  }
}

/** Смысл контракта отделён от заголовка, оформления YAML и сырого arch.yaml. */
export function semanticContract(contract: Contract | null | undefined): Partial<Contract> | null {
  return contract ? Object.fromEntries(SEMANTIC_FIELDS.filter((key) => contract[key] !== undefined)
    .map((key) => [key, structuredClone(contract[key])])) : null;
}

/**
 * Файловые факты дают нормализованный текст; для бинарных/недоступных текстов
 * сохраняется исходный отпечаток снимка с явным указанием способа сравнения.
 * mtime и абсолютный корень ни в один отпечаток состояния не входят.
 */
export function fileInput(snapshot: SnapshotData | null, file: SourceFile): FileInput {
  const fact = snapshot?.facts?.find((item) => item.kind === "file" && item.path === file.path && typeof item.text === "string");
  return { path: file.path, digest: fact ? digest({ text: normalizeText(fact.text) }) :
    digest({ captured_hash: file.hash ?? null }), normalization: fact ? "text-lf/v1" : "captured-hash/v1",
  ...(file.error ? { error: file.error } : {}) };
}

/** Применимые границы/инварианты предков; чужие responsibilities не наследуются. */
function inheritedInputs(modules: SnapshotModule[], directory: string) {
  return sorted(modules.filter((module) => module.directory !== directory &&
    (module.directory === "." || directory.startsWith(module.directory + "/")))
    .flatMap((module) => (["boundaries", "invariants"] as const).flatMap((section) =>
      Object.entries(module.document?.contract?.[section] ?? {}).map(([id, text]) =>
        ({ module_id: moduleId(module), section, id, text })))),
  (item) => [item.module_id, item.section, item.id].join("\0"));
}

/**
 * Строит одновременно техническое состояние и обязательные входы self. Карта
 * использует устойчивый id; directory:... — явный технический ключ модуля без
 * действующего контракта, который никогда не получает полную актуальность.
 */
export function buildModuleStates(snapshot: SnapshotData | null): Map<string, ModuleState> {
  const states = new Map<string, ModuleState>();
  const modules = snapshot?.modules ?? [];
  const byDirectory = new Map(modules.map((module) => [module.directory, module]));
  for (const module of modules) {
    const id = moduleId(module);
    if (states.has(id)) throw new Error("Duplicate module identity: " + id);
    let parentDirectory = module.directory === "." ? null : path.posix.dirname(module.directory);
    while (parentDirectory !== null && !byDirectory.has(parentDirectory)) {
      parentDirectory = parentDirectory === "." ? null : path.posix.dirname(parentDirectory);
    }
    const ownFiles = sorted((module.files ?? []).filter((file) => file.path !== module.documentPath)
      .map((file) => fileInput(snapshot, file)), (file) => file.path);
    const inherited = inheritedInputs(modules, module.directory);
    const contract = module.document?.contract ?? null;
    const technical = { normalization: NORMALIZATION, module_id: id, directory: module.directory,
      own_files: ownFiles, contract: structuredClone(contract), document_state: module.document?.state ?? "missing", inherited,
      ...(!contract && module.document?.text ? { invalid_contract_digest: digest(normalizeText(module.document.text ?? "")) } : {}) };
    states.set(id, { module_id: id, directory: module.directory,
      parent_id: parentDirectory === null ? null : moduleId(byDirectory.get(parentDirectory)!),
      children: [], technical, technical_digest: digest(technical),
      complete: snapshot?.complete !== false && module.document?.state === "documented" && Boolean(contract) && !ownFiles.some((file) => file.error) &&
        modules.filter((ancestor) => ancestor.directory !== module.directory &&
          (ancestor.directory === "." || module.directory.startsWith(ancestor.directory + "/")))
          .every((ancestor) => ancestor.document?.state === "documented" && ancestor.document.contract),
      self: { normalization: NORMALIZATION, module_id: id, directory: module.directory,
        own_files: structuredClone(ownFiles), contract: semanticContract(contract), inherited, children: [] } });
  }
  for (const state of states.values()) if (state.parent_id !== null) states.get(state.parent_id)?.children.push(state.module_id);
  for (const state of states.values()) {
    state.children.sort(compare);
    state.self.children = state.children.map((id) => ({ module_id: id, directory: states.get(id)!.directory,
      contract: semanticContract(states.get(id)!.technical.contract), document_state: states.get(id)!.technical.document_state }));
    state.complete &&= state.self.children.every((child) => child.document_state === "documented" && child.contract);
    state.self_digest = digest(state.self);
  }
  const subtree = (id: string): string => {
    const state = states.get(id)!;
    if (state.subtree_digest) return state.subtree_digest;
    state.subtree = { self: state.technical_digest,
      children: state.children.map((child) => ({ module_id: child, digest: subtree(child) })) };
    state.subtree_digest = digest(state.subtree);
    state.semantic_subtree = { self: state.self_digest,
      children: state.children.map((child) => ({ module_id: child, digest: states.get(child)!.semantic_subtree_digest })) };
    state.semantic_subtree_digest = digest(state.semantic_subtree);
    return state.subtree_digest;
  };
  for (const id of states.keys()) subtree(id);
  return states;
}

/** База фиксируется commit/id, а не подвижной меткой HEAD или абсолютным root. */
export function baselineIdentity(snapshot: SnapshotData | null, context: ModuleStateContext) {
  if (!snapshot) return null;
  return { kind: snapshot.kind ?? "snapshot", id: snapshot.revision ?? snapshot.id ??
    digest(sorted([...context.states(snapshot).values()].map((state) =>
      ({ module_id: state.module_id, digest: state.subtree_digest })), (state) => state.module_id)) };
}
