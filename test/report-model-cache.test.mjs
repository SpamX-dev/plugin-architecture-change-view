/**
 * Проверяет границу жизни подготовленной модели: снимки фиксируются один раз,
 * новый расчёт видит изменения, а объединение истории и изменение результатов
 * вызывающей стороной не загрязняют состояния остальных отчётов.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { stringify } from "yaml";
import { contractDocument, digest } from "../src/formats.mjs";
import { snapshotDigest } from "../src/snapshots.mjs";
import { aggregateTreeStatuses, createReportModel, createReviewInput, createTechnicalReport,
  reviewFreshness } from "../src/report-model.mjs";

/** Небольшие настоящие контракты и файловые факты позволяют менять входы независимо от id. */
function snapshot({ source = "export const value = 1;\n", child = true, contractText = "Читать данные." } = {}) {
  const facts = [];
  const modules = [{ id: "root", directory: "." }, ...(child ? [{ id: "child", directory: "child" }] : [])]
    .map(({ id, directory }) => {
      const prefix = directory === "." ? "" : directory + "/";
      const text = stringify({ schema_version: 1, id, title: id, kind: "module", purpose: "Предоставлять данные.",
        responsibilities: { R1: contractText }, boundaries: { B1: "Не обращаться к сети." }, invariants: {} });
      const contents = { [prefix + "arch.yaml"]: text, [prefix + "index.mjs"]: source };
      const files = Object.entries(contents).map(([path, text]) => {
        const content = { kind: "file", path, text, start_line: 1, end_line: text.split("\n").length };
        facts.push({ id: digest(content), ...content });
        return { path, hash: digest(text) };
      });
      return { directory, documentPath: prefix + "arch.yaml", document: contractDocument(text), files, sourceFiles: 1 };
    });
  const result = { schema_version: 2, id: "reused-input-id", kind: "working", root: "C:/fixture",
    complete: true, diagnostics: [], evidenceLimitations: [], modules, facts };
  result.digest = snapshotDigest(result);
  return result;
}

/** Условия зависимости заданы явно, содержательный вердикт для сравнения входов не требуется. */
function draft(baseline, current, id) {
  return createReviewInput("fixture-project", baseline, current, id,
    { dependencies: [], dependencyCoverage: { status: "complete", potential_influence: [] } });
}

test("prepared model captures mutable inputs before its first calculation and new models see changes", () => {
  const current = snapshot();
  const expected = createTechnicalReport("fixture-project", null, current, { moduleId: "root" });
  const model = createReportModel(null, current);
  // Сохраняем прежние id/digest: глобальный кэш по этим полям пропустил бы изменение.
  current.facts.find((fact) => fact.path === "index.mjs").text = "export const value = 2;\n";
  current.modules[0].document.contract.responsibilities.R1 = "Читать новые данные.";
  current.diagnostics.push("Изменённые входы.");
  assert.deepEqual(model.createTechnicalReport("fixture-project", { moduleId: "root" }), expected);
  const next = createReportModel(null, current).createTechnicalReport("fixture-project", { moduleId: "root" });
  assert.notEqual(next.check_hash, expected.check_hash);
  assert.equal(next.current.technical.contract.responsibilities.R1, "Читать новые данные.");
  assert.deepEqual(next.structure.diagnostics, ["Изменённые входы."]);
  assert.deepEqual(next, createTechnicalReport("fixture-project", null, current, { moduleId: "root" }));
});

test("returned technical report cannot mutate cached state of another report", () => {
  const current = snapshot();
  const model = createReportModel(null, current);
  const expected = model.createTechnicalReport("fixture-project", { moduleId: "root" });
  const editable = model.createTechnicalReport("fixture-project", { moduleId: "root" });
  editable.current.technical.contract.responsibilities.R1 = "Чужое изменение результата.";
  editable.current.self.children.length = 0;
  editable.current.technical.own_files[0].digest = "changed";
  editable.structure.diagnostics.push("Только в полученном отчёте.");
  assert.deepEqual(model.createTechnicalReport("fixture-project", { moduleId: "root" }), expected);
  assert.deepEqual(model.createTechnicalReport("another-project", { moduleId: "child" }),
    createTechnicalReport("another-project", null, current, { moduleId: "child" }));
});

test("tree history includes removed modules without adding them to cached current state", () => {
  const baseline = snapshot();
  const current = snapshot({ child: false });
  const model = createReportModel(baseline, current);
  const removed = draft(baseline, current, "child");
  const before = model.createTechnicalReport("fixture-project", { moduleId: "child" });
  const expectedFreshness = reviewFreshness(removed, baseline, current);
  const tree = model.aggregateTreeStatuses([removed]);
  assert.ok(tree.has("child"));
  assert.deepEqual(tree, aggregateTreeStatuses([removed], baseline, current));
  assert.equal(before.current, null);
  assert.deepEqual(model.createTechnicalReport("fixture-project", { moduleId: "child" }), before);
  assert.deepEqual(model.reviewFreshness(removed), expectedFreshness);
  assert.deepEqual(model.createTechnicalReport("fixture-project", { moduleId: "root" }).current.self.children, []);
  tree.clear();
  assert.ok(model.aggregateTreeStatuses([removed]).has("child"));
});

test("prepared and one-shot freshness agree while later source changes require a fresh model", () => {
  const baseline = snapshot({ source: "export const value = 0;\n" });
  const current = snapshot();
  const review = draft(baseline, current, "root");
  const model = createReportModel(baseline, current);
  assert.equal(model.reviewFreshness(review).current.status, "fresh");
  assert.deepEqual(model.reviewFreshness(review), reviewFreshness(review, baseline, current));
  assert.deepEqual(model.aggregateTreeStatuses([review]), aggregateTreeStatuses([review], baseline, current));
  current.facts.find((fact) => fact.path === "index.mjs").text = "export const value = 3;\n";
  const updated = createReportModel(baseline, current).reviewFreshness(review);
  assert.equal(updated.current.status, "stale");
  assert.ok(updated.current.reasons.some((reason) => reason.code === "own_code"));
  assert.equal(model.reviewFreshness(review).current.status, "fresh");
  assert.deepEqual(updated, reviewFreshness(review, baseline, current));
});
