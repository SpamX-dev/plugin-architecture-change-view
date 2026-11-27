import { withFileLock } from "../../storage/file-lock.js";
import { ArchiveCache } from "../../storage/archive-cache.js";
import { parseReportYaml } from "../../framework/serialization/yaml.js";
import type { SnapshotStore } from "../git-changes/snapshot-store.js";
import type { SnapshotData, Snapshot, ComparisonModule } from "../../framework/snapshots/types.js";
import { normalizeAnalysisType } from "../../framework/ai-report/types.js";
import type {
  ReviewEntry, TechnicalReport,
  CurrentModuleReviews, PublishedComparison, ReviewSlot,
} from "../../framework/static-report/types.js";
import { errorDetails } from "../../node-errors.js";
/**
 * Переносимое хранилище технических отчётов и полной истории содержательных проверок.
 * work содержит самостоятельную публикацию; snapshots хранит локальное накопление.
 * Публикация заменяется целиком под межпроцессным lock с журналом восстановления.
 */
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { stringify } from "yaml";
import { canonical, digest } from "../../framework/serialization/digest.js";
import { compareRepositorySnapshots } from "../git-changes/comparison.js";
import { persistedCopy, publicationIdentity, reconstruct, snapshotFragment, technicalCore, validateStoredReport } from "./publication.js";
import { createReportModel } from "./model.js";
import { createReviewEntry } from "./review-entry.js";
import { historicalResolutionInputs, isSemanticReview, resolutionScope, validateReviewRelations } from "./review-identity.js";
import { validateReviewEntry } from "./review-validation.js";
import { REPORT_SCHEMA_VERSION } from "../../framework/static-report/types.js";

const HASH = /^[a-f0-9]{64}$/;
const START = "# BEGIN ArchiView managed";
const END = "# END ArchiView managed";
const MANAGED = [START, "/snapshots/", "/reviews/", "/saved-*.json", "/.pending-*", "/.snapshot-*", "/.identity-*", END].join("\n");
const payload = ({ registration_order, ...entry }: ReviewEntry) => entry;
const semantic = isSemanticReview;
const reviewSignature = (entries: ReviewEntry[]) => digest(entries.map(entry => [entry.review_id, entry.content_digest, entry.registration_order ?? null])
  .sort(([a],[b]) => String(a).localeCompare(String(b))));
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

/** Identifies the publication directory or an ordinary file across an atomic replacement. */
export async function publishedPathVersion(file: string, directory = false) {
  try {
    const info = await lstat(file, { bigint: true });
    if (directory ? !info.isDirectory() : !info.isFile()) throw new Error("Invalid published " + (directory ? "directory" : "file") + ": " + file);
    return [info.dev, info.ino, info.size, info.ctimeNs, info.mtimeNs].join("/");
  } catch (cause) {
    if (errorDetails(cause).code === "ENOENT") return null;
    throw cause;
  }
}

/** Recognizes the container header; validating its slots also checks project identity and evidence. */
export function isCurrentModuleReviews(value: unknown): value is CurrentModuleReviews {
  return typeof value === "object" && value !== null && "schema_version" in value && value.schema_version === 3 &&
    "kind" in value && value.kind === "module_reviews";
}

export function validateHistoryFile(data: unknown, name: string, snapshotRoot: string) {
  if (!isCurrentModuleReviews(data)) throw new Error("Unsupported module review format: expected module_reviews v3");
  if (typeof data.module_id !== "string" || !data.module_id || name !== moduleReportName(data.module_id) + ".analysis.yaml" ||
      !data.results || typeof data.results !== "object" || Array.isArray(data.results) ||
      Object.keys(data).some(key => !["schema_version", "kind", "module_id", "results", "resolution_inputs"].includes(key)))
    throw new Error("Invalid current module reviews");
  const projectId = digest(snapshotRoot);
  const entries = Object.entries(data.results).map(([slot, entry]) => {
    if (entry?.format !== "native-v2") throw new Error("Unsupported module review entry format");
    validateEntry(entry);
    if (entry.project_id !== projectId || entry.module_id !== data.module_id)
      throw new Error("Invalid module review identity");
    if (slot !== reviewSlot(entry)) throw new Error("Invalid module review slot: " + slot);
    return entry;
  });
  if (data.resolution_inputs !== undefined && (!data.resolution_inputs || typeof data.resolution_inputs !== "object" || Array.isArray(data.resolution_inputs)))
    throw new Error("Invalid archived resolution inputs");
  const archived = new Map(Object.entries(data.resolution_inputs ?? {}));
  validateReviewRelations(entries, archived);
  if (canonical(Object.fromEntries(archived)) !== canonical(Object.fromEntries(historicalResolutionInputs(entries))))
    throw new Error("Invalid archived resolution inputs");
  return entries;
}

function slotKey(entry: ReviewEntry) { return JSON.stringify([entry.module_id, reviewSlot(entry)]); }

export function validatePublishedReviewSet(entries: ReviewEntry[]) {
  return validateReviewRelations(entries, historicalResolutionInputs(entries));
}

export function publishedReviewIds(report: TechnicalReport) {
  const status = report.review_status;
  return status ? [status.self.current, status.self.change, status.explicit_subtree.current, status.explicit_subtree.change]
    .flatMap(side => side.review_ids ?? []) : [];
}

function reviewSlot(entry: ReviewEntry): ReviewSlot {
  return normalizeAnalysisType(entry.manifest.analysis_type) ?? "generic";
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
  readonly #publishedFiles = new ArchiveCache<CheckedFile>();
  readonly #rawFiles = new ArchiveCache<CheckedFile>();
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

  async readModuleReviews(moduleId: string) {
    const file = path.join(this.work, moduleReportName(moduleId) + ".analysis.yaml");
    const journal = path.join(this.control, ".publication.yaml");
    const read = async () => {
      await this.snapshotStore.assertLocation(file);
      try {
        const checked = await this.#checkedFile(file, true);
        if (checked.kind !== "reviews") throw new Error("Invalid module review history");
        return structuredClone(checked.entries);
      } catch (error) { if (errorDetails(error).code === "ENOENT") return []; throw error; }
    };
    await this.snapshotStore.open();
    try {
      await this.snapshotStore.assertLocation(this.work);
      const generation = await publishedPathVersion(this.work, true);
      const entries = await read();
      await this.snapshotStore.assertLocation(journal);
      if (!await publishedPathVersion(journal) && await publishedPathVersion(this.work, true) === generation) return entries;
    } catch {
      // A swap may interrupt path resolution or the archive cache's file-version check.
      // Retry under the writer lock, which also reports persistent read or integrity errors.
    }
    return this.#locked(read);
  }

  async hasReview(moduleId: string, reviewId: string) {
    if ((await this.readModuleReviews(moduleId)).some(entry => entry.review_id === reviewId)) return true;
    return (await this.#receipts()).get(reviewId)?.module === moduleId;
  }

  /** Read consolidated review attempts without parsing technical reports or scanning raw snapshots. */
  async readReviews() {
    return this.#locked(async () => {
      await this.snapshotStore.assertLocation(this.work);
      let names: string[];
      try { names = await readdir(this.work); }
      catch (cause) { if (errorDetails(cause).code === "ENOENT") return []; throw cause; }
      const entries: ReviewEntry[] = [];
      for (const name of names.sort()) {
        if (!name.endsWith(".analysis.yaml")) continue;
        const file = path.join(this.work, name);
        await this.snapshotStore.assertLocation(file);
        const checked = await this.#checkedFile(file, true);
        if (checked.kind !== "reviews") throw new Error("Invalid review history: " + name);
        entries.push(...checked.entries);
      }
      validatePublishedReviewSet(entries);
      return entries.sort((a,b) => (b.registration_order ?? 0) - (a.registration_order ?? 0));
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
    const modules = comparisonModules ?? (await compareRepositorySnapshots(this.snapshotStore.root, baseline, current)).modules;
    if (expectedComparison && publicationIdentity(state.comparison) !== publicationIdentity(expectedComparison)) throw new StalePublicationError();
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
    const statuses = model.aggregateTreeStatuses(state.entries);
    const statusesChanged = state.reports.some(report => statuses.has(report.module_id) &&
      canonical(report.review_status) !== canonical(statuses.get(report.module_id)));
    // Пересчитываем производные статусы и после изменения правил актуальности.
    // Не меняем файлы и время публикации, если все вычисленные данные прежние.
    // Чтение под lock всё равно обнаруживает внешние импорты и повреждения work/raw.
    if (technicalChanged || statusesChanged ||
        state.publishedDiagnostics !== digest([...new Set(state.diagnostics)])) await this.#publish(state);
    const result = this.#result(state);
    return {...result, comparison: state.comparison!, statuses: state.entries.map((entry) => ({ module_id: entry.module_id, review_id: entry.review_id, ...model.reviewFreshness(entry) }))};
  }

  /** Accept completed native exports and replace their current slots under the publication lock. */
  async saveReview(input: unknown, validateCurrent?: (entry: ReviewEntry) => Promise<void>) {
    if (!input || typeof input !== "object") throw new Error("Invalid review import");
    return this.#locked(async () => {
      await this.#prepare();
      const state = await this.#read(this.work, false);
      this.#assertWritable(state);
      const source = isCurrentModuleReviews(input)
        ? validateHistoryFile(input, moduleReportName(input.module_id) + ".analysis.yaml", this.snapshotStore.snapshotRoot)
        : [input as ReviewEntry];
      if (!source.length) throw new Error("Empty review import");
      if (isCurrentModuleReviews(input))
        for (const [id, scope] of Object.entries(input.resolution_inputs ?? {})) state.archivedInputs.set(id, scope);
      const receipts = await this.#receipts();
      for (const receipt of receipts.values()) state.lastOrder = Math.max(state.lastOrder, receipt.order);
      const ids: string[] = [];
      const incoming = new Map<string, ReviewEntry>();
      for (const item of source) {
        if (item.schema_version !== 2 || item.format !== "native-v2" || !["review", "review-input"].includes(item.kind))
          throw new Error("Unsupported review import: expected a native review, review-input or module_reviews v3");
        const entry = item.kind === "review" ? validateEntry(item) : validateEntry(createReviewEntry(item));
        if (entry.project_id !== digest(this.snapshotStore.snapshotRoot)) throw new Error("Foreign review project");
        ids.push(entry.review_id);
        const known = state.byReviewId.get(entry.review_id);
        const receipt = receipts.get(entry.review_id);
        if (known || receipt) {
          if ((known?.module_id ?? receipt?.module) !== entry.module_id || (known?.content_digest ?? receipt?.content) !== entry.content_digest)
            throw new Error("Review ID collision: " + entry.review_id);
          continue;
        }
        for (const target of entry.resolution?.review_ids ?? []) {
          const scope = receipts.get(target)?.scope;
          if (scope) state.archivedInputs.set(target, scope);
        }
        if (validateCurrent && entry.manifest.analysis_type) await validateCurrent(entry);
        const registered = this.#add(state, entry);
        incoming.set(slotKey(registered), registered);
      }
      if (incoming.size) {
        validateReviewRelations(state.entries, state.archivedInputs);
        state.entries = state.entries.filter(entry => {
          const replacement = incoming.get(slotKey(entry));
          if (!replacement || replacement === entry) return true;
          state.retired.push(entry);
          return false;
        });
        await this.#publish(state);
      }
      return ids.length === 1 ? ids[0] : ids;
    });
  }

  #assertProject(snapshot: SnapshotData) {
    if (!snapshot || !("root" in snapshot) || snapshot.root !== this.snapshotStore.snapshotRoot) throw new Error("Foreign review project");
  }

  #assertWritable(state: StoreState) {
    if (state.workErrors.length || state.integrityErrors.length) throw new Error("Published work is damaged; refusing to replace it: " + [...state.workErrors, ...state.integrityErrors].join("; "));
  }

  #result(state: StoreState) {
    return { bundles: state.entries.filter((e) => e.report?.schema_version === 1).map(({ report, manifest, baseline, current }) => ({ report, manifest, baseline, current })),
      entries: state.entries, reports: state.reports, diagnostics: state.diagnostics, comparison: state.comparison };
  }

  async #checkedFile(file: string, published: boolean) {
    await this.snapshotStore.assertLocation(file);
    const name = path.basename(file);
    const cache = published ? this.#publishedFiles : this.#rawFiles;
    // During journal recovery, the validated staging files move together into work.
    const key = published ? name : file;
    return cache.read(file, async (): Promise<CheckedFile> => {
      const data = await readYaml<TechnicalReport | CurrentModuleReviews>(file);
      if (name !== moduleReportName(data.module_id) + (data.kind === "archi" ? ".archi.yaml" : ".analysis.yaml")) throw new Error("Module filename mismatch");
      const directoryHash = path.basename(path.dirname(file));
      if (data.kind === "archi") {
        validateStoredReport(data);
        if (data.project_id !== digest(this.snapshotStore.snapshotRoot)) throw new Error("Foreign technical report project");
        if (published) {
          if (!data.publication) throw new Error("Published technical report lacks snapshot fragments");
          return { kind: "published", report: data };
        }
        if (data.check_hash !== directoryHash) throw new Error("Raw check directory mismatch");
        return { kind: "raw", key: data.check_hash + "/" + data.module_id };
      }
      const entries = validateHistoryFile(data, name, this.snapshotStore.snapshotRoot);
      return { kind: "reviews", entries, moduleId: data.module_id };
    }, key);
  }

  /** Читает текущую публикацию и при полном обходе проверяет архив технических отчётов. */
  async #read(workDirectory = this.work, includeRaw = true) {
    const state: StoreState = { entries: [], retired: [], reports: [], diagnostics: [], workErrors: [], integrityErrors: [],
      rawArchi: new Set(), archivedInputs: new Map(),
      compactSignatures: new Map(), technicalSignatures: new Map(), byReviewId: new Map(), orders:new Set(), lastOrder:0, comparison: null };
    const publishedNames = new Set<string>(), rawPaths = new Set<string>();
    const readDirectory = async (directory: string, published: boolean) => {
      await this.snapshotStore.assertLocation(directory);
      let names;
      try {
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Report directory must be an ordinary directory");
        names = await readdir(directory, { withFileTypes: true });
      } catch (errorCause) { const error = errorDetails(errorCause); if (error.code === "ENOENT") return; throw error; }
      for (const item of names.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!/\.(archi|analysis)\.yaml$/.test(item.name)) continue;
        if (!published && item.name.endsWith(".analysis.yaml")) continue;
        try {
          if (!item.isFile() || item.isSymbolicLink()) throw new Error("Report must be an ordinary file");
          const file = path.join(directory, item.name);
          if (published) publishedNames.add(item.name);
          else rawPaths.add(file);
          const checked = await this.#checkedFile(file, published);
          if (checked.kind === "published") {
            state.reports.push(structuredClone(checked.report));
            state.technicalSignatures.set(checked.report.module_id, digest(checked.report));
            state.diagnostics.push(...checked.report.storage_diagnostics ?? []);
          } else if (checked.kind === "raw") {
            state.rawArchi.add(checked.key);
          } else {
            state.compactSignatures.set(checked.moduleId, reviewSignature(checked.entries));
            for (const [id, scope] of historicalResolutionInputs(checked.entries)) state.archivedInputs.set(id, scope);
            for (const entry of checked.entries) this.#add(state, entry, true);
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
    this.#publishedFiles.retain(publishedNames);
    try { state.comparison = reconstruct(state.reports); } catch (errorCause) { const error = errorDetails(errorCause);
      const message = "work publication: " + error.message;
      state.diagnostics.push(message); state.workErrors.push(message);
    }
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
    if (includeRaw) this.#rawFiles.retain(rawPaths);
    try { validateReviewRelations(state.entries, state.archivedInputs); } catch (errorCause) { const error = errorDetails(errorCause);
      state.diagnostics.push(error.message); state.integrityErrors.push(error.message);
    }
    state.diagnostics = [...new Set(state.diagnostics)];
    return state;
  }

  /** Один review_id обозначает один неизменяемый результат, а не его новые импорты. */
  #add(state: StoreState, value: ReviewEntry, loading = false) {
    const entry = persistedCopy(value);
    const existing = state.byReviewId.get(entry.review_id);
    if (existing) {
      if (canonical(payload(existing)) !== canonical(payload(entry))) throw new Error("Review ID collision: " + entry.review_id);
      return existing;
    }
    if (!loading || !entry.registration_order || state.orders.has(entry.registration_order)) entry.registration_order = state.lastOrder + 1;
    state.lastOrder = Math.max(state.lastOrder, entry.registration_order);
    state.orders.add(entry.registration_order);
    state.byReviewId.set(entry.review_id, entry);
    state.entries.push(entry);
    return entry;
  }

  /** Управляемый блок не заменяет пользовательские правила .gitignore. */
  async #prepare() {
    await this.snapshotStore.ensureIdentity();
    await this.prepareLocalState();
  }

  async prepareLocalState() {
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
    try { await this.#checkedFile(file, false); return; }
    catch (cause) { if (errorDetails(cause).code !== "ENOENT") throw cause; }
    await this.#atomic(file, stringify(report, { aliasDuplicateObjects: false }));
    await this.#checkedFile(file, false);
  }

  async #receipts() {
    const file = path.join(this.control, "registered-results.json");
    await this.snapshotStore.assertLocation(file);
    let rows: Receipt[];
    try {
      if (!(await lstat(file)).isFile()) throw new Error("Invalid review receipts file");
      rows = JSON.parse(await readFile(file, "utf8"));
    } catch (cause) { if (errorDetails(cause).code === "ENOENT") return new Map<string, Receipt>(); throw cause; }
    const checksum = /^sha256:[a-f0-9]{64}$/;
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row.id !== "string" || !row.id || typeof row.module !== "string" || !row.module ||
        !checksum.test(row.content) || !checksum.test(row.scope) ||
        !Number.isSafeInteger(row.order) || row.order < 1)) throw new Error("Invalid review receipts");
    const receipts = new Map(rows.map(row => [row.id, row]));
    if (receipts.size !== rows.length) throw new Error("Duplicate review receipts");
    return receipts;
  }

  /** Создаёт полную следующую публикацию и журнал, позволяющий завершить замену после сбоя. */
  async #publish(state: StoreState) {
    validatePublishedReviewSet(state.entries);
    const comparison = reconstruct(state.reports);
    state.comparison = comparison;
    if (comparison) {
      const statuses = createReportModel(comparison.baseline, comparison.current).aggregateTreeStatuses(state.entries);
      for (const report of state.reports) {
        const status = statuses.get(report.module_id);
        if (status) report.review_status = status;
        else delete report.review_status;
      }
    }
    const anchor = state.reports.find((report) => report.current?.directory === ".") ?? state.reports.find((report) => report.baseline?.directory === ".") ?? state.reports[0];
    if (anchor && state.diagnostics.length) anchor.storage_diagnostics = [...new Set(state.diagnostics)];
    const id = randomUUID();
    const pending = ".publication-" + id;
    const backup = ".previous-" + id;
    const staging = path.join(this.control, pending);
    await mkdir(staging);
    try {
      await cp(this.work, staging, { recursive: true, dereference: false,
        filter: source => path.dirname(source) !== this.work || !source.endsWith(".review.yaml") });
    } catch (errorCause) { const error = errorDetails(errorCause); if (error.code !== "ENOENT") throw error; }
    for (const report of state.reports) {
      if (state.technicalSignatures.get(report.module_id) !== digest(report))
        await writeFile(path.join(staging, moduleReportName(report.module_id) + ".archi.yaml"), stringify(report, {aliasDuplicateObjects:false}));
    }
    const groups = new Map<string, ReviewEntry[]>();
    for (const entry of state.entries) {
      if (!groups.has(entry.module_id)) groups.set(entry.module_id, []);
      groups.get(entry.module_id)!.push(entry);
    }
    for (const [module_id, entries] of groups) {
      if (state.compactSignatures.get(module_id) === reviewSignature(entries)) continue;
      const archived = historicalResolutionInputs(entries);
      const current: CurrentModuleReviews = { schema_version: 3, kind: "module_reviews", module_id,
        results: Object.fromEntries(entries.map(entry => [reviewSlot(entry), entry])),
        ...(archived.size ? {resolution_inputs: Object.fromEntries(archived)} : {}) };
      await writeFile(path.join(staging, moduleReportName(module_id) + ".analysis.yaml"), stringify(current, { aliasDuplicateObjects: false }));
    }
    let registeredResultsDigest: string | undefined;
    if (state.retired.length) {
      const receipts = await this.#receipts();
      for (const entry of state.retired) {
        receipts.set(entry.review_id, {id:entry.review_id, module:entry.module_id, content:entry.content_digest!, scope:resolutionScope(entry), order:entry.registration_order!});
      }
      const text = JSON.stringify([...receipts.values()]);
      registeredResultsDigest = digest(text);
      await this.#atomic(path.join(this.control, pending + ".registered-results.json"), text);
    }
    // Journal является точкой фиксации намерения; все данные уже записаны в staging.
    await this.#atomic(path.join(this.control, ".publication.yaml"), stringify({ schema_version: 1, pending, backup, registeredResultsDigest }));
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
    try { value = await readYaml<{schema_version:number;pending:string;backup:string;registeredResultsDigest?:string}>(journal); } catch (errorCause) { const error = errorDetails(errorCause); if (error.code === "ENOENT") return; throw error; }
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
    if (value.registeredResultsDigest && (hasWork || hasPending)) {
      const source = pending + ".registered-results.json";
      const target = path.join(this.control, "registered-results.json");
      await this.snapshotStore.assertLocation(source);
      await this.snapshotStore.assertLocation(target);
      let file = source;
      try { await lstat(source); } catch (cause) { if (errorDetails(cause).code !== "ENOENT") throw cause; file = target; }
      if (!(await lstat(file)).isFile() || digest(await readFile(file, "utf8")) !== value.registeredResultsDigest)
        throw new Error("Invalid retired review receipts for publication");
      if (file === source) await rename(source, target);
    }
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

type CheckedFile =
  | { kind: "published"; report: TechnicalReport }
  | { kind: "raw"; key: string }
  | { kind: "reviews"; entries: ReviewEntry[]; moduleId: string };

interface Receipt { id: string; module: string; content: string; scope: string; order: number }

interface StoreState {
  entries: ReviewEntry[];
  retired: ReviewEntry[];
  reports: TechnicalReport[];
  diagnostics: string[];
  workErrors: string[];
  integrityErrors: string[];
  rawArchi: Set<string>;
  archivedInputs: Map<string, string>;
  compactSignatures: Map<string, string>;
  technicalSignatures: Map<string, string>;
  byReviewId: Map<string, ReviewEntry>;
  orders: Set<number>;
  lastOrder: number;
  comparison: PublishedComparison | null;
  publishedDiagnostics?: string;
}
