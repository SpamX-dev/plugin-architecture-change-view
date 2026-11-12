import { withFileLock } from "./file-lock.js";
import { parseReportYaml } from "../serialization/yaml.js";
import type { SnapshotStore } from "./snapshot-store.js";
import type { SnapshotData, Snapshot, ComparisonModule } from "../snapshots/types.js";
import type { ReviewBundle } from "../reviews/types.js";
import type {
  ReviewOptions, ReviewEntry, TechnicalReport,
  PublishedComparison, ReviewHistory,
} from "../reports/types.js";
import { errorDetails } from "../runtime/errors.js";
/**
 * Переносимое хранилище технических отчётов и полной истории содержательных проверок.
 * work содержит самостоятельную публикацию; snapshots хранит локальное накопление.
 * Публикация заменяется целиком под межпроцессным lock с журналом восстановления.
 */
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { stringify } from "yaml";
import { canonical, digest } from "../serialization/digest.js";
import { readReviewBundle } from "./review-store.js";
import { compareSnapshots } from "../snapshots/comparison.js";
import { persistedCopy, publicationIdentity, reconstruct, snapshotFragment, technicalCore, validateStoredReport } from "./publication.js";
import { createReportModel } from "../reports/model.js";
import { createReviewEntry } from "../reports/review-entry.js";
import { isSemanticReview, validateReviewRelations } from "../reports/review-identity.js";
import { validateReviewEntry } from "../reports/review-validation.js";
import { REPORT_SCHEMA_VERSION } from "../reports/types.js";

const HASH = /^[a-f0-9]{64}$/;
const START = "# BEGIN ArchiView managed";
const END = "# END ArchiView managed";
const MANAGED = [START, "/snapshots/", "/reviews/", "/saved-*.json", "/.pending-*", "/.snapshot-*", "/.identity-*", END].join("\n");
const payload = ({ registration_order, ...entry }: ReviewEntry) => entry;
const originalBundle = ({ report, manifest, baseline, current }: Pick<ReviewEntry,"report"|"manifest"|"baseline"|"current">) => ({ report, manifest, baseline, current });
const semantic = isSemanticReview;
/** Идентификатор модуля никогда не становится пользовательским фрагментом пути. */
export const moduleReportName = (id: string) => digest(id).slice(7);

/** Проверка содержательной записи сохраняет исходный v1 пакет без переписывания. */
function validateEntry(entry: ReviewEntry) {
  if (!entry || entry.schema_version !== REPORT_SCHEMA_VERSION || entry.kind !== "review" || typeof entry.module_id !== "string" || !entry.module_id || typeof entry.review_id !== "string" || !entry.review_id || !HASH.test(entry.check_hash)) throw new Error("Invalid review entry schema");
  validateReviewEntry(entry);
  if (!semantic(entry)) throw new Error("Structural report is not an LLM review");
  if (entry.registration_order !== undefined && (!Number.isSafeInteger(entry.registration_order) || entry.registration_order < 1)) throw new Error("Invalid review registration order");
  return entry;
}

/** Читает только обычные файлы, не переходя по ссылкам и без скрытого лимита истории. */
export async function readYaml<T = unknown>(file: string): Promise<T> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Report must be an ordinary file");
  return parseReportYaml<T>(await readFile(file, "utf8"));
}

/** A portable review file contains the attempts of exactly one module. */
export function validateHistoryFile(data: ReviewHistory, name: string, snapshotRoot: string) {
  if (data.schema_version !== REPORT_SCHEMA_VERSION || data.kind !== "review_history" ||
      name !== moduleReportName(data.module_id) + ".review.yaml" || !Array.isArray(data.entries) ||
      Object.keys(data).some((key) => !["schema_version", "kind", "module_id", "entries"].includes(key))) throw new Error("Invalid review history schema");
  for (const entry of data.entries) {
    validateEntry(entry);
    if (entry.module_id !== data.module_id) throw new Error("Review history module mismatch");
    if (entry.format === "legacy-v1" ? !("root" in entry.current) || entry.current.root !== snapshotRoot :
      entry.project_id !== digest(snapshotRoot)) throw new Error("Foreign review project");
  }
  return data.entries;
}

/** Возвращает выбранные переносимые снимки, ничего не создавая при отсутствии work. */
export async function readPublishedSnapshots(snapshotStore: SnapshotStore) {
  const store = new ReportStore(snapshotStore);
  const comparison = await store.publishedComparison();
  return comparison ? [comparison.baseline, comparison.current].filter(Boolean) : [];
}

export class StalePublicationError extends Error {
  constructor() { super("Published comparison changed before rebuilding the report"); this.name = "StalePublicationError"; }
}

export class ReportStore {
  root: string; directory: string; work: string; raw: string; control: string;
  constructor(public snapshotStore: SnapshotStore) {
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
    try { await lstat(this.work); } catch (errorCause) { const error = errorDetails(errorCause);
      if (error.code !== "ENOENT") throw error;
      try { await lstat(path.join(this.control, ".publication.yaml")); } catch (journalErrorCause) { const journalError = errorDetails(journalErrorCause); if (journalError.code === "ENOENT") return null; throw journalError; }
    }
    return this.#locked(async () => {
      // Опубликованные фрагменты самодостаточны; raw не участвует в выборе базы.
      const state = await this.#read(this.work, false);
      if (state.workErrors.length) throw new Error(state.workErrors.join("; "));
      return state.comparison;
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
  async rebuild(baseline: Snapshot | null,
    current: Snapshot, comparisonModules?: ComparisonModule[], options: {expectedComparison?: PublishedComparison} = {}) {
    if (!current.complete || baseline?.complete === false) throw new Error("Cannot publish incomplete snapshot; previous work is preserved");
    return this.#locked(async () => {
      const state = await this.#read();
      return this.#rebuild(state, baseline, current, comparisonModules, options.expectedComparison);
    });
  }

  /** A live read keeps the last publication when the selected comparison is incomplete. */
  async refreshWorking(current: Snapshot, selectBaseline: (published: PublishedComparison | null) => Snapshot | null) {
    if (!current.complete) return { history: await this.list(), liveReports: [] };
    return this.#locked(async () => {
      const state = await this.#read();
      const baseline = selectBaseline(state.comparison);
      if (baseline?.complete === false) return { history: this.#result(state), liveReports: [] };
      const history = await this.#rebuild(state, baseline, current);
      return { history, liveReports: history.reports };
    });
  }

  async #rebuild(state: StoreState, baseline: Snapshot | null, current: Snapshot,
    comparisonModules?: ComparisonModule[], expectedComparison?: PublishedComparison) {
    this.#assertWritable(state);
    await this.#prepare();
    const modules = comparisonModules ?? compareSnapshots(baseline, current).modules;
    if (expectedComparison && publicationIdentity(state.comparison) !== publicationIdentity(expectedComparison)) throw new StalePublicationError();
    await this.#legacy(state);
    this.#assertProject(current);
    if (baseline) this.#assertProject(baseline);
    const comparisonKey = publicationIdentity({ baseline, current });
    const previous = state.reports.filter((r) => r.publication);
    const previousGeneration = Math.max(0, ...previous.map((r) => r.publication!.generation));
    const same = previous.some((r) => r.publication!.comparison_key === comparisonKey && r.publication!.generation === previousGeneration);
    const generation = same ? previousGeneration : previousGeneration + 1;
    const old = new Map(state.reports.map((r) => [r.module_id, r]));
    const projectId = digest(this.snapshotStore.snapshotRoot);
    const model = createReportModel(baseline, current);
    let technicalChanged = !same;
    for (const module of modules) {
      const report = validateStoredReport(model.createTechnicalReport(projectId, module));
      const previousReport = old.get(report.module_id);
      const unchanged = previousReport && canonical(technicalCore(previousReport)) === canonical(technicalCore(report));
      technicalChanged ||= !unchanged;
      // Повторный запуск с теми же данными сохраняет исходную метку времени снимка.
      const preserved = same ? old.get(report.module_id)?.publication : null;
      report.publication = preserved ?? { generation, comparison_key: comparisonKey,
        baseline: snapshotFragment(baseline, module.baselinePath), current: snapshotFragment(current, module.currentPath) };
      // Вместе с прежними входами сохраняем вычисленные статусы и диагностику.
      old.set(report.module_id, same && unchanged ? previousReport : report);
      // Общий reader уже проверил существующий raw-файл в этой же операции.
      if (!state.rawArchi.has(report.check_hash + "/" + report.module_id)) await this.#rawArchi(report);
    }
    state.reports = [...old.values()];
    // Не меняем файлы и время публикации, если входы, история и диагностика прежние.
    // Чтение под lock всё равно обнаруживает внешние импорты и повреждения work/raw.
    if (technicalChanged || state.publishedEntries !== digest(state.entries) ||
        state.publishedDiagnostics !== digest([...new Set(state.diagnostics)])) await this.#publish(state);
    const result = this.#result(state);
    return {...result, comparison: state.comparison!, statuses: state.entries.map((entry) => ({ module_id: entry.module_id, review_id: entry.review_id, ...model.reviewFreshness(entry) }))};
  }

  /** Принимает v1 пакет, новую запись или контейнер истории; повторный импорт идемпотентен. */
  async saveReview(input: unknown, options: ReviewOptions = {}) {
    if (!input || typeof input !== "object") throw new Error("Invalid review import");
    const value = input as ReviewBundle | ReviewEntry | ReviewHistory;
    return this.#locked(async () => {
      await this.#prepare();
      const state = await this.#read();
      this.#assertWritable(state);
      await this.#legacy(state);
      const source = "entries" in value && value.kind === "review_history" ? value.entries : [value as ReviewBundle | ReviewEntry];
      if (!Array.isArray(source) || !source.length) throw new Error("Empty review import");
      const ids = [];
      for (const item of source) {
        if (item?.report?.analysis?.analyzer?.name === "archiview-structure") throw new Error("Structural report is not an LLM review");
        if (!("schema_version" in item && item.schema_version === 2) && this.#alreadyMigrated(state, item as ReviewBundle)) {
          ids.push(item.report.id);
          continue;
        }
        const entry = "schema_version" in item && item.schema_version === 2 && item.kind === "review" ? persistedCopy(item) : createReviewEntry(item, { projectId: digest(this.snapshotStore.snapshotRoot), ...options });
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

  #assertProject(snapshot: SnapshotData) {
    if (!snapshot || !("root" in snapshot) || snapshot.root !== this.snapshotStore.snapshotRoot) throw new Error("Foreign review project");
  }

  #assertEntryProject(entry: ReviewEntry) {
    if (entry.format === "legacy-v1") this.#assertProject(entry.current);
    else if (entry.project_id !== digest(this.snapshotStore.snapshotRoot)) throw new Error("Foreign review project");
  }

  #assertWritable(state: StoreState) {
    if (state.workErrors.length || state.integrityErrors.length) throw new Error("Published work is damaged; refusing to replace it: " + [...state.workErrors, ...state.integrityErrors].join("; "));
  }

  #result(state: StoreState) {
    return { bundles: state.entries.filter((e) => e.report?.schema_version === 1).map(({ report, manifest, baseline, current }) => ({ report, manifest, baseline, current })),
      entries: state.entries, reports: state.reports, diagnostics: state.diagnostics, comparison: state.comparison };
  }

  /** Общий reader объединяет work и raw: work остаётся первичным после clone. */
  async #read(workDirectory = this.work, includeRaw = true) {
    const state: StoreState = { entries: [], reports: [], diagnostics: [], workErrors: [], integrityErrors: [], rawArchi: new Set(), comparison: null };
    const readDirectory = async (directory: string, published: boolean) => {
      await this.snapshotStore.assertLocation(directory);
      let names;
      try {
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Report directory must be an ordinary directory");
        names = await readdir(directory, { withFileTypes: true });
      } catch (errorCause) { const error = errorDetails(errorCause); if (error.code === "ENOENT") return; throw error; }
      for (const item of names.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!/\.(archi|review)\.yaml$/.test(item.name)) continue;
        try {
          if (!item.isFile() || item.isSymbolicLink()) throw new Error("Report must be an ordinary file");
          const file = path.join(directory, item.name);
          await this.snapshotStore.assertLocation(file);
          const data = await readYaml<TechnicalReport | ReviewHistory>(file);
          if (item.name !== moduleReportName(data.module_id) + (data.kind === "archi" ? ".archi.yaml" : ".review.yaml")) throw new Error("Module filename mismatch");
          if (data.kind === "archi") {
            validateStoredReport(data);
            if (published && !data.publication) throw new Error("Published technical report lacks snapshot fragments");
            if (data.project_id !== digest(this.snapshotStore.snapshotRoot)) throw new Error("Foreign technical report project");
            if (!published && data.check_hash !== path.basename(directory)) throw new Error("Raw check directory mismatch");
            if (published) {
              state.reports.push(data);
              state.diagnostics.push(...data.storage_diagnostics ?? []);
            } else state.rawArchi.add(data.check_hash + "/" + data.module_id);
          } else {
            for (const entry of validateHistoryFile(data, item.name, this.snapshotStore.snapshotRoot)) {
              if (!published && entry.check_hash !== path.basename(directory)) throw new Error("Raw check directory mismatch");
              this.#add(state, entry, true);
            }
          }
        } catch (errorCause) { const error = errorDetails(errorCause);
          const message = path.relative(this.directory, path.join(directory, item.name)) + ": " + error.message;
          state.diagnostics.push(message);
          if (error.message.startsWith("Review ID collision:")) state.integrityErrors.push(message);
          if (published) state.workErrors.push(message);
        }
      }
    };
    await readDirectory(workDirectory, true);
    try { state.comparison = reconstruct(state.reports); } catch (errorCause) { const error = errorDetails(errorCause);
      const message = "work publication: " + error.message;
      state.diagnostics.push(message); state.workErrors.push(message);
    }
    state.publishedEntries = digest([...state.entries].sort((a, b) => (a.registration_order ?? 0) - (b.registration_order ?? 0)));
    state.publishedDiagnostics = digest([...new Set(state.diagnostics)]);
    let rawDirectories: import("node:fs").Dirent[] = [];
    if (includeRaw) {
      await this.snapshotStore.assertLocation(this.raw);
      try { rawDirectories = await readdir(this.raw, { withFileTypes: true }); }
      catch (cause) { if (errorDetails(cause).code !== "ENOENT") throw cause; }
    }
    for (const directory of rawDirectories.sort((a, b) => a.name.localeCompare(b.name))) {
      if (/^[a-f0-9]{64}$/.test(directory.name) && directory.isDirectory() && !directory.isSymbolicLink()) await readDirectory(path.join(this.raw, directory.name), false);
    }
    state.entries.sort((a, b) => (a.registration_order ?? 0) - (b.registration_order ?? 0));
    try { validateReviewRelations(state.entries); } catch (errorCause) { const error = errorDetails(errorCause);
      state.diagnostics.push(error.message); state.integrityErrors.push(error.message);
    }
    state.diagnostics = [...new Set(state.diagnostics)];
    return state;
  }

  /** Один review_id обозначает один неизменяемый результат, а не его новые импорты. */
  #add(state: StoreState, value: ReviewEntry, loading = false) {
    const entry = persistedCopy(value);
    const existing = state.entries.find((e) => e.review_id === entry.review_id);
    if (existing) {
      if (canonical(payload(existing)) !== canonical(payload(entry))) throw new Error("Review ID collision: " + entry.review_id);
      return false;
    }
    if (!loading || !entry.registration_order) entry.registration_order = Math.max(0, ...state.entries.map((e) => e.registration_order ?? 0)) + 1;
    if (state.entries.some((e) => e.registration_order === entry.registration_order)) entry.registration_order = Math.max(0, ...state.entries.map((e) => e.registration_order ?? 0)) + 1;
    state.entries.push(entry);
    return true;
  }

  /** Версия производных полей не меняет идентичность уже перенесённого v1 результата. */
  #alreadyMigrated(state: StoreState, bundle: ReviewBundle) {
    const existing = state.entries.find((entry) => entry.format === "legacy-v1" && entry.review_id === bundle?.report?.id);
    if (!existing) return false;
    if (canonical(originalBundle(existing)) !== canonical(originalBundle(bundle))) throw new Error("Review ID collision: " + bundle.report.id);
    return true;
  }

  async #legacy(state: StoreState) {
    const legacy = path.join(this.directory, "reviews");
    await this.snapshotStore.assertLocation(legacy);
    let names: import("node:fs").Dirent[] = [];
    try { names = await readdir(legacy, { withFileTypes: true }); } catch (errorCause) { const error = errorDetails(errorCause); if (error.code !== "ENOENT") throw error; }
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
      } catch (errorCause) { const error = errorDetails(errorCause);
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
    try { const info = await lstat(file); if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid .gitignore file"); text = await readFile(file, "utf8"); } catch (errorCause) { const error = errorDetails(errorCause); if (error.code !== "ENOENT") throw error; }
    const start = text.indexOf(START), end = text.indexOf(END);
    if ((start >= 0) !== (end >= 0) || (start >= 0 && end < start)) throw new Error("Invalid ArchiView managed .gitignore block");
    const updated = start >= 0 ? text.slice(0, start) + MANAGED + text.slice(end + END.length) : text + (text && !text.endsWith("\n") ? "\n" : "") + MANAGED + "\n";
    if (text !== updated) await this.#atomic(file, updated);
  }

  async #rawArchi(report: TechnicalReport) {
    const directory = path.join(this.raw, report.check_hash);
    await this.snapshotStore.assertLocation(directory);
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, moduleReportName(report.module_id) + ".archi.yaml");
    try { validateStoredReport(await readYaml<TechnicalReport | ReviewHistory>(file)); }
    catch (errorCause) { const error = errorDetails(errorCause); if (error.code !== "ENOENT") throw error; await this.#atomic(file, stringify(report, { aliasDuplicateObjects: false })); }
  }

  /** Создаёт полную следующую публикацию и журнал, позволяющий завершить замену после сбоя. */
  async #publish(state: StoreState) {
    validateReviewRelations(state.entries);
    const comparison = reconstruct(state.reports);
    state.comparison = comparison;
    if (comparison) {
      const statuses = createReportModel(comparison.baseline, comparison.current).aggregateTreeStatuses(state.entries);
      for (const report of state.reports) if (statuses.has(report.module_id)) report.review_status = statuses.get(report.module_id);
    }
    const anchor = state.reports.find((report) => report.current?.directory === ".") ?? state.reports.find((report) => report.baseline?.directory === ".") ?? state.reports[0];
    if (anchor && state.diagnostics.length) anchor.storage_diagnostics = [...new Set(state.diagnostics)];
    const rawGroups = new Map<string, ReviewEntry[]>();
    for (const entry of state.entries) {
      const key = entry.module_id + "\0" + entry.check_hash;
      if (!rawGroups.has(key)) rawGroups.set(key, []);
      rawGroups.get(key)!.push(entry);
    }
    for (const same of rawGroups.values()) {
      const entry = same[0];
      const directory = path.join(this.raw, entry.check_hash);
      await this.snapshotStore.assertLocation(directory);
      await mkdir(directory, { recursive: true });
      await this.#atomic(path.join(directory, moduleReportName(entry.module_id) + ".review.yaml"), stringify({ schema_version: REPORT_SCHEMA_VERSION, kind: "review_history", module_id: entry.module_id, entries: same }, { aliasDuplicateObjects: false }));
    }
    const id = randomUUID();
    const pending = ".publication-" + id;
    const backup = ".previous-" + id;
    const staging = path.join(this.control, pending);
    await mkdir(staging);
    try { await cp(this.work, staging, { recursive: true, dereference: false }); } catch (errorCause) { const error = errorDetails(errorCause); if (error.code !== "ENOENT") throw error; }
    for (const report of state.reports) await writeFile(path.join(staging, moduleReportName(report.module_id) + ".archi.yaml"), stringify(report, { aliasDuplicateObjects: false }));
    for (const moduleId of new Set(state.entries.map((e) => e.module_id))) await writeFile(path.join(staging, moduleReportName(moduleId) + ".review.yaml"), stringify({ schema_version: REPORT_SCHEMA_VERSION, kind: "review_history", module_id: moduleId, entries: state.entries.filter((e) => e.module_id === moduleId) }, { aliasDuplicateObjects: false }));
    // Journal является точкой фиксации намерения; все данные уже записаны в staging.
    await this.#atomic(path.join(this.control, ".publication.yaml"), stringify({ schema_version: 1, pending, backup }));
    await this.#recover();
  }

  /** Windows scanners/readers can temporarily hold a directory after the last read. */
  async #renamePublicationDirectory(source: string, destination: string) {
    for (let attempt = 0; ; attempt++) {
      try { await rename(source, destination); return; }
      catch (cause) {
        const error = errorDetails(cause);
        if (process.platform !== "win32" || typeof error.code !== "string" || !["EPERM", "EBUSY", "EACCES"].includes(error.code) || attempt >= 19) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(100, (attempt + 1) * 25)));
      }
    }
  }

  /** Возобновление не удаляет единственную готовую копию work при незавершённом rename. */
  async #recover() {
    const journal = path.join(this.control, ".publication.yaml");
    let value;
    try { value = await readYaml<{schema_version:number;pending:string;backup:string}>(journal); } catch (errorCause) { const error = errorDetails(errorCause); if (error.code === "ENOENT") return; throw error; }
    if (value.schema_version !== 1 || !/^\.publication-[a-f0-9-]{36}$/.test(value.pending) || !/^\.previous-[a-f0-9-]{36}$/.test(value.backup)) throw new Error("Invalid publication recovery journal");
    const pending = path.join(this.control, value.pending), backup = path.join(this.control, value.backup);
    const exists = async (file: string) => { try { const info = await lstat(file); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Invalid publication directory"); return true; } catch (errorCause) { const error = errorDetails(errorCause); if (error.code === "ENOENT") return false; throw error; } };
    const hasPending = await exists(pending), hasBackup = await exists(backup), hasWork = await exists(this.work);
    if (hasPending) {
      try { this.#assertWritable(await this.#read(pending, false)); }
      catch (errorCause) { const error = errorDetails(errorCause);
        // Даже испорченный staging не должен скрывать последнюю исправную публикацию.
        if (!hasWork && hasBackup) await this.#renamePublicationDirectory(backup, this.work);
        throw error;
      }
      if (hasWork && !hasBackup) await this.#renamePublicationDirectory(this.work, backup);
      else if (hasWork && hasBackup) throw new Error("Ambiguous publication recovery");
      await this.#renamePublicationDirectory(pending, this.work);
    } else if (!hasWork && hasBackup) await this.#renamePublicationDirectory(backup, this.work);
    else if (!hasWork) throw new Error("Missing publication recovery data");
    if (hasBackup) this.#assertWritable(await this.#read(this.work, false));
    await rm(backup, { recursive: true, force: true });
    await rm(journal);
  }

  async #atomic(file: string, content: string) {
    await this.snapshotStore.assertLocation(file);
    const temporary = path.join(this.control, ".write-" + randomUUID());
    await writeFile(temporary, content, { flag: "wx" });
    try { await rename(temporary, file); } finally { await rm(temporary, { force: true }); }
  }

  /** Serialize live capture, change-history observation and publication for every session sharing this store. */
  withLivePublication<T>(action: () => Promise<T>): Promise<T> {
    return this.#withLock(".live-publication.lock", action);
  }

  #locked<T>(action: () => Promise<T>): Promise<T> {
    return this.#withLock(".report-store.lock", async () => {
      await this.#recover();
      return action();
    });
  }

  /** Живой процесс не теряет lock из-за таймера; оставшийся после смерти lock восстанавливается. */
  async #withLock<T>(name: string, action: () => Promise<T>): Promise<T> {
    await this.snapshotStore.open();
    await this.snapshotStore.assertLocation(this.control);
    await mkdir(this.control, { recursive: true });
    return withFileLock(this.control, name, action);
  }
}

interface StoreState {
  entries: ReviewEntry[];
  reports: TechnicalReport[];
  diagnostics: string[];
  workErrors: string[];
  integrityErrors: string[];
  rawArchi: Set<string>;
  comparison: PublishedComparison | null;
  publishedEntries?: string;
  publishedDiagnostics?: string;
}
