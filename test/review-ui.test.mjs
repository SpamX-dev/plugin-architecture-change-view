/** Проверяет состав видимого локального чеклиста без изменения сохранённого отчёта. */
import assert from "node:assert/strict";
import test from "node:test";
import { ownClauseGroups, reviewVersions, observedVersionGroups, contractChanges, contractHeadingChange, evidenceLabel,
  reviewFindingItems, freshnessLabel, clauseFindingTargets } from "../web/archiview/review.mjs";

/** Фикстура старого отчёта содержит локальные, родительские и исторические проверки. */
function historicalReview() {
  const checks = [];
  for (const [snapshot, subject] of [["baseline", "baseline"], ["current", "current"], ["baseline", "current"]]) {
    for (const module_id of ["parent", "child"]) checks.push({ id: "check-" + checks.length,
      contract: { snapshot, module_id, section: "responsibilities", id: "R1" },
      subject, verdict: "consistent", explanation: module_id + ": " + snapshot, evidence: [] });
  }
  return { report: { module: { id: "child", baseline_path: "child", current_path: "child" }, checks } };
}

test("current view shows own clauses once and keeps the original historical checks intact", () => {
  const bundle = historicalReview();
  const preserved = structuredClone(bundle);
  const groups = ownClauseGroups(bundle);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].length, 1);
  assert.equal(groups[0][0].contract.module_id, "child");
  assert.equal(groups[0][0].contract.snapshot, "current");
  assert.equal(groups[0][0].subject, "current");
  assert.deepEqual(bundle, preserved);
});

test("removed module shows its own baseline clauses rather than the parent", () => {
  const bundle = historicalReview();
  bundle.report.module.current_path = null;
  const groups = ownClauseGroups(bundle);
  assert.equal(groups.length, 1);
  assert.equal(groups[0][0].subject, "baseline");
  assert.equal(groups[0][0].contract.module_id, "child");
});

test("grouping one own clause preserves contradictory checks and separates sections", () => {
  const bundle = historicalReview();
  const current = bundle.report.checks.find((check) => check.subject === "current" &&
    check.contract.snapshot === "current" && check.contract.module_id === "child");
  bundle.report.checks.push({ ...structuredClone(current), id: "contradiction", verdict: "violation" },
    { ...structuredClone(current), id: "another-section", contract: { ...current.contract, section: "invariants" } });
  const groups = ownClauseGroups(bundle);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].map((check) => check.verdict), ["consistent", "violation"]);
});

/** Историческая проверка одной версии воспроизводит лишние строки реального отчёта. */
function observedReview() {
  const version = { id: "launch-0123456789abcdef", digest: "sha256:same" };
  const observed = (snapshot) => ({ summary: "Возвращает данные.", responsibilities: [
    { text: "Возвращает данные.", evidence: [{ snapshot, fact_id: "fact-one" }] },
  ] });
  return { report: {
    module: { id: "child", baseline_path: "child", current_path: "child" },
    comparison: { baseline: structuredClone(version), current: structuredClone(version) },
    assessment: { current: { verdict: "violation" }, change: { verdict: "consistent" } },
    observed: { baseline: observed("baseline"), current: observed("current") },
  } };
}

test("one checked version does not present a second positive verdict as a comparison", () => {
  const bundle = observedReview();
  const original = structuredClone(bundle);
  assert.equal(reviewVersions(bundle).same, true);
  assert.equal(reviewVersions(bundle).showChange, false);
  assert.equal(reviewVersions(bundle).current, "При первом открытии проекта · 0123456789ab");
  assert.deepEqual(bundle, original);
  bundle.report.assessment.change.verdict = "violation";
  assert.equal(reviewVersions(bundle).showChange, true, "contradictory historical verdict remains visible");
  bundle.report.comparison.baseline = null;
  assert.equal(reviewVersions(bundle).showChange, false, "initial analysis has no comparison");
});

test("different saved versions have explicit comparison identities", () => {
  const bundle = observedReview();
  bundle.report.comparison.baseline = { id: "git-abcdef0123456789", digest: "sha256:before" };
  const versions = reviewVersions(bundle);
  assert.equal(versions.same, false);
  assert.equal(versions.showChange, true);
  assert.equal(versions.baseline, "Коммит · abcdef012345");
  assert.notEqual(versions.baseline, versions.current);
});

test("duplicate observed summary and responsibilities appear once without losing evidence", () => {
  const bundle = observedReview();
  bundle.report.observed.current.responsibilities.push({ text: "Возвращает  данные.", evidence: [
    { snapshot: "current", fact_id: "fact-one" }, { snapshot: "current", fact_id: "fact-two" },
  ] });
  const original = structuredClone(bundle);
  const groups = observedVersionGroups(bundle);
  assert.equal(groups.primary.summary, null);
  assert.equal(groups.primary.responsibilities.length, 1);
  assert.deepEqual(groups.primary.responsibilities[0].evidence.map((ref) => ref.fact_id), ["fact-one", "fact-two"]);
  assert.equal(groups.previous.responsibilities[0].evidence[0].fact_id, "fact-one");
  assert.deepEqual(bundle, original);
});

test("matching observations merge across versions while changed text or proof remains available", () => {
  const bundle = observedReview();
  assert.equal(observedVersionGroups(bundle).previous, null);
  bundle.report.observed.baseline.summary = "Другое наблюдение по той же версии.";
  assert.equal(observedVersionGroups(bundle).previous.summary, "Другое наблюдение по той же версии.");
  bundle.report.observed.baseline.summary = bundle.report.observed.current.summary;
  bundle.report.comparison.baseline.id = "git-previous";
  assert.equal(observedVersionGroups(bundle).previous, null);
  bundle.report.observed.baseline.responsibilities[0].evidence[0].fact_id = "previous-fact";
  assert.equal(observedVersionGroups(bundle).previous.responsibilities[0].evidence[0].fact_id, "previous-fact");
  bundle.report.observed.baseline.summary = "Прежняя ответственность.";
  assert.equal(observedVersionGroups(bundle).previous.summary, "Прежняя ответственность.");
  bundle.report.module.current_path = null;
  const removed = observedVersionGroups(bundle);
  assert.equal(removed.side, "baseline");
  assert.equal(removed.primary.summary, "Прежняя ответственность.");
  assert.equal(removed.previous, null);
});

test("contract fields distinguish new, removed and changed clauses while preserving both versions", () => {
  const before = { title: "Модуль", responsibilities: { R1: "Было.", R2: "Удалено." }, boundaries: {}, invariants: {} };
  const after = { ...before, purpose: "Новое назначение.", responsibilities: { R1: "Стало.", R3: "Добавлено." } };
  const original = structuredClone({ before, after });
  const changes = new Map(contractChanges(before, after).map((item) => [item.key, item]));
  assert.equal(changes.get("title").status, "unchanged");
  assert.equal(changes.get("purpose").status, "added");
  assert.deepEqual(changes.get("responsibilities.R1"), {
    key: "responsibilities.R1", before: "Было.", after: "Стало.", status: "modified" });
  assert.equal(changes.get("responsibilities.R2").status, "removed");
  assert.equal(changes.get("responsibilities.R3").status, "added");
  assert.deepEqual({ before, after }, original);
});

test("heading uses the strictest field change and retains both versions in one diff", () => {
  const before = { title: "Прежнее название", kind: "module", id: "one", responsibilities: { R1: "Прежний пункт" } };
  const after = { ...before, title: "Новое название", purpose: "Добавленное назначение", responsibilities: {} };
  const original = structuredClone({ before, after });
  const change = contractHeadingChange(before, after);
  assert.equal(change.status, "modified", "a removed clause outside the heading does not affect its status");
  assert.deepEqual(change.before, { title: "Прежнее название", kind: "module", id: "one" });
  assert.deepEqual(change.after, { title: "Новое название", kind: "module", id: "one", purpose: "Добавленное назначение" });
  assert.equal(contractHeadingChange(after, before).status, "removed", "a removed heading field outranks a changed title");
  assert.equal(contractHeadingChange(null, after).status, "added");
  assert.equal(contractHeadingChange(after, null).status, "removed");
  assert.equal(contractHeadingChange(null, after, false).status, "unchanged", "initial comparison has no invented additions");
  assert.equal(contractHeadingChange(before, { ...before, responsibilities: {} }).status, "unchanged");
  assert.deepEqual({ before, after }, original);
});

test("initial contracts and key reordering do not invent changes; whole module removal stays visible", () => {
  const contract = { title: "Модуль", responsibilities: { R1: "Один.", R2: "Два." },
    boundaries: {}, invariants: {}, extensions: { "test.one": { a: 1, b: 2 } } };
  assert.ok(contractChanges(null, contract, false).every((item) => item.status === "unchanged"));
  const reordered = { ...contract, responsibilities: { R2: "Два.", R1: "Один." },
    extensions: { "test.one": { b: 2, a: 1 } } };
  assert.ok(contractChanges(contract, reordered).every((item) => item.status === "unchanged"));
  assert.ok(contractChanges(contract, null).every((item) => item.status === "removed"));
});

test("evidence names are short while tooltips retain distinct full paths and snapshot origins", () => {
  const current = evidenceLabel({ snapshot: "current" }, { path: "src/archiview/http.mjs" });
  const baseline = evidenceLabel({ snapshot: "baseline" }, { path: "old/http.mjs" });
  assert.equal(current.name, "http.mjs");
  assert.equal(baseline.name, "http.mjs");
  assert.equal(current.title, "Проверенная версия · src/archiview/http.mjs");
  assert.equal(baseline.title, "Для сравнения · old/http.mjs");
});

test("a finding replaces the duplicate assessment without losing its owning clause", () => {
  const bundle = observedReview();
  bundle.report.findings = [{ id: "external-storage-escape", summary: "Ошибка хранения.",
    clauses: [{ module_id: "parent", section: "invariants", id: "I1" }], evidence: [] }];
  const original = structuredClone(bundle);
  const items = reviewFindingItems(bundle);
  assert.equal(items.length, 1);
  assert.equal(items[0].clauses[0].module_id, "parent");
  assert.deepEqual(bundle, original);
  assert.equal(freshnessLabel({ status: "fresh", current_violation: true }), "проверенные входы не изменились");
});

test("an old violation without a detailed finding remains one explicit remark", () => {
  const bundle = observedReview();
  bundle.report.findings = [];
  bundle.report.assessment.current.summary = "Нарушена граница.";
  assert.equal(reviewFindingItems(bundle).length, 1);
  assert.equal(reviewFindingItems(bundle)[0].summary, "Нарушена граница.");
  assert.equal(reviewFindingItems(bundle)[0].assessmentOnly, true);
  assert.deepEqual(bundle.report.findings, []);
});

/** Собственный пункт и чужой одноимённый пункт сохраняют раздельные результаты. */
function clauseReviewFixture() {
  const bundle = historicalReview();
  bundle.report.id = "review-first";
  bundle.report.analysis = { created_at: "2026-11-09T06:14:12Z" };
  bundle.report.assessment = { current: { verdict: "consistent", summary: "Проверено." } };
  bundle.report.findings = [];
  bundle.contracts = { current: [{ reference: { snapshot: "current", module_id: "child",
    section: "responsibilities", id: "R1" }, text: "Возвращать данные." }] };
  bundle.freshness = { current: { status: "stale" } };
  return { bundle, contract: { id: "child", responsibilities: { R1: "Возвращать данные." } } };
}

test("each finding has its own navigation target independently of the clause change status", () => {
  const { bundle, contract } = clauseReviewFixture();
  const reference = { snapshot: "current", module_id: "child", section: "responsibilities", id: "R1" };
  bundle.report.findings = [
    { id: "first-error", summary: "Первая ошибка.", severity: "error", lifecycle: "persisting",
      clauses: [reference, { ...reference, snapshot: "baseline" }] },
    { id: "second-error", summary: "Вторая ошибка.", severity: "warning", lifecycle: "introduced", clauses: [reference] },
  ];
  const original = structuredClone(bundle);
  const targets = clauseFindingTargets(bundle, contract, "responsibilities", "R1");
  assert.deepEqual(targets.map((target) => [target.reviewId, target.findingId]),
    [["review-first", "first-error"], ["review-first", "second-error"]]);
  assert.match(targets[0].label, /Первая ошибка.*нужна перепроверка/);
  assert.equal(contractChanges(contract, contract).find((item) => item.key === "responsibilities.R1").status, "unchanged");
  const changed = { ...contract, responsibilities: { R1: "Изменённый текст." } };
  assert.equal(contractChanges(contract, changed).find((item) => item.key === "responsibilities.R1").status, "modified");
  const afterChange = clauseFindingTargets(bundle, changed, "responsibilities", "R1");
  assert.equal(afterChange.length, 2);
  assert.match(afterChange[0].label, /текст пункта изменён после анализа/);
  assert.deepEqual(bundle, original);
});

test("foreign and resolved findings do not create bugs for a local clause", () => {
  const { bundle, contract } = clauseReviewFixture();
  bundle.report.findings = [
    { kind: "invariant_violation", severity: "error", certainty: "confirmed", lifecycle: "persisting",
      clauses: [{ snapshot: "current", module_id: "parent", section: "responsibilities", id: "R1" }] },
    { kind: "boundary_violation", severity: "error", certainty: "confirmed", lifecycle: "resolved",
      clauses: [{ snapshot: "current", module_id: "child", section: "responsibilities", id: "R1" }] },
  ];
  assert.deepEqual(clauseFindingTargets(bundle, contract, "responsibilities", "R1"), []);
  assert.deepEqual(clauseFindingTargets(bundle, { ...contract, id: "other" }, "responsibilities", "R1"), []);
});

test("a legacy violation without findings links to its explicit assessment remark", () => {
  const { bundle, contract } = clauseReviewFixture();
  assert.deepEqual(clauseFindingTargets(bundle, contract, "responsibilities", "R1"), []);
  bundle.report.assessment.current = { verdict: "violation", summary: "Нарушена граница." };
  for (const check of bundle.report.checks) check.verdict = "violation";
  const targets = clauseFindingTargets(bundle, contract, "responsibilities", "R1");
  assert.equal(targets.length, 1);
  assert.equal(targets[0].reviewId, "review-first");
  assert.equal(targets[0].findingId, "assessment-summary");
  assert.equal(targets[0].summary, "Нарушена граница.");
  for (const check of bundle.report.checks) check.verdict = "not_checked";
  assert.deepEqual(clauseFindingTargets(bundle, contract, "responsibilities", "R1"), []);
  assert.deepEqual(clauseFindingTargets(null, contract, "responsibilities", "R1"), []);
  assert.deepEqual(bundle.report.findings, []);
});
