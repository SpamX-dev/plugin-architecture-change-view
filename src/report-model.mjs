/**
 * Переносимая модель отчётов v2 без ввода-вывода. Технический check_hash описывает
 * входы одного модуля, а применимость LLM-оценки — её собственный манифест.
 * Эти идентичности намеренно различаются: реализация потомка меняет техническое
 * поддерево родителя, но не обнуляет проверку его собственной композиции.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { canonical, contractDocument, digest, validateReview } from "./formats.mjs";
import { ANALYZER, createStructuralReview, effectiveClauses as effectiveClausesForSnapshot, requiredClauseChecks, validateContractScope,
  validateReviewBundle } from "./reviews.mjs";

export const REPORT_SCHEMA_VERSION = 2;
const NORMALIZATION = "archiview/module-state/v1";
const SEMANTIC_FIELDS = ["id", "kind", "purpose", "responsibilities", "boundaries", "invariants"];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sorted = (values, key = (v) => canonical(v)) => [...values].sort((a, b) => compare(key(a), key(b)));
const clone = (value) => value == null ? value : structuredClone(value);
const contractFile = (file) => ["arch.yaml", "module.md"].includes(path.posix.basename(file));
const normalizeText = (text) => text.replace(/\r\n?/g, "\n");
const moduleId = (module) => module?.document?.state === "documented" && module.document.contract?.id || "directory:" + module.directory;

/** Смысл контракта отделён от заголовка, оформления YAML и сырого arch.yaml. */
export function semanticContract(contract) {
  return contract ? Object.fromEntries(SEMANTIC_FIELDS.filter((key) => contract[key] !== undefined)
    .map((key) => [key, clone(contract[key])])) : null;
}

/**
 * Файловые факты дают нормализованный текст; для бинарных/недоступных текстов
 * сохраняется исходный отпечаток снимка с явным указанием способа сравнения.
 * mtime и абсолютный корень ни в один отпечаток состояния не входят.
 */
function fileInput(snapshot, file) {
  const fact = snapshot?.facts?.find((item) => item.kind === "file" && item.path === file.path && typeof item.text === "string");
  return { path: file.path, digest: fact ? digest({ text: normalizeText(fact.text) }) :
    digest({ captured_hash: file.hash ?? null }), normalization: fact ? "text-lf/v1" : "captured-hash/v1",
  ...(file.error ? { error: file.error } : {}) };
}

/** Применимые границы/инварианты предков; чужие responsibilities не наследуются. */
function inheritedInputs(modules, directory) {
  return sorted(modules.filter((module) => module.directory !== directory &&
    (module.directory === "." || directory.startsWith(module.directory + "/")))
    .flatMap((module) => ["boundaries", "invariants"].flatMap((section) =>
      Object.entries(module.document?.contract?.[section] ?? {}).map(([id, text]) =>
        ({ module_id: moduleId(module), section, id, text })))),
  (item) => [item.module_id, item.section, item.id].join("\0"));
}

/**
 * Строит одновременно техническое состояние и обязательные входы self. Карта
 * использует устойчивый id; directory:... — явный технический ключ модуля без
 * действующего контракта, который никогда не получает полную актуальность.
 */
export function buildModuleStates(snapshot) {
  const states = new Map();
  const modules = snapshot?.modules ?? [];
  const byDirectory = new Map(modules.map((module) => [module.directory, module]));
  for (const module of modules) {
    const id = moduleId(module);
    if (states.has(id)) throw new Error("Duplicate module identity: " + id);
    let parentDirectory = module.directory === "." ? null : path.posix.dirname(module.directory);
    while (parentDirectory !== null && !byDirectory.has(parentDirectory)) {
      parentDirectory = parentDirectory === "." ? null : path.posix.dirname(parentDirectory);
    }
    const ownFiles = sorted((module.files ?? []).filter((file) => !contractFile(file.path))
      .map((file) => fileInput(snapshot, file)), (file) => file.path);
    const inherited = inheritedInputs(modules, module.directory);
    const contract = module.document?.contract ?? null;
    const technical = { normalization: NORMALIZATION, module_id: id, directory: module.directory,
      own_files: ownFiles, contract: clone(contract), document_state: module.document?.state ?? "missing", inherited,
      ...(!contract && module.document?.text ? { invalid_contract_digest: digest(normalizeText(module.document.text)) } : {}) };
    states.set(id, { module_id: id, directory: module.directory,
      parent_id: parentDirectory === null ? null : moduleId(byDirectory.get(parentDirectory)),
      children: [], technical, technical_digest: digest(technical),
      complete: snapshot.complete !== false && module.document?.state === "documented" && Boolean(contract) && !ownFiles.some((file) => file.error) &&
        modules.filter((ancestor) => ancestor.directory !== module.directory &&
          (ancestor.directory === "." || module.directory.startsWith(ancestor.directory + "/")))
          .every((ancestor) => ancestor.document?.state === "documented" && ancestor.document.contract),
      self: { normalization: NORMALIZATION, module_id: id, directory: module.directory,
        own_files: clone(ownFiles), contract: semanticContract(contract), inherited, children: [] } });
  }
  for (const state of states.values()) if (state.parent_id !== null) states.get(state.parent_id)?.children.push(state.module_id);
  for (const state of states.values()) {
    state.children.sort(compare);
    state.self.children = state.children.map((id) => ({ module_id: id, directory: states.get(id).directory,
      contract: semanticContract(states.get(id).technical.contract), document_state: states.get(id).technical.document_state }));
    state.complete &&= state.self.children.every((child) => child.document_state === "documented" && child.contract);
    state.self_digest = digest(state.self);
  }
  const subtree = (id) => {
    const state = states.get(id);
    if (state.subtree_digest) return state.subtree_digest;
    state.subtree = { self: state.technical_digest,
      children: state.children.map((child) => ({ module_id: child, digest: subtree(child) })) };
    state.subtree_digest = digest(state.subtree);
    state.semantic_subtree = { self: state.self_digest,
      children: state.children.map((child) => ({ module_id: child, digest: states.get(child).semantic_subtree_digest })) };
    state.semantic_subtree_digest = digest(state.semantic_subtree);
    return state.subtree_digest;
  };
  for (const id of states.keys()) subtree(id);
  return states;
}

/** База фиксируется commit/id, а не подвижной меткой HEAD или абсолютным root. */
function baselineIdentity(snapshot) {
  if (!snapshot) return null;
  return { kind: snapshot.kind ?? "snapshot", id: snapshot.revision ?? snapshot.id ??
    digest(sorted([...buildModuleStates(snapshot).values()].map((state) =>
      ({ module_id: state.module_id, digest: state.subtree_digest })), (state) => state.module_id)) };
}

/** Состояние отсутствующего модуля отличается от отсутствующей базы. */
const stateReference = (state) => state ? { exists: true, directory: state.directory,
  self_digest: state.technical_digest, subtree_digest: state.subtree_digest } : { exists: false };

/** Формирует чистый технический результат; будущие LLM-статусы в него не пишутся. */
export function createTechnicalReport(projectId, baseline, current, comparisonModule) {
  const id = comparisonModule.moduleId ?? comparisonModule.module_id ??
    (comparisonModule.after ? moduleId(comparisonModule.after) : comparisonModule.before ? moduleId(comparisonModule.before) :
      "directory:" + comparisonModule.directory);
  const before = buildModuleStates(baseline).get(id);
  const after = buildModuleStates(current).get(id);
  const input = { domain: "archiview/module-check/v1", project_id: projectId, module_id: id,
    baseline: baseline ? { identity: baselineIdentity(baseline), state: stateReference(before) } : null,
    current: stateReference(after), analyzer: clone(ANALYZER) };
  const ownChanged = canonical(before?.technical.own_files ?? null) !== canonical(after?.technical.own_files ?? null);
  const childrenChanged = canonical(before?.subtree.children ?? []) !== canonical(after?.subtree.children ?? []);
  const contractChanged = canonical(before?.technical.contract ?? null) !== canonical(after?.technical.contract ?? null);
  const inheritedChanged = canonical(before?.self.inherited ?? []) !== canonical(after?.self.inherited ?? []);
  return { schema_version: REPORT_SCHEMA_VERSION, kind: "archi", module_id: id, project_id: projectId,
    check_hash: digest(input).slice(7), input_manifest: input,
    baseline: before ? clone(before) : null, current: after ? clone(after) : null,
    change: { existence: !baseline ? "initial" : !before ? "added" : !after ? "removed" : "retained",
      own: ownChanged || contractChanged || before?.directory !== after?.directory,
      own_code: ownChanged, own_contract: contractChanged, inherited_constraints: inheritedChanged,
      descendants: childrenChanged,
      child_composition: canonical(before?.self.children ?? []) !== canonical(after?.self.children ?? []),
      moved: Boolean(before && after && before.directory !== after.directory) },
    structure: { complete: (before?.complete ?? true) && (after?.complete ?? true),
      diagnostics: clone([...(baseline?.diagnostics ?? []), ...(current?.diagnostics ?? [])]),
      document_state: after?.technical.document_state ?? before?.technical.document_state ?? "missing" } };
}

/** Внешняя структура не считается LLM-попыткой даже при наличии пустых findings. */
export function isSemanticReview(entry) {
  const report = entry.report ?? entry;
  return report.analysis?.analyzer?.name !== ANALYZER.name && entry.analysis_kind !== "structure";
}

/**
 * Явные зависимости — селекторы реально сохранённых данных. API допускается
 * только как отдельный файл: неизменность arch.yaml не доказывает неизменность
 * API реализации. Произвольный digest без разрешимого источника не принимается.
 */
function dependencyInput(selector, snapshot, states, contractScope) {
  const kind = selector.kind;
  const module = selector.module_id ? states.get(selector.module_id) : null;
  if (kind === "contract") {
    if (!module?.technical.contract) return { selector: clone(selector), available: false };
    const fields = selector.fields ? sorted(selector.fields) : SEMANTIC_FIELDS;
    const content = Object.fromEntries(fields.filter((key) => Object.hasOwn(module.technical.contract, key))
      .map((key) => [key, clone(module.technical.contract[key])]));
    return { selector: clone(selector), available: true, digest: digest(content), content };
  }
  if (kind === "module") {
    if (contractScope === "own") {
      const selected = module ? sorted([...states.values()].filter((item) => item.module_id === module.module_id ||
        selector.scope === "subtree" && (module.directory === "." || item.directory.startsWith(module.directory + "/"))), (item) => item.module_id) : [];
      return { selector: clone(selector), available: Boolean(module) && selected.every((item) => reviewModuleComplete(item, contractScope)),
        ...(module ? { digest: digest(selector.scope === "subtree" ? selected.map((item) =>
          ({ module_id: item.module_id, state: reviewProjection(item, contractScope) })) : reviewProjection(module, contractScope)) } : {}) };
    }
    return { selector: clone(selector), available: Boolean(module) && module.complete,
      ...(module ? { digest: selector.scope === "subtree" ? module.semantic_subtree_digest : module.self_digest } : {}) };
  }
  if (["file", "api"].includes(kind)) {
    const owner = (snapshot?.modules ?? []).find((item) => (item.files ?? []).some((file) => file.path === selector.path));
    const file = owner?.files.find((item) => item.path === selector.path);
    const fact = snapshot?.facts?.find((item) => item.kind === "file" && item.path === selector.path && typeof item.text === "string");
    return { selector: clone(selector), available: Boolean(file) && !file.error && Boolean(fact),
      ...(file ? { digest: fileInput(snapshot, file).digest } : {}),
      ...(fact ? { content: normalizeText(fact.text) } : {}) };
  }
  throw new Error("Unsupported dependency kind: " + kind);
}

/**
 * Техническая модель сохраняет прежнее происхождение и контекст снимка.
 * Новая собственная оценка использует отдельную проекцию без пунктов предков;
 * совместимость с назначением родителя проверяется в композиции родителя.
 */
function reviewProjection(state, contractScope) {
  const projection = clone(state.self);
  if (contractScope === "own") delete projection.inherited;
  return projection;
}

/** Для локальной проверки нужны свой контракт, свои файлы и контракты композиции. */
function reviewModuleComplete(state, contractScope) {
  if (contractScope !== "own") return state.complete;
  return state.technical.document_state === "documented" && Boolean(state.technical.contract) &&
    state.self.own_files.every((file) => !file.error && file.normalization === "text-lf/v1") &&
    state.self.children.every((child) => child.document_state === "documented" && child.contract);
}

/** Самостоятельная self-проекция не содержит реализацию потомков или контекст предков. */
function reviewState(snapshot, id, scope, selectors, dependencyCoverage, contractScope = "effective") {
  const states = buildModuleStates(snapshot);
  const state = states.get(id);
  const descendants = state && scope === "subtree" ? sorted([...states.values()].filter((item) =>
    item.module_id === id || state.directory === "." || item.directory.startsWith(state.directory + "/")), (item) => item.module_id) : [];
  return { exists: Boolean(state), state: state ? reviewProjection(state, contractScope) : null,
    ...(scope === "subtree" ? { subtree: descendants.map((item) => ({ module_id: item.module_id, state: reviewProjection(item, contractScope) })) } : {}),
    complete: snapshot?.complete !== false && (!state || reviewModuleComplete(state, contractScope)) &&
      (!state || state.self.own_files.every((file) => file.normalization === "text-lf/v1")) &&
      descendants.every((item) => reviewModuleComplete(item, contractScope) && item.self.own_files.every((file) => file.normalization === "text-lf/v1")),
    dependencies: sorted(selectors.map((selector) => dependencyInput(selector, snapshot, states, contractScope)), (item) => canonical(item.selector)),
    dependency_coverage: clone(dependencyCoverage) };
}

/** Отпечаток входов оценки не включает метаданные самой LLM-попытки. */
function assessmentDigest(input) { return digest(input); }

/** Готовит независимые current/change входы; полнота dependencies всегда явная. */
function createInputs(baseline, current, id, options, semantic) {
  const scope = options.scope ?? "self";
  if (!["self", "subtree"].includes(scope)) throw new Error("Unsupported review scope: " + scope);
  const contractScope = options.contractScope ?? "effective";
  if (!["own", "effective"].includes(contractScope)) throw new Error("Unsupported contract scope");
  const dependencies = options.dependencies ?? [];
  const declaredCoverage = options.dependencyCoverage ?? options.dependency_coverage ??
    { status: semantic ? "unknown" : "complete", potential_influence: semantic ? [{ scope: "project" }] : [] };
  const coverage = { ...clone(declaredCoverage), potential_influence: clone(declaredCoverage.potential_influence ??
    (declaredCoverage.status === "complete" ? [] : [{ scope: "project" }])) };
  if (!["complete", "unknown"].includes(coverage.status)) throw new Error("Invalid dependency coverage");
  const result = { schema_version: 1, scope, ...(contractScope === "own" ? { contract_scope: "own" } : {}),
    current: reviewState(current, id, scope, dependencies, coverage, contractScope),
    baseline: baseline ? reviewState(baseline, id, scope, dependencies, coverage, contractScope) : null,
    baseline_identity: baselineIdentity(baseline) };
  result.current_digest = assessmentDigest(result.current);
  result.change_digest = assessmentDigest({ baseline_identity: result.baseline_identity, baseline: result.baseline, current: result.current });
  return result;
}

/** Факты внешнего/широкого review не теряются при миграции прежнего пакета. */
export function createReviewEntry(bundle, options = {}) {
  if (bundle.schema_version === 2 && ["review", "review-input"].includes(bundle.kind)) {
    if (bundle.kind === "review") return validateReviewEntry(clone(bundle));
    const entry = clone(bundle);
    entry.kind = "review";
    entry.review_id = entry.report?.id ?? entry.review_id;
    entry.analysis_kind = isSemanticReview(entry) ? "semantic" : "structure";
    entry.input_digest = digest({ inputs: entry.inputs, manifest: entry.manifest });
    entry.result_digest = resultDigest(entry.report);
    entry.content_digest = entryContentDigest(entry);
    return validateReviewEntry(entry);
  }
  validateReviewBundle(bundle);
  const id = bundle.report.module.id ?? "directory:" + (bundle.report.module.current_path ?? bundle.report.module.baseline_path);
  const semantic = isSemanticReview(bundle);
  const inputs = createInputs(bundle.baseline, bundle.current, id,
    { ...options, contractScope: bundle.manifest.contract_scope ?? "effective" }, semantic);
  const comparisonModule = { moduleId: id, directory: bundle.report.module.current_path ?? bundle.report.module.baseline_path };
  const technical = createTechnicalReport(options.projectId ?? options.project_id ?? "legacy", bundle.baseline, bundle.current, comparisonModule);
  const entry = { schema_version: REPORT_SCHEMA_VERSION, kind: "review", module_id: id,
    review_id: bundle.report.id, project_id: options.projectId ?? options.project_id ?? null,
    check_hash: technical.check_hash,
    analysis_kind: semantic ? "semantic" : "structure", format: "legacy-v1", inputs,
    report: clone(bundle.report), manifest: clone(bundle.manifest), baseline: clone(bundle.baseline), current: clone(bundle.current) };
  entry.input_digest = digest({ inputs, manifest: entry.manifest });
  entry.result_digest = resultDigest(entry.report);
  entry.content_digest = entryContentDigest(entry);
  return validateReviewEntry(entry);
}

/** Результат без времени/id позволяет группировать только одинаковые реальные попытки. */
export function resultDigest(report) {
  return digest({ observed: report.observed, checks: report.checks, findings: report.findings,
    assessment: report.assessment, coverage: report.analysis?.coverage });
}

/** Весь пакет, включая сохранённые доказательства, защищён отдельным отпечатком. */
function entryContentDigest(entry) {
  const { content_digest, registration_order, ...content } = entry;
  return digest(content);
}

/**
 * Native экспорт содержит только область проверки. Прежние snapshot id/digest
 * остаются происхождением, а scope_digest удостоверяет именно сохранённую часть.
 */
function scopedSnapshot(snapshot, id, options, report) {
  if (!snapshot) return null;
  const states = buildModuleStates(snapshot);
  const own = states.get(id);
  const ids = new Set([id]);
  if (own) {
    let parent = own.parent_id;
    while (parent !== null) { ids.add(parent); parent = states.get(parent)?.parent_id ?? null; }
    own.children.forEach((child) => ids.add(child));
    if (options.scope === "subtree") for (const state of states.values()) {
      if (own.directory === "." || state.directory.startsWith(own.directory + "/")) ids.add(state.module_id);
    }
  }
  const filePaths = new Set();
  for (const selector of options.dependencies ?? []) {
    if (selector.module_id) ids.add(selector.module_id);
    if (selector.path) filePaths.add(selector.path);
    if (selector.kind === "module" && selector.scope === "subtree") {
      const dependency = states.get(selector.module_id);
      if (dependency) for (const state of states.values()) if (dependency.directory === "." || state.directory.startsWith(dependency.directory + "/")) ids.add(state.module_id);
    }
  }
  const references = new Set((report ? [...report.checks.flatMap((check) => check.evidence),
    ...report.findings.flatMap((finding) => finding.evidence),
    ...Object.values(report.observed).flatMap((observation) => observation?.responsibilities.flatMap((item) => item.evidence) ?? [])] : [])
    .map((reference) => reference.fact_id));
  const fullIds = new Set([id]);
  if (options.scope === "subtree" && own) for (const state of states.values()) {
    if (own.directory === "." || state.directory.startsWith(own.directory + "/")) fullIds.add(state.module_id);
  }
  for (const selector of options.dependencies ?? []) if (selector.kind === "module") {
    fullIds.add(selector.module_id);
    if (selector.scope === "subtree") {
      const dependency = states.get(selector.module_id);
      if (dependency) for (const state of states.values()) if (dependency.directory === "." || state.directory.startsWith(dependency.directory + "/")) fullIds.add(state.module_id);
    }
  }
  // Контекст использованной реализации нужен для воспроизводимости её self
  // проекции. Контрактная зависимость, напротив, не затягивает реализацию.
  for (const fullId of fullIds) {
    const state = states.get(fullId);
    if (!state) continue;
    state.children.forEach((child) => ids.add(child));
    let parent = state.parent_id;
    while (parent !== null) { ids.add(parent); parent = states.get(parent)?.parent_id ?? null; }
  }
  const facts = (snapshot.facts ?? []).filter((fact) => references.has(fact.id) || filePaths.has(fact.path) ||
    (snapshot.modules ?? []).some((module) => ids.has(moduleId(module)) && fact.path === module.documentPath) ||
    (snapshot.modules ?? []).some((module) => fullIds.has(moduleId(module)) && (module.files ?? []).some((file) => file.path === fact.path)));
  const modules = snapshot.modules.filter((module) => ids.has(moduleId(module)) || (module.files ?? []).some((file) => filePaths.has(file.path)))
    .map((module) => ({ ...clone(module), files: clone((module.files ?? []).filter((file) => fullIds.has(moduleId(module)) || contractFile(file.path) || filePaths.has(file.path))) }));
  const result = { schema_version: 2, id: snapshot.id, digest: snapshot.digest,
    kind: snapshot.kind, revision: snapshot.revision, complete: snapshot.complete,
    modules, facts: clone(facts), diagnostics: clone(snapshot.diagnostics ?? []),
    evidenceLimitations: clone(snapshot.evidenceLimitations ?? []), scoped: true };
  result.scope_digest = digest(result);
  return result;
}

/**
 * Экспорт для агента. Пустая модель/неполные зависимости — незавершённый шаблон,
 * который нельзя импортировать как подтверждённую LLM-попытку без заполнения.
 * report сохраняет известную схему checks/findings v1 для существующего UI.
 */
export function createReviewInput(projectId, baseline, current, id, options = {}) {
  options = { ...options, contractScope: options.contractScope ?? "own" };
  const states = buildModuleStates(current);
  const beforeStates = buildModuleStates(baseline);
  const state = states.get(id) ?? beforeStates.get(id);
  if (!state) throw new Error("Unknown review module: " + id);
  const beforeModule = baseline?.modules.find((module) => moduleId(module) === id) ?? null;
  const afterModule = current.modules.find((module) => moduleId(module) === id) ?? null;
  const comparison = { moduleId: id, directory: state.directory, baselinePath: beforeModule?.directory ?? null,
    currentPath: afterModule?.directory ?? null, before: beforeModule, after: afterModule };
  const bundle = createStructuralReview(baseline, current, comparison, options);
  bundle.report.id = options.reviewId ?? "review-" + randomUUID();
  bundle.report.analysis.analyzer = { name: "agent-review", version: "1", config_digest: digest({ method: "agent" }) };
  bundle.manifest.analyzer = clone(bundle.report.analysis.analyzer);
  bundle.manifest.instructions = "Проверить только собственную ответственность, границы, инварианты и свою композицию. Контракты предков служат контекстом и не добавляют пункты в чеклист. Зависимости задавать по реально использованному контракту/API, не по расположению каталога. Заполнить модель, prompt и результаты.";
  bundle.manifest.review_scope = options.scope ?? "self";
  bundle.report.analysis.input_digest = digest(bundle.manifest);
  const inputs = createInputs(baseline, current, id, options, true);
  const technical = createTechnicalReport(projectId, baseline, current, comparison);
  const entry = { schema_version: REPORT_SCHEMA_VERSION, kind: "review-input", module_id: id,
    project_id: projectId, review_id: bundle.report.id,
    check_hash: technical.check_hash, check_manifest: technical.input_manifest,
    analysis_kind: "semantic", format: "native-v2", inputs,
    report: clone(bundle.report), manifest: clone(bundle.manifest),
    baseline: scopedSnapshot(baseline, id, options, bundle.report), current: scopedSnapshot(current, id, options, bundle.report) };
  return entry;
}

/** Проверяет ссылки внутри сохранённых частей, не читая нынешние исходники. */
function validateScopedProof(entry) {
  for (const snapshot of [entry.baseline, entry.current].filter(Boolean)) {
    const { scope_digest, ...content } = snapshot;
    if (snapshot.schema_version !== 2 || !snapshot.scoped || digest(content) !== scope_digest) throw new Error("Scoped snapshot digest mismatch");
    const allowed = ["schema_version", "id", "digest", "kind", "revision", "complete", "modules", "facts",
      "diagnostics", "evidenceLimitations", "scoped", "scope_digest"];
    if (Object.keys(snapshot).some((key) => !allowed.includes(key))) throw new Error("Unknown scoped snapshot field");
    if (!Array.isArray(snapshot.modules) || !Array.isArray(snapshot.facts)) throw new Error("Invalid scoped snapshot collections");
    const relative = (value, directory = false) => typeof value === "string" && (directory && value === "." ||
      value.length > 0 && !/[\\:]/.test(value) && !value.startsWith("/") &&
      !value.split("/").some((part) => ["", ".", ".."].includes(part)));
    if (new Set(snapshot.modules.map((module) => module.directory)).size !== snapshot.modules.length ||
      snapshot.modules.some((module) => !relative(module.directory, true) || !Array.isArray(module.files) ||
        module.files.some((file) => !relative(file.path)))) throw new Error("Invalid scoped module paths");
    if (new Set(snapshot.facts.map((fact) => fact.id)).size !== snapshot.facts.length) throw new Error("Duplicate scoped evidence identity");
    for (const module of snapshot.modules) if (module.document?.state === "documented") {
      const parsed = contractDocument(module.document.text, module.document.format ?? "arch.yaml");
      if (parsed.state !== "documented" || canonical(parsed.contract) !== canonical(module.document.contract)) throw new Error("Saved contract text disagrees with parsed contract");
      const contractFact = snapshot.facts.find((fact) => fact.kind === "file" && fact.path === module.documentPath);
      if (contractFact && normalizeText(contractFact.text) !== normalizeText(module.document.text)) throw new Error("Saved contract evidence disagrees with document");
    }
    for (const fact of snapshot.facts) {
      const { id, ...content } = fact;
      if (digest(content) !== id || typeof fact.text !== "string" || !relative(fact.path, fact.kind === "module")) throw new Error("Evidence content digest mismatch");
    }
  }
  const evidence = (reference) => {
    const snapshot = entry[reference.snapshot];
    if ((snapshot?.facts ?? []).filter((fact) => fact.id === reference.fact_id).length !== 1) throw new Error("Unresolved evidence: " + reference.fact_id);
  };
  const clause = (reference) => {
    const modules = entry[reference.snapshot]?.modules.filter((module) => module.document?.contract?.id === reference.module_id) ?? [];
    if (modules.length !== 1 || !Object.hasOwn(modules[0].document.contract[reference.section] ?? {}, reference.id)) throw new Error("Unresolved contract clause: " + reference.module_id);
  };
  for (const check of entry.report.checks) { clause(check.contract); check.evidence.forEach(evidence); }
  for (const finding of entry.report.findings) { finding.clauses.forEach(clause); finding.evidence.forEach(evidence); }
  for (const observed of Object.values(entry.report.observed)) observed?.responsibilities.forEach((item) => item.evidence.forEach(evidence));
  // Все требуемые собственные пункты остаются явными, включая честное not_checked.
  // Удаление неудобного пункта не превращает неполный анализ в полный.
  for (const { item, subject } of requiredClauseChecks(entry.manifest, entry.report.module.current_path !== null)) {
    if (!entry.report.checks.some((check) => check.subject === subject &&
      canonical(check.contract) === canonical(item.reference))) throw new Error("Missing explicit clause check: " + item.reference.id);
  }
}

/** Строгая целостность переносимой записи; неизвестные версии не «актуальны». */
export function validateReviewEntry(entry) {
  if (entry?.schema_version !== REPORT_SCHEMA_VERSION || entry.kind !== "review" || !["native-v2", "legacy-v1"].includes(entry.format)) throw new Error("Unsupported review entry schema");
  if (!entry.module_id || entry.review_id !== entry.report?.id || !/^[a-f0-9]{64}$/.test(entry.check_hash)) throw new Error("Invalid review entry identity");
  validateReview(entry.report);
  if (entry.report.module.id !== null && entry.module_id !== entry.report.module.id) throw new Error("Review module identity mismatch");
  if (!entry.inputs || entry.inputs.schema_version !== 1 || !["self", "subtree"].includes(entry.inputs.scope)) throw new Error("Unsupported review inputs");
  const contractScope = validateContractScope(entry.report, entry.manifest);
  if ((entry.inputs.contract_scope ?? "effective") !== contractScope) throw new Error("Review contract scope mismatch");
  if (assessmentDigest(entry.inputs.current) !== entry.inputs.current_digest ||
    assessmentDigest({ baseline_identity: entry.inputs.baseline_identity, baseline: entry.inputs.baseline, current: entry.inputs.current }) !== entry.inputs.change_digest) throw new Error("Review assessment input digest mismatch");
  for (const input of [entry.inputs.current, entry.inputs.baseline].filter(Boolean)) {
    if (!Array.isArray(input.dependencies) || !["complete", "unknown"].includes(input.dependency_coverage?.status) ||
      !Array.isArray(input.dependency_coverage.potential_influence)) throw new Error("Missing explicit dependency coverage");
    if (input.dependency_coverage.status === "complete" && input.dependency_coverage.potential_influence.length) throw new Error("Complete dependencies still have unresolved influence");
    if (new Set(input.dependencies.map((dependency) => canonical(dependency.selector))).size !== input.dependencies.length) throw new Error("Duplicate dependency selector");
  }
  if (entry.input_digest !== digest({ inputs: entry.inputs, manifest: entry.manifest }) || entry.result_digest !== resultDigest(entry.report) || entry.content_digest !== entryContentDigest(entry)) throw new Error("Review entry content digest mismatch");
  if (entry.format === "legacy-v1") validateReviewBundle(entry);
  else {
    if (typeof entry.project_id !== "string" || !entry.project_id || !entry.check_manifest || digest(entry.check_manifest).slice(7) !== entry.check_hash ||
      entry.check_manifest.project_id !== entry.project_id || entry.check_manifest.module_id !== entry.module_id ||
      entry.check_manifest.domain !== "archiview/module-check/v1") throw new Error("Native technical check manifest mismatch");
    if (!entry.report.analysis.model || !entry.report.analysis.prompt_digest) throw new Error("Native LLM review needs model and prompt_digest");
    if (digest(entry.manifest) !== entry.report.analysis.input_digest ||
      digest(entry.manifest.module) !== digest(entry.report.module) ||
      digest(entry.manifest.comparison) !== digest(entry.report.comparison) ||
      entry.manifest.scope !== entry.report.analysis.scope ||
      entry.manifest.review_scope !== entry.inputs.scope ||
      digest(entry.manifest.analyzer) !== digest(entry.report.analysis.analyzer) ||
      digest(entry.manifest.model) !== digest(entry.report.analysis.model) || entry.manifest.prompt_digest !== entry.report.analysis.prompt_digest) throw new Error("Native review manifest mismatch");
    validateScopedProof(entry);
    for (const [side, snapshot] of [["baseline", entry.baseline], ["current", entry.current]]) {
      const reference = entry.report.comparison[side];
      if ((snapshot === null) !== (reference === null) || (snapshot &&
        (snapshot.id !== reference.id || snapshot.digest !== reference.digest))) throw new Error("Native snapshot provenance mismatch: " + side);
      const input = entry.inputs[side];
      if ((snapshot === null) !== (input === null)) throw new Error("Missing native assessment input: " + side);
      if (!snapshot) continue;
      const selectors = input.dependencies.map((dependency) => dependency.selector);
      const actual = reviewState(snapshot, entry.module_id, entry.inputs.scope, selectors, input.dependency_coverage, contractScope);
      if (canonical(actual) !== canonical(input)) throw new Error("Native assessment inputs disagree with saved snapshot: " + side);
      const directory = entry.report.module[side + "_path"];
      const own = snapshot.modules.find((module) => moduleId(module) === entry.module_id);
      if ((own?.directory ?? null) !== directory) throw new Error("Native module path mismatch: " + side);
      const state = buildModuleStates(snapshot).get(entry.module_id);
      const technicalReference = side === "baseline" ? entry.check_manifest.baseline?.state : entry.check_manifest.current;
      if (technicalReference?.exists !== Boolean(state) || (state && (technicalReference.directory !== state.directory ||
        technicalReference.self_digest !== state.technical_digest))) throw new Error("Native technical own-state mismatch: " + side);
      const actualClauses = effectiveClausesForSnapshot(snapshot, directory, side, contractScope);
      if (canonical(actualClauses) !== canonical(entry.manifest.contracts?.[side])) throw new Error("Native effective contracts mismatch: " + side);
    }
    if (canonical(entry.inputs.baseline_identity) !== canonical(baselineIdentity(entry.baseline))) throw new Error("Native baseline identity mismatch");
    if (canonical(entry.check_manifest.baseline?.identity ?? null) !== canonical(entry.inputs.baseline_identity)) throw new Error("Native technical baseline mismatch");
    if (entry.report.analysis.coverage.status === "complete") {
      if ([entry.inputs.current, entry.inputs.baseline].filter(Boolean).some((input) => !input.complete ||
        input.dependency_coverage.status !== "complete" || input.dependencies.some((dependency) => !dependency.available)) ||
        entry.report.checks.some((check) => ["not_checked", "uncertain"].includes(check.verdict))) throw new Error("Complete native review has unreviewed inputs or clauses");
    }
  }
  if (entry.resolution && (!Array.isArray(entry.resolution.review_ids) || !entry.resolution.review_ids.length ||
    entry.resolution.review_ids.some((id) => typeof id !== "string" || !id || id === entry.review_id) ||
    new Set(entry.resolution.review_ids).size !== entry.resolution.review_ids.length ||
    typeof entry.resolution.reason !== "string" || !entry.resolution.reason.trim())) throw new Error("Invalid explicit review resolution");
  return entry;
}

/**
 * Явный разбор расхождения — новая попытка со ссылками на прежние, а не их
 * удаление. Разрешать можно только ту же область и оба набора входов; смена
 * кода не разрешает спор о прежнем коде. Хранилище вызывает это перед записью.
 */
export function validateReviewRelations(entries) {
  const byId = new Map();
  for (const entry of entries) {
    const previous = byId.get(entry.review_id);
    if (previous && entryContentDigest(previous) !== entryContentDigest(entry)) throw new Error("Review id collision: " + entry.review_id);
    byId.set(entry.review_id, entry);
  }
  for (const entry of entries) for (const id of entry.resolution?.review_ids ?? []) {
    const target = byId.get(id);
    if (!target) throw new Error("Unresolved review resolution: " + id);
    if (!isSemanticReview(entry) || !isSemanticReview(target) || entry.module_id !== target.module_id ||
      entry.inputs?.scope !== target.inputs?.scope || entry.inputs?.current_digest !== target.inputs?.current_digest ||
      entry.inputs?.change_digest !== target.inputs?.change_digest) throw new Error("Review resolution scope/input mismatch: " + id);
  }
  const visit = (id, ancestors = new Set()) => {
    if (ancestors.has(id)) throw new Error("Cyclic review resolution");
    const next = new Set([...ancestors, id]);
    for (const target of byId.get(id)?.resolution?.review_ids ?? []) visit(target, next);
  };
  for (const id of byId.keys()) visit(id);
  return entries;
}

/** Известные причины инвалидации не смешиваются с неизвестной полнотой анализа. */
function inputDifferences(previous, current) {
  const reasons = [];
  const changed = (key, code) => { if (canonical(previous?.state?.[key] ?? null) !== canonical(current?.state?.[key] ?? null)) reasons.push({ code }); };
  if (previous?.exists !== current?.exists) reasons.push({ code: "module_existence" });
  changed("directory", "module_path");
  changed("own_files", "own_code");
  changed("contract", "own_contract");
  changed("inherited", "inherited_constraints");
  changed("children", "child_composition");
  if (canonical(previous?.subtree ?? null) !== canonical(current?.subtree ?? null)) reasons.push({ code: "subtree_inputs" });
  if (canonical(previous?.dependencies ?? []) !== canonical(current?.dependencies ?? [])) reasons.push({ code: "dependency_input" });
  return reasons;
}

/**
 * Объединяет ограничения проверки, не меняя актуальность или вердикт.
 * Неполный перечень зависимостей не отменяет сравнение сохранённых входов,
 * но остаётся явным ограничением полноты даже у свежей содержательной оценки.
 */
function combineCoverage(values) {
  return {
    status: values.every((value) => value.status === "complete") ? "complete" :
      values.every((value) => value.status === "unavailable") ? "unavailable" : "partial",
    limitations: [...new Set(values.flatMap((value) => value.limitations))],
    reasons: [...new Map(values.flatMap((value) => value.reasons ?? [])
      .map((reason) => [canonical(reason), reason])).values()],
  };
}

/**
 * Сравнивает только проверяемые сохранённые входы. Неизвестная полнота списка
 * зависимостей относится к coverage; unknown остаётся для входов, которые
 * действительно невозможно сопоставить. Известное изменение сохраняет stale.
 */
function inputFreshness(previous, current) {
  const reasons = inputDifferences(previous, current);
  const unknown = [];
  const limitations = [];
  const coverageReasons = [];
  if (previous?.dependency_coverage?.status !== "complete") {
    coverageReasons.push({ code: "dependency_coverage_unknown",
      potential_influence: clone(previous?.dependency_coverage?.potential_influence ?? [{ scope: "project" }]) });
    limitations.push("Полнота зависимостей не подтверждена.");
  }
  if (previous?.dependencies.some((input) => !input.available) || current?.dependencies.some((input) => !input.available)) {
    unknown.push({ code: "dependency_unresolved" });
    limitations.push("Часть объявленных зависимостей недоступна для сравнения.");
  }
  if (!previous?.complete || !current?.complete) unknown.push({ code: "input_coverage_incomplete" });
  if (!previous?.complete || !current?.complete) limitations.push("Сохранённые или текущие входные данные неполны.");
  return { status: reasons.length ? "stale" : unknown.length ? "unknown" : "fresh", reasons: [...reasons, ...unknown],
    coverage: { status: limitations.length ? "partial" : "complete", limitations, reasons: [...coverageReasons, ...unknown] } };
}

/** Current зависит от проверенного состояния; change дополнительно от явной базы. */
export function reviewFreshness(entry, baseline, current) {
  if (!entry?.inputs || entry.schema_version !== REPORT_SCHEMA_VERSION || entry.inputs.schema_version !== 1) {
    const unavailable = { status: "unknown", reasons: [{ code: "legacy_manifest_missing" }],
      coverage: { status: "unavailable", limitations: ["Нет проверяемого описания входов прежнего анализа."] } };
    return { current: clone(unavailable), change: clone(unavailable) };
  }
  const selectors = (entry.inputs.current.dependencies ?? []).map((dependency) => dependency.selector);
  const options = { scope: entry.inputs.scope, dependencies: selectors,
    dependencyCoverage: entry.inputs.current.dependency_coverage, contractScope: entry.inputs.contract_scope ?? "effective" };
  const actual = createInputs(baseline, current, entry.module_id, options, isSemanticReview(entry));
  const own = inputFreshness(entry.inputs.current, actual.current);
  const change = inputFreshness(entry.inputs.current, actual.current);
  if (canonical(entry.inputs.baseline_identity) !== canonical(actual.baseline_identity)) {
    change.status = "stale"; change.reasons.push({ code: "baseline_identity" });
  }
  if (entry.inputs.baseline || actual.baseline) {
    const baselineStatus = inputFreshness(entry.inputs.baseline, actual.baseline);
    change.reasons.push(...baselineStatus.reasons.map((reason) => ({ ...reason, side: "baseline" })));
    change.coverage = combineCoverage([change.coverage, baselineStatus.coverage]);
    if (baselineStatus.status === "stale") change.status = "stale";
    else if (baselineStatus.status === "unknown" && change.status === "fresh") change.status = "unknown";
  }
  return { current: own, change };
}

/** Другая база/оценка изменения не создаёт ложный конфликт current-выводов. */
function assessmentResultDigest(report, side) {
  return digest({ assessment: report.assessment[side],
    observed: side === "current" ? report.observed.current : report.observed,
    checks: report.checks.filter((check) => side !== "current" ||
      (check.subject === "current" && check.contract.snapshot === "current")),
    findings: report.findings.filter((finding) => side !== "current" ||
      (finding.lifecycle !== "resolved" && finding.evidence.some((reference) => reference.snapshot === "current"))) });
}

/** Статус сохраняет все применимые попытки, включая несовпадающие выводы. */
function aggregateAssessment(candidates, side) {
  if (!candidates.length) return { status: "not_reviewed", reasons: [], verdict: null, review_ids: [], conflict: false,
    coverage: { status: "unavailable", limitations: ["Содержательная проверка отсутствует."] } };
  const fresh = candidates.filter((candidate) => candidate.freshness[side].status === "fresh");
  const applicable = fresh.length ? fresh : candidates.filter((candidate) => candidate.freshness[side].status === "unknown");
  const selected = applicable.length ? applicable : candidates;
  const resultKeys = new Set(applicable.map((candidate) => assessmentResultDigest(candidate.entry.report, side)));
  const conflict = resultKeys.size > 1;
  const verdicts = [...new Set(applicable.map((candidate) => candidate.entry.report.assessment[side].verdict))];
  const coverage = combineCoverage(selected.flatMap((candidate) =>
    [candidate.entry.report.analysis.coverage, candidate.freshness[side].coverage]));
  return { status: fresh.length ? "fresh" : applicable.length ? "unknown" : "stale",
    reasons: selected.flatMap((candidate) => candidate.freshness[side].reasons),
    verdict: conflict ? "inconclusive" : verdicts.length === 1 ? verdicts[0] : null,
    verdicts, review_ids: selected.map((candidate) => candidate.entry.review_id), conflict,
    coverage,
    current_violation: fresh.some((candidate) => candidate.entry.report.assessment[side].verdict === "violation") };
}

/** Широкая subtree-попытка не выдаётся за self-проверки всех узлов. */
export function aggregateReviewStatus(entries, baseline, current, id) {
  validateReviewRelations(entries);
  const resolved = new Set(entries.flatMap((entry) => entry.resolution?.review_ids ?? []));
  const candidates = entries.filter((entry) => !resolved.has(entry.review_id) && entry.module_id === id && entry.inputs?.scope === "self" && isSemanticReview(entry))
    .map((entry) => ({ entry, freshness: reviewFreshness(entry, baseline, current) }));
  const own = { current: aggregateAssessment(candidates, "current"), change: aggregateAssessment(candidates, "change") };
  return { ...own, conflict: own.current.conflict || own.change.conflict,
    coverage: { current: own.current.coverage, change: own.change.coverage } };
}

/** Объединяет полноту и актуальность вверх, не запускает LLM и не меняет вердикты. */
export function aggregateTreeStatuses(entries, baseline, current) {
  const states = buildModuleStates(current);
  const result = new Map();
  for (const state of buildModuleStates(baseline).values()) if (!states.has(state.module_id)) states.set(state.module_id, state);
  const visit = (id, visiting = new Set()) => {
    if (result.has(id)) return result.get(id);
    if (visiting.has(id)) throw new Error("Cyclic module tree");
    visiting.add(id);
    const state = states.get(id);
    const self = aggregateReviewStatus(entries, baseline, current, id);
    const broadCandidates = entries.filter((entry) => entry.module_id === id && entry.inputs?.scope === "subtree" && isSemanticReview(entry))
      .map((entry) => ({ entry, freshness: reviewFreshness(entry, baseline, current) }));
    const explicitSubtree = { current: aggregateAssessment(broadCandidates, "current"), change: aggregateAssessment(broadCandidates, "change") };
    const children = state.children.filter((child) => states.has(child)).map((child) => visit(child, visiting));
    const subtree = {};
    for (const side of ["current", "change"]) {
      const statuses = [self[side], ...children.map((child) => child.subtree[side])];
      const counts = { fresh: 0, stale: 0, unknown: 0, not_reviewed: 0 };
      for (const status of statuses) {
        if (status.counts) for (const [key, value] of Object.entries(status.counts)) counts[key] += value;
        else counts[status.status] += 1;
      }
      subtree[side] = { status: counts.stale ? "stale" : counts.unknown ? "unknown" : counts.not_reviewed ? "not_reviewed" : "fresh",
        counts, conflict: statuses.some((status) => status.conflict), current_violation: statuses.some((status) => status.current_violation),
        coverage: combineCoverage(statuses.map((status) => status.coverage)) };
    }
    const value = { self, subtree, explicit_subtree: explicitSubtree };
    visiting.delete(id); result.set(id, value); return value;
  };
  for (const id of states.keys()) visit(id);
  return result;
}
