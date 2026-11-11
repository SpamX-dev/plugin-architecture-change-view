import type { Contract } from "../src/contracts/types.js";
import type { Fact, Snapshot } from "../src/snapshots/types.js";
import type { ReviewOptions, ReviewEntry } from "../src/reports/types.js";
/**
 * Проверяет независимость self/subtree/current/change, переносимые доказательства
 * и отрицательные случаи native import. Фикстуры описывают входы явно: тесты не
 * пытаются доказывать содержательное соответствие искусственной эвристикой.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { stringify } from "yaml";
import { contractDocument } from "../src/contracts/document.js";
import { digest } from "../src/serialization/digest.js";
import { parseYaml } from "../src/serialization/yaml.js";
import { snapshotDigest } from "../src/snapshots/identity.js";
import { compareSnapshots } from "../src/snapshots/comparison.js";
import { createStructuralReview } from "../src/reviews/bundle.js";
import { aggregateReviewStatus } from "../src/reports/tree-status.js";
import { aggregateTreeStatuses, createTechnicalReport, reviewFreshness } from "../src/reports/model.js";
import { buildModuleStates } from "../src/reports/module-state.js";
import { createReviewEntry } from "../src/reports/review-entry.js";
import { createReviewInput } from "../src/reports/review-input.js";
import { validateReviewEntry } from "../src/reports/review-validation.js";
import { validateReviewRelations } from "../src/reports/review-identity.js";

/** Малое дерево содержит глубокого потомка и независимого поставщика API. */
interface Definition { id: string; directory: string; sources: Record<string,string>; contract: Contract; documentText?: string; documentState?: string }
function definition(): Definition[] {
  const modules: Omit<Definition, "contract">[] = [
    { id: "root", directory: ".", sources: { "settings.yaml": "mode: safe\n" } },
    { id: "parent", directory: "parent", sources: { "own.js": "export const own = 1;\n" } },
    { id: "child", directory: "parent/child", sources: { "child.js": "export const child = 1;\n" } },
    { id: "grand", directory: "parent/child/grand", sources: { "grand.js": "export const grand = 1;\n" } },
    { id: "provider", directory: "provider", sources: { "provider.js": "export const value = 1;\n", "api.d.ts": "export declare const value: number;\n" } },
  ];
  return modules.map((module) => ({ ...module, contract: { schema_version: 1, id: module.id,
    title: "Контракт " + module.id, kind: "module", purpose: "Читать проверяемые данные.",
    responsibilities: { R1: "Предоставлять чтение данных." },
    boundaries: { B1: "Не обращаться к сети." }, invariants: { I1: "Не изменять входные данные." } } }));
}

/** Снимок содержит настоящие хешируемые факты и разобранные контракты v1. */
function snapshot(definitions = definition(), extra: Partial<Snapshot> = {}): Snapshot {
  const facts: Fact[] = [];
  const modules = definitions.map((entry) => {
    const prefix = entry.directory === "." ? "" : entry.directory + "/";
    const documentPath = prefix + "arch.yaml";
    const text = entry.documentText ?? stringify(entry.contract);
    const files = Object.entries({ "arch.yaml": text, ...entry.sources }).map(([name, content]) => {
      const file = prefix + name;
      const fact = { kind: "file", path: file, start_line: 1, end_line: content.split("\n").length, text: content };
      facts.push({ id: digest(fact), ...fact });
      return { path: file, hash: digest(content) };
    });
    const document = contractDocument(text);
    if (entry.documentState) document.state = entry.documentState;
    const fact = { kind: "module", path: entry.directory, text: JSON.stringify({ contract: document.state }) };
    facts.push({ id: digest(fact), ...fact });
    return { directory: entry.directory, documentPath, document, files, sourceFiles: Object.keys(entry.sources).length, fingerprint: digest(files) };
  });
  const result: Snapshot = { id: "", digest: "", fingerprint: "", label: "", schema_version: 2, root: "C:/fixture", kind: "working", complete: true,
    diagnostics: [], evidenceLimitations: [], modules, facts, capturedAt: "2026-11-09T00:00:00Z", ...extra };
  result.digest = snapshotDigest(result);
  result.id ||= "working-" + result.digest.slice(7);
  return result;
}

/** Заполняет native шаблон явной тестовой моделью и проверками каждого пункта. */
function reviewed(baseline: Snapshot | null, current: Snapshot, id: string, options: ReviewOptions & { draft?: boolean } = {}) {
  const draft = createReviewInput("project-one", baseline, current, id, {
    dependencies: [], dependencyCoverage: { status: "complete", potential_influence: [] }, ...options });
  draft.report.analysis.model = { provider: "test", id: "fixture" };
  draft.report.analysis.prompt_digest = digest("fixture instructions");
  draft.manifest.model = draft.report.analysis.model;
  draft.manifest.prompt_digest = draft.report.analysis.prompt_digest;
  draft.report.analysis.input_digest = digest(draft.manifest);
  draft.report.analysis.coverage = { status: "complete", limitations: [] };
  for (const check of draft.report.checks) {
    const fact = draft[check.subject]!.facts.find((item) => item.kind === "file");
    check.verdict = "consistent";
    check.explanation = "Фикстура проверена.";
    check.evidence = [{ snapshot: check.subject, fact_id: fact!.id }];
  }
  draft.report.assessment.current = { verdict: draft.report.module.current_path === null ? "not_applicable" : "consistent", summary: "Фикстура current." };
  draft.report.assessment.change = { verdict: baseline ? "consistent" : "not_applicable", summary: "Фикстура change." };
  return options.draft ? draft : createReviewEntry(draft);
}

/** Технический отчёт одного идентифицированного модуля. */
const technical = (before: Snapshot | null, after: Snapshot, id: string) => createTechnicalReport("project-one", before, after, { moduleId: id });

test("check_hash ignores root/time and YAML formatting, normalizes only line endings", () => {
  const definitions = definition();
  const first = snapshot(definitions);
  const moved = structuredClone(first);
  moved.root = "D:/clone"; moved.capturedAt = "2026-11-10T00:00:00Z";
  moved.id = "another-current-run";
  assert.equal(technical(null, first, "parent").check_hash, technical(null, moved, "parent").check_hash);
  definitions[1].documentText = "# Formatting only\n" + stringify(Object.fromEntries(Object.entries(definitions[1].contract).reverse()));
  definitions[1].sources["own.js"] = "export const own = 1;\r\n";
  const formatted = snapshot(definitions);
  assert.equal(technical(null, first, "parent").check_hash, technical(null, formatted, "parent").check_hash);
  definitions[1].sources["own.js"] = "export const own = 1; \n";
  assert.notEqual(technical(null, first, "parent").check_hash, technical(null, snapshot(definitions), "parent").check_hash);
});

test("descendant implementation changes parent technical hash and leaves own review fresh", () => {
  const definitions = definition();
  const before = snapshot(definitions);
  const parent = reviewed(null, before, "parent");
  const child = reviewed(null, before, "child");
  definitions[2].sources["child.js"] = "export const child = 2;\n";
  const after = snapshot(definitions);
  assert.notEqual(technical(null, before, "parent").check_hash, technical(null, after, "parent").check_hash);
  const change = technical(before, after, "parent").change;
  assert.equal(change.own, false); assert.equal(change.descendants, true);
  assert.equal(reviewFreshness(parent, null, after).current.status, "fresh");
  assert.equal(reviewFreshness(child, null, after).current.status, "stale");
  const tree = aggregateTreeStatuses([parent, child], null, after);
  assert.equal(tree.get("parent")!.self.current.status, "fresh");
  assert.equal(tree.get("parent")!.subtree.current.status, "stale");
  assert.equal(tree.get("parent")!.subtree.current.counts!.not_reviewed, 1);
});

test("direct child contract invalidates composition but a deep child contract does not invalidate all ancestors", () => {
  const definitions = definition();
  const before = snapshot(definitions);
  const parent = reviewed(null, before, "parent");
  definitions[3].contract.responsibilities.R2 = "Публиковать состояние.";
  assert.equal(reviewFreshness(parent, null, snapshot(definitions)).current.status, "fresh");
  definitions[2].contract.responsibilities.R2 = "Объединять данные подмодулей.";
  const freshness = reviewFreshness(parent, null, snapshot(definitions)).current;
  assert.equal(freshness.status, "stale");
  assert.ok(freshness.reasons.some((reason) => reason.code === "child_composition"));
});

test("parent context invalidates the parent's own review without invalidating child review", () => {
  const definitions = definition();
  const before = snapshot(definitions);
  const child = reviewed(null, before, "child");
  const root = reviewed(null, before, "root");
  definitions[0].contract.responsibilities.R2 = "Объединять независимые модули.";
  assert.equal(reviewFreshness(child, null, snapshot(definitions)).current.status, "fresh");
  definitions[0].contract.invariants.I2 = "Всегда проверять идентичность.";
  const after = snapshot(definitions);
  assert.equal(reviewFreshness(child, null, after).current.status, "fresh");
  assert.equal(reviewFreshness(root, null, after).current.status, "stale");
  assert.ok(reviewFreshness(root, null, after).current.reasons.some((reason) => reason.code === "own_contract"));
  assert.notEqual(technical(null, before, "child").check_hash, technical(null, after, "child").check_hash);
});

test("new export contains only own clauses and avoids rechecking unchanged baseline clauses", () => {
  const current = snapshot();
  const input = createReviewInput("project-one", current, current, "child");
  assert.equal(input.manifest.contract_scope, "own");
  assert.equal(input.inputs.contract_scope, "own");
  assert.equal(Object.hasOwn(input.inputs.current.state!, "inherited"), false);
  assert.equal(input.manifest.contracts.current.length, 3);
  assert.ok(input.manifest.contracts.current.every((item) => item.reference.module_id === "child"));
  assert.equal(input.report.checks.length, 6);
  assert.equal(input.report.checks.filter((check) => check.subject === "current").length, 3);
  assert.ok(input.current.modules.some((module) => module.document.contract?.id === "root"));
});

test("legacy effective reviews retain their original scope and validate alongside own reviews", () => {
  const definitions = definition();
  const current = snapshot(definitions);
  const old = reviewed(null, current, "child", { contractScope: "effective" });
  const own = reviewed(null, current, "child");
  assert.equal(old.manifest.contract_scope, undefined);
  assert.equal(old.inputs.contract_scope, undefined);
  assert.ok(old.report.checks.some((check) => check.contract.module_id === "root"));
  const preserved = digest(old);
  assert.equal(validateReviewEntry(parseYaml(stringify(old, { aliasDuplicateObjects: false }), (value) => value as ReviewEntry)).review_id, old.review_id);
  definitions[0].contract.invariants.I2 = "Новый контекст размещения.";
  const after = snapshot(definitions);
  assert.equal(reviewFreshness(old, null, after).current.status, "stale");
  assert.equal(reviewFreshness(own, null, after).current.status, "fresh");
  assert.equal(digest(old), preserved);
});

test("changed own baseline clauses still require an explicit check of current code", () => {
  const definitions = definition();
  const baseline = snapshot(definitions);
  definitions[2].contract.responsibilities.R1 = "Возвращать только локальные данные.";
  const draft = reviewed(baseline, snapshot(definitions), "child", { draft: true });
  const oldRequirements = draft.report.checks.filter((check) => check.subject === "current" && check.contract.snapshot === "baseline");
  assert.equal(oldRequirements.length, 1);
  assert.equal(oldRequirements[0].contract.id, "R1");
  draft.report.checks = draft.report.checks.filter((check) => check.id !== oldRequirements[0].id);
  assert.throws(() => createReviewEntry(draft), /Missing explicit clause check/);
});

test("own review cannot add a parent clause or change its scope under preserved inputs", () => {
  const current = snapshot();
  const draft = reviewed(null, current, "child", { draft: true });
  const foreign = structuredClone(draft);
  foreign.report.checks.push({ ...structuredClone(foreign.report.checks[0]), id: "foreign-parent",
    contract: { snapshot: "current", module_id: "root", section: "invariants", id: "I1" } });
  assert.throws(() => createReviewEntry(foreign), /Own review checks/);
  const altered = structuredClone(draft);
  delete altered.inputs.contract_scope;
  assert.throws(() => createReviewEntry(altered), /contract scope mismatch/);
});

test("parent placement violation remains at the parent and does not become child violation", () => {
  const current = snapshot();
  const parentDraft = reviewed(null, current, "parent", { draft: true });
  parentDraft.report.assessment.current = { verdict: "violation", summary: "Композиция не соответствует назначению родителя." };
  parentDraft.report.checks[0].verdict = "violation";
  const child = reviewed(null, current, "child");
  const tree = aggregateTreeStatuses([createReviewEntry(parentDraft), child], null, current);
  assert.equal(tree.get("parent")!.self.current.verdict, "violation");
  assert.equal(tree.get("child")!.self.current.verdict, "consistent");
  assert.equal(tree.get("child")!.self.current.current_violation, false);
});

test("module dependency follows its own inputs rather than its parent's context", () => {
  const definitions = definition();
  const current = snapshot(definitions);
  const consumer = reviewed(null, current, "child", { dependencies: [{ kind: "module", module_id: "provider" }] });
  definitions[0].contract.boundaries.B2 = "Другой контекст для размещения модулей.";
  assert.equal(reviewFreshness(consumer, null, snapshot(definitions)).current.status, "fresh");
  definitions[4].sources["provider.js"] = "export const value = 2;\n";
  assert.equal(reviewFreshness(consumer, null, snapshot(definitions)).current.status, "stale");
});

test("title metadata is technical change without invalidating semantic own/composition", () => {
  const definitions = definition();
  const before = snapshot(definitions);
  const own = reviewed(null, before, "child");
  const parent = reviewed(null, before, "parent");
  definitions[2].contract.title = "Другое имя";
  const after = snapshot(definitions);
  assert.equal(reviewFreshness(own, null, after).current.status, "fresh");
  assert.equal(reviewFreshness(parent, null, after).current.status, "fresh");
  assert.equal(technical(before, after, "child").change.own_contract, true);
});

test("contract, actual API file and implementation dependencies have distinct scopes", () => {
  const definitions = definition();
  const before = snapshot(definitions);
  const contract = reviewed(null, before, "child", { dependencies: [{ kind: "contract", module_id: "provider" }] });
  const api = reviewed(null, before, "child", { dependencies: [{ kind: "api", path: "provider/api.d.ts" }] });
  const implementation = reviewed(null, before, "child", { dependencies: [{ kind: "module", module_id: "provider" }] });
  definitions[4].sources["provider.js"] = "export const value = 2;\n";
  let after = snapshot(definitions);
  assert.equal(reviewFreshness(contract, null, after).current.status, "fresh");
  assert.equal(reviewFreshness(api, null, after).current.status, "fresh");
  assert.equal(reviewFreshness(implementation, null, after).current.status, "stale");
  definitions[4].sources["api.d.ts"] = "export declare const value: string;\n";
  after = snapshot(definitions);
  assert.equal(reviewFreshness(api, null, after).current.status, "stale");
  assert.equal(reviewFreshness(contract, null, after).current.status, "fresh");
});

test("legacy semantic bundle keeps every proof and defaults unknown dependency coverage", () => {
  const current = snapshot();
  const comparison = compareSnapshots(null, current).modules.find((module) => module.moduleId === "child");
  const bundle = createStructuralReview(null, current, comparison!);
  bundle.report.analysis.analyzer = { ...bundle.report.analysis.analyzer, name: "old-agent" };
  bundle.manifest.analyzer = bundle.report.analysis.analyzer;
  bundle.report.analysis.input_digest = digest(bundle.manifest);
  const entry = createReviewEntry(bundle, { projectId: "project-one" });
  assert.equal(entry.format, "legacy-v1");
  assert.deepEqual(entry.current, current);
  assert.equal(reviewFreshness(entry, null, current).current.status, "fresh");
  assert.equal(reviewFreshness(entry, null, current).current.coverage.status, "partial");
  assert.equal(entry.inputs.current.dependency_coverage.status, "unknown");
  const structure = createReviewEntry(createStructuralReview(null, current, comparison!));
  assert.equal(aggregateReviewStatus([structure], null, current, "child").current.status, "not_reviewed");
});

test("legacy effective checks must refer to a clause selected by the manifest", () => {
  const current = snapshot();
  const comparison = compareSnapshots(null, current).modules.find((module) => module.moduleId === "child")!;
  const bundle = createStructuralReview(null, current, comparison, { contractScope: "effective" });
  assert.ok(bundle.report.checks.some((check) => check.contract.module_id === "parent"));
  assert.doesNotThrow(() => createReviewEntry(bundle));
  const extra = structuredClone(bundle.report.checks.find((check) => check.contract.module_id === "child")!);
  extra.id = "extra-check";
  extra.contract.module_id = "provider";
  bundle.report.checks.push(extra);
  assert.throws(() => createReviewEntry(bundle), /clause outside the manifest/);
});

test("unknown dependency coverage is separate from matching and changed checked inputs", () => {
  const definitions = definition();
  const current = snapshot(definitions);
  const draft = reviewed(null, current, "child", { draft: true,
    dependencies: [{ kind: "module", module_id: "provider" }],
    dependencyCoverage: { status: "unknown", potential_influence: [{ scope: "project" }] } });
  draft.report.analysis.coverage = { status: "partial", limitations: ["Перечень зависимостей не подтверждён."] };
  const entry = createReviewEntry(draft);
  const savedDigest = digest(entry);
  const matching = reviewFreshness(entry, null, current);
  assert.equal(matching.current.status, "fresh");
  assert.equal(matching.change.status, "fresh");
  assert.deepEqual(matching.current.reasons, []);
  assert.equal(matching.current.coverage.status, "partial");
  assert.ok(matching.current.coverage.reasons!.some((reason) => reason.code === "dependency_coverage_unknown"));
  // Необъявленная область не была проверенным входом: ограничение остаётся в полноте.
  definitions[0].sources["settings.yaml"] = "mode: other\n";
  assert.equal(reviewFreshness(entry, null, snapshot(definitions)).current.status, "fresh");
  // Изменение объявленной реализации по-прежнему инвалидирует сохранённый вывод.
  definitions[4].sources["provider.js"] = "export const value = 2;\n";
  const changed = reviewFreshness(entry, null, snapshot(definitions)).current;
  assert.equal(changed.status, "stale");
  assert.equal(changed.coverage.status, "partial");
  assert.ok(changed.reasons.some((reason) => reason.code === "dependency_input"));
  assert.equal(digest(entry), savedDigest);
});

test("partial coverage propagates separately from fresh inputs and confirmed violations", () => {
  const current = snapshot();
  const entries = definition().map(({ id }) => {
    const draft = reviewed(null, current, id, { draft: true,
      dependencyCoverage: { status: "unknown", potential_influence: [{ scope: "project" }] } });
    draft.report.analysis.coverage = { status: "partial", limitations: ["Частичная проверка фикстуры."] };
    if (id === "child") {
      draft.report.assessment.current = { verdict: "violation", summary: "Нарушение в тестовой фикстуре." };
      draft.report.checks[0].verdict = "violation";
    }
    return createReviewEntry(draft);
  });
  const tree = aggregateTreeStatuses(entries, null, current);
  const root = tree.get("root")!.subtree.current;
  assert.equal(root.status, "fresh");
  assert.deepEqual(root.counts, { fresh: 5, stale: 0, unknown: 0, not_reviewed: 0 });
  assert.equal(root.coverage.status, "partial");
  assert.ok(root.coverage.reasons!.some((reason) => reason.code === "dependency_coverage_unknown"));
  assert.equal(root.current_violation, true);
});

test("unavailable declared dependencies and incomplete snapshots remain incomparable", () => {
  const current = snapshot();
  const draft = reviewed(null, current, "child", { draft: true,
    dependencies: [{ kind: "file", path: "absent/api.d.ts" }] });
  draft.report.analysis.coverage = { status: "partial", limitations: ["Вход зависимости недоступен."] };
  const unavailable = reviewFreshness(createReviewEntry(draft), null, current).current;
  assert.equal(unavailable.status, "unknown");
  assert.equal(unavailable.coverage.status, "partial");
  assert.ok(unavailable.reasons.some((reason) => reason.code === "dependency_unresolved"));
  const complete = reviewed(null, current, "child");
  const incomplete = reviewFreshness(complete, null, snapshot(definition(), { complete: false })).current;
  assert.equal(incomplete.status, "unknown");
  assert.ok(incomplete.reasons.some((reason) => reason.code === "input_coverage_incomplete"));
});

test("baseline changes invalidate change alone even when current own inputs match", () => {
  const baseline = snapshot(definition(), { id: "frozen-baseline-a" });
  const current = snapshot();
  const entry = reviewed(baseline, current, "child");
  const otherBaseline = snapshot(definition(), { id: "frozen-baseline-b" });
  const freshness = reviewFreshness(entry, otherBaseline, current);
  assert.equal(freshness.current.status, "fresh");
  assert.equal(freshness.change.status, "stale");
  assert.ok(freshness.change.reasons.some((reason) => reason.code === "baseline_identity"));
});

test("native export is self contained and excludes unrelated and descendant implementation", () => {
  const current = snapshot();
  const entry = reviewed(null, current, "parent");
  assert.equal("root" in entry.current ? entry.current.root : undefined, undefined);
  assert.ok(entry.current.facts.some((fact) => fact.path === "parent/own.js"));
  assert.ok(entry.current.facts.some((fact) => fact.path === "parent/child/arch.yaml"));
  assert.ok(!entry.current.facts.some((fact) => fact.path === "parent/child/child.js"));
  assert.ok(!entry.current.modules.some((module) => module.directory === "provider"));
  const loaded = parseYaml(stringify(entry, { aliasDuplicateObjects: false }), (value) => validateReviewEntry(value as ReviewEntry));
  assert.equal(reviewFreshness(loaded, null, current).current.status, "fresh");
});

test("implementation dependency keeps required child contracts and whole subtree evidence", () => {
  const current = snapshot();
  const entry = reviewed(null, current, "provider", { dependencies: [{ kind: "module", module_id: "parent", scope: "subtree" }] });
  assert.ok(entry.current.modules.some((module) => module.directory === "parent/child/grand"));
  assert.ok(entry.current.facts.some((fact) => fact.path === "parent/child/grand/grand.js"));
  assert.equal(validateReviewEntry(entry), entry);
  const narrow = reviewed(null, current, "provider", { dependencies: [{ kind: "module", module_id: "parent" }] });
  assert.ok(narrow.current.modules.some((module) => module.directory === "parent/child"));
  assert.ok(!narrow.current.facts.some((fact) => fact.path === "parent/child/child.js"));
});

test("native import rejects changed input manifests with old proof even after outer hashes are recomputed", () => {
  const current = snapshot();
  const draft = reviewed(null, current, "child", { draft: true });
  draft.inputs.current.state!.own_files[0].digest = digest("unreviewed replacement");
  draft.inputs.current_digest = digest(draft.inputs.current);
  draft.inputs.change_digest = digest({ baseline_identity: draft.inputs.baseline_identity, baseline: draft.inputs.baseline, current: draft.inputs.current });
  assert.throws(() => createReviewEntry(draft), /disagree with saved snapshot/);
});

test("native technical manifest binds hash, project and own state and rejects unknown snapshot schemas", () => {
  const current = snapshot();
  const changedHash = reviewed(null, current, "child", { draft: true });
  changedHash.check_hash = "0".repeat(64);
  assert.throws(() => createReviewEntry(changedHash), /technical check manifest mismatch/);
  const foreign = reviewed(null, current, "child", { draft: true });
  foreign.project_id = "foreign-project";
  assert.throws(() => createReviewEntry(foreign), /technical check manifest mismatch/);
  const falseState = reviewed(null, current, "child", { draft: true });
  falseState.check_manifest!.current.self_digest = digest("unrelated technical state");
  falseState.check_hash = digest(falseState.check_manifest).slice(7);
  assert.throws(() => createReviewEntry(falseState), /technical own-state mismatch/);
  const schema = reviewed(null, current, "child", { draft: true });
  schema.current.schema_version = 999;
  const { scope_digest, ...content } = schema.current;
  schema.current.scope_digest = digest(content);
  assert.throws(() => createReviewEntry(schema), /Scoped snapshot digest mismatch/);
});

test("native import rejects missing required checks, false complete coverage and manifest mismatches", () => {
  const current = snapshot();
  const renamed = reviewed(null, current, "child", { draft: true });
  renamed.report.id = "another-attempt";
  assert.throws(() => createReviewEntry(renamed), /review entry identity/);
  const missing = reviewed(null, current, "child", { draft: true });
  missing.report.checks.pop();
  assert.throws(() => createReviewEntry(missing), /Missing explicit clause check/);
  const incomplete = reviewed(null, current, "child", { draft: true });
  incomplete.report.checks[0].verdict = "not_checked";
  assert.throws(() => createReviewEntry(incomplete), /Complete native review/);
  const mismatch = reviewed(null, current, "child", { draft: true });
  mismatch.manifest.module.current_path = "provider";
  mismatch.report.analysis.input_digest = digest(mismatch.manifest);
  assert.throws(() => createReviewEntry(mismatch), /manifest mismatch/);
  const unknown = reviewed(null, current, "child", { draft: true,
    dependencyCoverage: { status: "unknown", potential_influence: [{ scope: "project" }] } });
  assert.throws(() => createReviewEntry(unknown), /Complete native review/);
});

test("native snapshot parsed contract must agree with preserved YAML text", () => {
  const current = snapshot();
  const draft = reviewed(null, current, "child", { draft: true });
  const saved = draft.current.modules.find((module) => module.directory === "parent/child");
  saved!.document.contract!.purpose = "Поддельный разобранный контракт.";
  const { scope_digest, ...content } = draft.current;
  draft.current.scope_digest = digest(content);
  assert.throws(() => createReviewEntry(draft), /contract text disagrees/);
});

test("conflicting applicable reviews remain visible and explicit resolution preserves history", () => {
  const current = snapshot();
  const good = reviewed(null, current, "child");
  const badDraft = reviewed(null, current, "child", { draft: true });
  badDraft.report.assessment.current = { verdict: "violation", summary: "Другое заключение." };
  const bad = createReviewEntry(badDraft);
  const conflicted = aggregateReviewStatus([good, bad], null, current, "child");
  assert.equal(conflicted.current.conflict, true);
  assert.equal(conflicted.current.verdict, "inconclusive");
  assert.equal(conflicted.current.current_violation, true);
  const resolutionDraft = reviewed(null, current, "child", { draft: true });
  resolutionDraft.resolution = { review_ids: [good.review_id, bad.review_id], reason: "Явно разобраны оба прежних заключения." };
  const resolution = createReviewEntry(resolutionDraft);
  validateReviewRelations([good, bad, resolution]);
  const resolved = aggregateReviewStatus([good, bad, resolution], null, current, "child");
  assert.equal(resolved.current.conflict, false);
  assert.deepEqual(resolved.current.review_ids, [resolution.review_id]);
  assert.throws(() => validateReviewRelations([resolution]), /Unresolved review resolution/);
});

test("resolution cannot target another module or another set of checked inputs", () => {
  const current = snapshot();
  const original = reviewed(null, current, "child");
  const draft = reviewed(null, current, "provider", { draft: true });
  draft.resolution = { review_ids: [original.review_id], reason: "Неверная область." };
  const wrong = createReviewEntry(draft);
  assert.throws(() => validateReviewRelations([original, wrong]), /scope\/input mismatch/);
});

test("current aggregation does not conflict because only another-side result changed", () => {
  const current = snapshot();
  const baseline = snapshot(definition(), { id: "baseline" });
  const first = reviewed(baseline, current, "child");
  const secondDraft = reviewed(baseline, current, "child", { draft: true });
  secondDraft.report.assessment.change = { verdict: "violation", summary: "Разногласие об изменении." };
  const second = createReviewEntry(secondDraft);
  const aggregate = aggregateReviewStatus([first, second], baseline, current, "child");
  assert.equal(aggregate.current.conflict, false);
  assert.equal(aggregate.change.conflict, true);
});

test("historical finding lifecycle and proofs do not conflict with the same current finding", () => {
  const current = snapshot();
  const baseline = snapshot(definition(), { id: "baseline" });
  const makeAttempt = (persisting: boolean) => {
    const draft = reviewed(baseline, current, "child", { draft: true });
    const check = draft.report.checks.find((item) => item.subject === "current" && item.contract.snapshot === "current")!;
    check.verdict = "violation";
    const finding = { id: "finding", kind: "responsibility_gap", certainty: "confirmed", severity: "warning",
      lifecycle: persisting ? "persisting" : "introduced", summary: "Обязанность не выполнена.",
      clauses: [check.contract], evidence: [...check.evidence] };
    if (persisting) {
      const prior = draft.report.checks.find((item) => item.subject === "baseline")!;
      finding.clauses.push(prior.contract);
      finding.evidence.push(...prior.evidence);
      check.evidence.push(...prior.evidence);
    }
    draft.report.findings = [finding];
    draft.report.assessment.current = { verdict: "violation", summary: finding.summary };
    return createReviewEntry(draft);
  };
  const status = aggregateReviewStatus([makeAttempt(false), makeAttempt(true)], baseline, current, "child");
  assert.equal(status.current.conflict, false);
  assert.equal(status.current.verdict, "violation");
  assert.equal(status.change.conflict, true);
});

test("stale violation remains historical without claiming a present violation or resolution", () => {
  const definitions = definition();
  const before = snapshot(definitions);
  const draft = reviewed(null, before, "child", { draft: true });
  draft.report.assessment.current = { verdict: "violation", summary: "Старая ошибка." };
  const entry = createReviewEntry(draft);
  definitions[2].sources["child.js"] = "export const child = 9;\n";
  const status = aggregateReviewStatus([entry], null, snapshot(definitions), "child").current;
  assert.equal(status.status, "stale");
  assert.equal(status.current_violation, false);
  assert.equal(status.verdict, null);
});

test("duplicate contract ids remain reportable through directory identities", () => {
  const definitions = definition();
  definitions[2].contract.id = "parent";
  definitions[1].documentState = "invalid";
  definitions[2].documentState = "invalid";
  const current = snapshot(definitions);
  const states = buildModuleStates(current);
  assert.ok(states.has("directory:parent"));
  assert.ok(states.has("directory:parent/child"));
  assert.equal(states.get("directory:parent")!.complete, false);
  assert.equal(createTechnicalReport("project-one", null, current,
    { moduleId: null, directory: "parent", after: current.modules[1] }).structure.document_state, "invalid");
});

test("explicit subtree verdict is separate from individual self coverage", () => {
  const current = snapshot();
  const broad = reviewed(null, current, "parent", { scope: "subtree" });
  const tree = aggregateTreeStatuses([broad], null, current);
  assert.equal(tree.get("parent")!.self.current.status, "not_reviewed");
  assert.equal(tree.get("parent")!.subtree.current.status, "not_reviewed");
  assert.equal(tree.get("parent")!.explicit_subtree.current.status, "fresh");
});

test("a resolved subtree review remains in history and drops out of the explicit subtree assessment", () => {
  const current = snapshot();
  const previous = reviewed(null, current, "parent", { scope: "subtree", draft: true });
  previous.report.assessment.current = { verdict: "violation", summary: "Прежний вывод." };
  const oldReview = createReviewEntry(previous);
  const next = reviewed(null, current, "parent", { scope: "subtree", draft: true });
  next.resolution = { review_ids: [oldReview.review_id], reason: "Проверено повторно." };
  const replacement = createReviewEntry(next);
  const history = [oldReview, replacement];
  const status = aggregateTreeStatuses(history, null, current).get("parent")!;
  assert.equal(status.explicit_subtree.current.conflict, false);
  assert.deepEqual(status.explicit_subtree.current.review_ids, [replacement.review_id]);
  assert.equal(status.self.current.status, "not_reviewed");
  assert.deepEqual(history.map((entry) => entry.review_id), [oldReview.review_id, replacement.review_id]);
});
