/**
 * Переносимое хранилище технических отчётов и полной истории содержательных проверок.
 * work содержит самостоятельную публикацию; snapshots хранит локальное накопление.
 * Публикация заменяется целиком под межпроцессным lock с журналом восстановления.
 */
import { cp, link, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { isAlias, isMap, isScalar, isSeq, parseDocument, stringify } from "yaml";
import { canonical, digest } from "./formats.mjs";
import { readReviewBundle } from "./review-store.mjs";
import { snapshotDigest } from "./snapshots.mjs";
import { aggregateTreeStatuses, createTechnicalReport, createReviewEntry, isSemanticReview, reviewFreshness, validateReviewEntry, validateReviewRelations } from "./report-model.mjs";

const HASH = /^[a-f0-9]{64}$/;
const START = "# BEGIN ArchiView managed";
const END = "# END ArchiView managed";
const MANAGED = [START, "/snapshots/", "/reviews/", "/saved-*.json", "/.pending-*", "/.snapshot-*", "/.identity-*", END].join("\n");
const clone = (value) => JSON.parse(JSON.stringify(value));
const payload = ({ registration_order, ...entry }) => entry;
const originalBundle = ({ report, manifest, baseline, current }) => ({ report, manifest, baseline, current });
const semantic = isSemanticReview;
const snapshotContentDigest = (snapshot) => snapshot.digest ?? snapshotDigest(snapshot);

/** Идентификатор модуля никогда не становится пользовательским фрагментом пути. */
export const moduleReportName = (id) => digest(id).slice(7);

/** YAML допускает только JSON-подобные значения, строковые ключи и один документ. */
export function parseReportYaml(text) {
  const doc = parseDocument(text, { uniqueKeys: true, strict: true, version: "1.2" });
  if (doc.errors.length || doc.warnings.length) throw new Error([...doc.errors, ...doc.warnings].map((e) => e.message).join("; "));
  const walk = (node) => {
    if (isAlias(node)) throw new Error("YAML aliases are not allowed");
    if (node?.tag && !["tag:yaml.org,2002:str", "tag:yaml.org,2002:int", "tag:yaml.org,2002:float", "tag:yaml.org,2002:bool", "tag:yaml.org,2002:null", "tag:yaml.org,2002:map", "tag:yaml.org,2002:seq"].includes(node.tag)) throw new Error("Custom YAML tag");
    if (isMap(node)) for (const item of node.items) {
      if (!isScalar(item.key) || typeof item.key.value !== "string") throw new Error("YAML keys must be strings");
      walk(item.value);
    }
    else if (isSeq(node)) for (const item of node.items) walk(item);
    else if (isScalar(node) && typeof node.value === "number" && !Number.isFinite(node.value)) throw new Error("Non-finite YAML number");
  };
  walk(doc.contents);
  return doc.toJS({ maxAliasCount: 0 });
}

/** Проверяет минимум переносимой технической схемы и её содержательный отпечаток. */
export function validateArchiReport(value) {
  if (!value || value.schema_version !== 2 || value.kind !== "archi" || typeof value.module_id !== "string" || !value.module_id || !HASH.test(value.check_hash)) throw new Error("Invalid archi report schema");
  if (Object.keys(value).some((key) => !["schema_version", "kind", "module_id", "project_id", "check_hash", "input_manifest", "baseline", "current", "change", "structure", "publication", "review_status", "storage_diagnostics"].includes(key))) throw new Error("Unknown archi report field");
  if (!value.input_manifest || digest(value.input_manifest).slice(7) !== value.check_hash) throw new Error("Technical check hash mismatch");
  if (value.input_manifest.project_id !== value.project_id || value.input_manifest.module_id !== value.module_id) throw new Error("Technical report identity mismatch");
  for (const side of ["baseline", "current"]) {
    const state = value[side];
    const reference = side === "baseline" ? value.input_manifest.baseline?.state : value.input_manifest.current;
    const expected = state ? { exists: true, directory: state.directory, self_digest: state.technical_digest, subtree_digest: state.subtree_digest } : { exists: false };
    if ((side !== "baseline" || value.input_manifest.baseline) && canonical(reference) !== canonical(expected)) throw new Error("Technical state reference mismatch");
    if (state) {
      if (state.module_id !== value.module_id || state.technical.module_id !== value.module_id || state.self.module_id !== value.module_id || state.technical.directory !== state.directory || state.self.directory !== state.directory) throw new Error("Technical state identity mismatch");
      for (const key of ["technical", "self", "subtree", "semantic_subtree"]) if (digest(state[key]) !== state[key + "_digest"]) throw new Error("Technical state digest mismatch");
    }
  }
  if (value.publication && (!Number.isSafeInteger(value.publication.generation) || value.publication.generation < 1 || !/^sha256:[a-f0-9]{64}$/.test(value.publication.comparison_key))) throw new Error("Invalid publication identity");
  if (value.storage_diagnostics && (!Array.isArray(value.storage_diagnostics) || value.storage_diagnostics.some((item) => typeof item !== "string"))) throw new Error("Invalid storage diagnostics");
  return value;
}

const technicalCore = ({ publication, review_status, storage_diagnostics, ...report }) => report;

/** Проверка содержательной записи сохраняет исходный v1 пакет без переписывания. */
function validateEntry(entry) {
  if (!entry || entry.schema_version !== 2 || entry.kind !== "review" || typeof entry.module_id !== "string" || !entry.module_id || typeof entry.review_id !== "string" || !entry.review_id || !HASH.test(entry.check_hash)) throw new Error("Invalid review entry schema");
  validateReviewEntry(entry);
  if (!semantic(entry)) throw new Error("Structural report is not an LLM review");
  if (entry.registration_order !== undefined && (!Number.isSafeInteger(entry.registration_order) || entry.registration_order < 1)) throw new Error("Invalid review registration order");
  return entry;
}

/** Читает только обычные файлы, не переходя по ссылкам и без скрытого лимита истории. */
async function readYaml(file) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Report must be an ordinary file");
  return parseReportYaml(await readFile(file, "utf8"));
}

/** Собственные фрагменты вместе восстанавливают точный снимок без сырых snapshots. */
function snapshotFragment(snapshot, directory) {
  if (!snapshot) return null;
  const { modules, facts = [], ...metadata } = snapshot;
  const moduleIndex = modules.findIndex((m) => m.directory === directory);
  if (moduleIndex < 0) return null;
  const module = modules[moduleIndex];
  const paths = new Set(module.files.map((f) => f.path));
  return { metadata, module_index: moduleIndex, module: clone(module), facts: facts.flatMap((fact, index) =>
    (fact.kind === "module" ? fact.path === directory : paths.has(fact.path)) ? [{ index, fact: clone(fact) }] : []) };
}

/** Не пытается угадать отсутствующие фрагменты: повреждённая публикация не база. */
function reconstruct(reports) {
  const generations = reports.filter((r) => r.publication).map((r) => r.publication.generation);
  if (!generations.length) return null;
  const generation = Math.max(...generations);
  const selected = reports.filter((r) => r.publication?.generation === generation);
  const keys = new Set(selected.map((r) => r.publication.comparison_key));
  if (keys.size !== 1) throw new Error("Inconsistent published comparison");
  const result = {};
  for (const side of ["baseline", "current"]) {
    const fragments = selected.map((r) => r.publication[side]).filter(Boolean);
    if (!fragments.length) { result[side] = null; continue; }
    const metadata = fragments[0].metadata;
    if (fragments.some((f) => canonical(f.metadata) !== canonical(metadata))) throw new Error("Inconsistent snapshot metadata");
    const modules = fragments.map((f) => [f.module_index, f.module]).sort((a, b) => a[0] - b[0]);
    if (new Set(modules.map(([i]) => i)).size !== modules.length || modules.some(([i], index) => i !== index)) throw new Error("Incomplete published snapshot modules");
    const facts = fragments.flatMap((f) => f.facts).sort((a, b) => a.index - b.index);
    if (new Set(facts.map((f) => f.index)).size !== facts.length || facts.some((f, index) => f.index !== index)) throw new Error("Incomplete published snapshot facts");
    const snapshot = { ...metadata, modules: modules.map(([, m]) => m), facts: facts.map((f) => f.fact) };
    if (snapshot.digest && snapshotDigest(snapshot) !== snapshot.digest) throw new Error("Published snapshot digest mismatch");
    result[side] = snapshot;
  }
  if (!result.current) throw new Error("Missing published current snapshot");
  const expectedKey = digest({ baseline: result.baseline ? [result.baseline.id, snapshotContentDigest(result.baseline)] : null, current: [result.current.id, snapshotContentDigest(result.current)] });
  if (selected[0].publication.comparison_key !== expectedKey) throw new Error("Published comparison identity mismatch");
  for (const report of selected) {
    const expected = createTechnicalReport(report.project_id, result.baseline, result.current, { moduleId: report.module_id });
    if (canonical(technicalCore(report)) !== canonical(expected)) throw new Error("Published technical state differs from saved snapshot: " + report.module_id);
  }
  return result;
}

/** Возвращает выбранные переносимые снимки, ничего не создавая при отсутствии work. */
export async function readPublishedSnapshots(snapshotStore) {
  const store = new ReportStore(snapshotStore);
  const comparison = await store.publishedComparison();
  return comparison ? [comparison.baseline, comparison.current].filter(Boolean) : [];
}

/** Один экземпляр обслуживает выбранное хранилище; lock защищает и другие процессы. */
export class ReportStore {
  constructor(snapshotStore) {
    this.snapshotStore = snapshotStore;
    this.root = snapshotStore.root;
    this.directory = snapshotStore.directory;
    this.work = path.join(this.directory, "work");
    this.raw = path.join(this.directory, "snapshots", "modules");
    this.control = path.join(this.directory, "snapshots");
  }

  /** Считывает прежнюю выбранную базу, включая перенос проекта без raw накопления. */
  async selectedBaseline() { return (await this.publishedComparison())?.baseline ?? null; }

  async publishedComparison() {
    await this.snapshotStore.open();
    await this.snapshotStore.assertLocation(this.work);
    try { await lstat(this.work); } catch (error) {
      if (error.code !== "ENOENT") throw error;
      try { await lstat(path.join(this.control, ".publication.yaml")); } catch (journalError) { if (journalError.code === "ENOENT") return null; throw journalError; }
    }
    return this.#locked(async () => {
      const state = await this.#read();
      if (state.workErrors.length) throw new Error(state.workErrors.join("; "));
      return reconstruct(state.reports);
    });
  }

  /** Полная история не сортируется повторно по ненадёжным часам анализатора. */
  async list() {
    await this.snapshotStore.open();
    return this.#locked(async () => {
      const state = await this.#read();
      return this.#result(state);
    });
  }

  /** Автоматическая техническая проверка не создаёт содержательных попыток агента. */
  async rebuild(baseline, current, comparisonModules) {
    if (baseline?.complete === false || current?.complete === false) throw new Error("Cannot publish incomplete snapshot; previous work is preserved");
    return this.#locked(async () => {
      await this.#prepare();
      const state = await this.#read();
      this.#assertWritable(state);
      await this.#legacy(state);
      this.#assertProject(current);
      if (baseline) this.#assertProject(baseline);
      const comparisonKey = digest({ baseline: baseline ? [baseline.id, snapshotContentDigest(baseline)] : null, current: [current.id, snapshotContentDigest(current)] });
      const previous = state.reports.filter((r) => r.publication);
      const previousGeneration = Math.max(0, ...previous.map((r) => r.publication.generation));
      const same = previous.some((r) => r.publication.comparison_key === comparisonKey && r.publication.generation === previousGeneration);
      const generation = same ? previousGeneration : previousGeneration + 1;
      const old = new Map(state.reports.map((r) => [r.module_id, r]));
      const projectId = digest(this.snapshotStore.snapshotRoot);
      for (const module of comparisonModules) {
        const report = validateArchiReport(createTechnicalReport(projectId, baseline, current, module));
        // Повторный запуск с теми же данными сохраняет исходную метку времени снимка.
        const preserved = same ? old.get(report.module_id)?.publication : null;
        report.publication = preserved ?? { generation, comparison_key: comparisonKey,
          baseline: snapshotFragment(baseline, module.baselinePath), current: snapshotFragment(current, module.currentPath) };
        old.set(report.module_id, report);
        await this.#rawArchi(report);
      }
      state.reports = [...old.values()];
      await this.#publish(state);
      const result = this.#result(state);
      result.statuses = state.entries.map((entry) => ({ module_id: entry.module_id, review_id: entry.review_id, ...reviewFreshness(entry, baseline, current) }));
      return result;
    });
  }

  /** Принимает v1 пакет, новую запись или контейнер истории; повторный импорт идемпотентен. */
  async saveReview(value, options = {}) {
    return this.#locked(async () => {
      await this.#prepare();
      const state = await this.#read();
      this.#assertWritable(state);
      await this.#legacy(state);
      const source = value?.kind === "review_history" ? value.entries : [value];
      if (!Array.isArray(source) || !source.length) throw new Error("Empty review import");
      const ids = [];
      for (const item of source) {
        if (item?.report?.analysis?.analyzer?.name === "archiview-structure") throw new Error("Structural report is not an LLM review");
        if (item?.schema_version !== 2 && this.#alreadyMigrated(state, item)) {
          ids.push(item.report.id);
          continue;
        }
        const entry = item?.schema_version === 2 && item?.kind === "review" ? clone(item) : createReviewEntry(item, { projectId: digest(this.snapshotStore.snapshotRoot), ...options });
        validateEntry(entry);
        this.#assertEntryProject(entry);
        this.#add(state, entry);
        ids.push(entry.review_id);
      }
      await this.#publish(state);
      return ids.length === 1 ? ids[0] : ids;
    });
  }

  /** Прежние пакеты остаются на месте; структурные результаты не становятся LLM-историей. */
  async migrate() {
    return this.#locked(async () => {
      await this.#prepare();
      const state = await this.#read();
      this.#assertWritable(state);
      await this.#legacy(state);
      await this.#publish(state);
      return this.#result(state);
    });
  }

  #assertProject(snapshot) {
    if (!snapshot || snapshot.root !== this.snapshotStore.snapshotRoot) throw new Error("Foreign review project");
  }

  #assertEntryProject(entry) {
    if (entry.format === "legacy-v1") this.#assertProject(entry.current);
    else if (entry.project_id !== digest(this.snapshotStore.snapshotRoot)) throw new Error("Foreign review project");
  }

  #assertWritable(state) {
    if (state.workErrors.length || state.integrityErrors.length) throw new Error("Published work is damaged; refusing to replace it: " + [...state.workErrors, ...state.integrityErrors].join("; "));
  }

  #result(state) {
    return { bundles: state.entries.filter((e) => e.report?.schema_version === 1).map(({ report, manifest, baseline, current }) => ({ report, manifest, baseline, current })),
      entries: state.entries, reports: state.reports, diagnostics: state.diagnostics };
  }

  /** Общий reader объединяет work и raw: work остаётся первичным после clone. */
  async #read(workDirectory = this.work, includeRaw = true) {
    const state = { entries: [], reports: [], diagnostics: [], workErrors: [], integrityErrors: [] };
    const readDirectory = async (directory, published) => {
      await this.snapshotStore.assertLocation(directory);
      let names;
      try {
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Report directory must be an ordinary directory");
        names = await readdir(directory, { withFileTypes: true });
      } catch (error) { if (error.code === "ENOENT") return; throw error; }
      for (const item of names.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!/\.(archi|review)\.yaml$/.test(item.name)) continue;
        try {
          if (!item.isFile() || item.isSymbolicLink()) throw new Error("Report must be an ordinary file");
          const file = path.join(directory, item.name);
          await this.snapshotStore.assertLocation(file);
          const data = await readYaml(file);
          if (item.name !== moduleReportName(data.module_id) + (data.kind === "archi" ? ".archi.yaml" : ".review.yaml")) throw new Error("Module filename mismatch");
          if (data.kind === "archi") {
            validateArchiReport(data);
            if (published && !data.publication) throw new Error("Published technical report lacks snapshot fragments");
            if (data.project_id !== digest(this.snapshotStore.snapshotRoot)) throw new Error("Foreign technical report project");
            if (!published && data.check_hash !== path.basename(directory)) throw new Error("Raw check directory mismatch");
            if (published) {
              state.reports.push(data);
              state.diagnostics.push(...data.storage_diagnostics ?? []);
            }
          } else {
            if (data.schema_version !== 2 || data.kind !== "review_history" || !Array.isArray(data.entries) || Object.keys(data).some((key) => !["schema_version", "kind", "module_id", "entries"].includes(key))) throw new Error("Invalid review history schema");
            for (const entry of data.entries) {
              validateEntry(entry);
              if (entry.module_id !== data.module_id) throw new Error("Review history module mismatch");
              if (!published && entry.check_hash !== path.basename(directory)) throw new Error("Raw check directory mismatch");
              this.#assertEntryProject(entry);
              this.#add(state, entry, true);
            }
          }
        } catch (error) {
          const message = path.relative(this.directory, path.join(directory, item.name)) + ": " + error.message;
          state.diagnostics.push(message);
          if (error.message.startsWith("Review ID collision:")) state.integrityErrors.push(message);
          if (published) state.workErrors.push(message);
        }
      }
    };
    await readDirectory(workDirectory, true);
    try { reconstruct(state.reports); } catch (error) {
      const message = "work publication: " + error.message;
      state.diagnostics.push(message); state.workErrors.push(message);
    }
    let rawDirectories = [];
    if (includeRaw) try { rawDirectories = await readdir(this.raw, { withFileTypes: true }); } catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const directory of rawDirectories.sort((a, b) => a.name.localeCompare(b.name))) {
      if (/^[a-f0-9]{64}$/.test(directory.name) && directory.isDirectory() && !directory.isSymbolicLink()) await readDirectory(path.join(this.raw, directory.name), false);
    }
    state.entries.sort((a, b) => a.registration_order - b.registration_order);
    try { validateReviewRelations(state.entries); } catch (error) {
      state.diagnostics.push(error.message); state.integrityErrors.push(error.message);
    }
    state.diagnostics = [...new Set(state.diagnostics)];
    return state;
  }

  /** Один review_id обозначает один неизменяемый результат, а не его новые импорты. */
  #add(state, value, loading = false) {
    const entry = clone(value);
    const existing = state.entries.find((e) => e.review_id === entry.review_id);
    if (existing) {
      if (canonical(payload(existing)) !== canonical(payload(entry))) throw new Error("Review ID collision: " + entry.review_id);
      return false;
    }
    if (!loading || !entry.registration_order) entry.registration_order = Math.max(0, ...state.entries.map((e) => e.registration_order)) + 1;
    if (state.entries.some((e) => e.registration_order === entry.registration_order)) entry.registration_order = Math.max(0, ...state.entries.map((e) => e.registration_order)) + 1;
    state.entries.push(entry);
    return true;
  }

  /** Версия производных полей не меняет идентичность уже перенесённого v1 результата. */
  #alreadyMigrated(state, bundle) {
    const existing = state.entries.find((entry) => entry.format === "legacy-v1" && entry.review_id === bundle?.report?.id);
    if (!existing) return false;
    if (canonical(originalBundle(existing)) !== canonical(originalBundle(bundle))) throw new Error("Review ID collision: " + bundle.report.id);
    return true;
  }

  async #legacy(state) {
    const legacy = path.join(this.directory, "reviews");
    await this.snapshotStore.assertLocation(legacy);
    let names = [];
    try { names = await readdir(legacy, { withFileTypes: true }); } catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const item of names.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!item.isDirectory() || item.isSymbolicLink() || item.name.startsWith(".")) continue;
      try {
        const directory = path.join(legacy, item.name);
        await this.snapshotStore.assertLocation(directory);
        const bundle = await readReviewBundle(directory);
        this.#assertProject(bundle.current);
        if (bundle.report.analysis.analyzer.name === "archiview-structure") continue;
        if (this.#alreadyMigrated(state, bundle)) continue;
        this.#add(state, validateEntry(createReviewEntry(bundle, { projectId: digest(this.snapshotStore.snapshotRoot) })));
      } catch (error) {
        state.diagnostics.push("reviews/" + item.name + ": " + error.message);
        if (error.message.startsWith("Review ID collision:")) throw error;
      }
    }
  }

  /** Управляемый блок не заменяет пользовательские правила .gitignore. */
  async #prepare() {
    await this.snapshotStore.ensureIdentity();
    const file = path.join(this.directory, ".gitignore");
    await this.snapshotStore.assertLocation(file);
    let text = "";
    try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid .gitignore file"); text = await readFile(file, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const start = text.indexOf(START), end = text.indexOf(END);
    if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) throw new Error("Invalid ArchiView managed .gitignore block");
    const updated = start >= 0 ? text.slice(0, start) + MANAGED + text.slice(end + END.length) : text + (text && !text.endsWith("\n") ? "\n" : "") + MANAGED + "\n";
    if (text !== updated) await this.#atomic(file, updated);
  }

  async #rawArchi(report) {
    const directory = path.join(this.raw, report.check_hash);
    await this.snapshotStore.assertLocation(directory);
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, moduleReportName(report.module_id) + ".archi.yaml");
    try { validateArchiReport(await readYaml(file)); }
    catch (error) { if (error.code !== "ENOENT") throw error; await this.#atomic(file, stringify(report, { aliasDuplicateObjects: false })); }
  }

  /** Создаёт полную следующую публикацию и журнал, позволяющий завершить замену после сбоя. */
  async #publish(state) {
    validateReviewRelations(state.entries);
    const comparison = reconstruct(state.reports);
    if (comparison) {
      const statuses = aggregateTreeStatuses(state.entries, comparison.baseline, comparison.current);
      for (const report of state.reports) if (statuses.has(report.module_id)) report.review_status = statuses.get(report.module_id);
    }
    const anchor = state.reports.find((report) => report.current?.directory === ".") ?? state.reports.find((report) => report.baseline?.directory === ".") ?? state.reports[0];
    if (anchor && state.diagnostics.length) anchor.storage_diagnostics = [...new Set(state.diagnostics)];
    const rawGroups = new Map();
    for (const entry of state.entries) {
      const key = entry.module_id + "\0" + entry.check_hash;
      if (!rawGroups.has(key)) rawGroups.set(key, []);
      rawGroups.get(key).push(entry);
    }
    for (const same of rawGroups.values()) {
      const entry = same[0];
      const directory = path.join(this.raw, entry.check_hash);
      await this.snapshotStore.assertLocation(directory);
      await mkdir(directory, { recursive: true });
      await this.#atomic(path.join(directory, moduleReportName(entry.module_id) + ".review.yaml"), stringify({ schema_version: 2, kind: "review_history", module_id: entry.module_id, entries: same }, { aliasDuplicateObjects: false }));
    }
    const id = randomUUID();
    const pending = ".publication-" + id;
    const backup = ".previous-" + id;
    const staging = path.join(this.control, pending);
    await mkdir(staging);
    try { await cp(this.work, staging, { recursive: true, dereference: false }); } catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const report of state.reports) await writeFile(path.join(staging, moduleReportName(report.module_id) + ".archi.yaml"), stringify(report, { aliasDuplicateObjects: false }));
    for (const moduleId of new Set(state.entries.map((e) => e.module_id))) await writeFile(path.join(staging, moduleReportName(moduleId) + ".review.yaml"), stringify({ schema_version: 2, kind: "review_history", module_id: moduleId, entries: state.entries.filter((e) => e.module_id === moduleId) }, { aliasDuplicateObjects: false }));
    // Journal является точкой фиксации намерения; все данные уже записаны в staging.
    await this.#atomic(path.join(this.control, ".publication.yaml"), stringify({ schema_version: 1, pending, backup }));
    await this.#recover();
  }

  /** Возобновление не удаляет единственную готовую копию work при незавершённом rename. */
  async #recover() {
    const journal = path.join(this.control, ".publication.yaml");
    let value;
    try { value = await readYaml(journal); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (value.schema_version !== 1 || !/^\.publication-[a-f0-9-]{36}$/.test(value.pending) || !/^\.previous-[a-f0-9-]{36}$/.test(value.backup)) throw new Error("Invalid publication recovery journal");
    const pending = path.join(this.control, value.pending), backup = path.join(this.control, value.backup);
    const exists = async (file) => { try { const info = await lstat(file); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid publication directory"); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } };
    const hasPending = await exists(pending), hasBackup = await exists(backup), hasWork = await exists(this.work);
    if (hasPending) {
      try { this.#assertWritable(await this.#read(pending, false)); }
      catch (error) {
        // Даже испорченный staging не должен скрывать последнюю исправную публикацию.
        if (!hasWork && hasBackup) await rename(backup, this.work);
        throw error;
      }
      if (hasWork && !hasBackup) await rename(this.work, backup);
      else if (hasWork && hasBackup) throw new Error("Ambiguous publication recovery");
      await rename(pending, this.work);
    } else if (!hasWork && hasBackup) await rename(backup, this.work);
    else if (!hasWork) throw new Error("Missing publication recovery data");
    if (hasBackup) this.#assertWritable(await this.#read(this.work, false));
    await rm(backup, { recursive: true, force: true });
    await rm(journal);
  }

  async #atomic(file, content) {
    await this.snapshotStore.assertLocation(file);
    const temporary = path.join(this.control, ".write-" + randomUUID());
    await writeFile(temporary, content, { flag: "wx" });
    try { await rename(temporary, file); } finally { await rm(temporary, { force: true }); }
  }

  /** Живой процесс не теряет lock из-за таймера; оставшийся после смерти lock восстанавливается. */
  async #locked(action) {
    await this.snapshotStore.open();
    await this.snapshotStore.assertLocation(this.control);
    await mkdir(this.control, { recursive: true });
    const lock = path.join(this.control, ".report-store.lock");
    const token = randomUUID();
    const ownerFile = path.join(this.control, ".owner-" + token);
    await writeFile(ownerFile, JSON.stringify({ pid: process.pid, token }), { flag: "wx" });
    try {
      for (let attempt = 0; ; attempt++) {
        try { await link(ownerFile, lock); break; }
        catch (error) {
          if (error.code !== "EEXIST") throw error;
          const info = await lstat(lock).catch((error) => { if (error.code !== "ENOENT") throw error; return null; });
          if (!info) continue;
          if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid report-store lock");
          const owner = JSON.parse(await readFile(lock, "utf8"));
          if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== "string") throw new Error("Invalid report-store lock owner");
          if (owner.pid !== process.pid) {
            try { process.kill(owner.pid, 0); } catch (error) { if (error.code === "ESRCH") {
              if (JSON.parse(await readFile(lock, "utf8")).token === owner.token) await rm(lock, { force: true });
              continue;
            } }
          }
          if (attempt > 1200) throw new Error("Report store is locked by another writer");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    } finally { await rm(ownerFile, { force: true }); }
    try { await this.#recover(); return await action(); }
    finally {
      const owner = JSON.parse(await readFile(lock, "utf8"));
      if (owner.token === token) await rm(lock, { force: true });
    }
  }
}
