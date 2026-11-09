#!/usr/bin/env node
/**
 * CLI локального просмотра, построения переносимых отчётов и обмена входами
 * с агентом. Проверка индекса читает staged-набор, остальные операции сохраняют
 * данные только в выбранном хранилище ArchiView.
 */
import { parseArgs } from "node:util";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { stringify } from "yaml";
import { createArchiView } from "./http.mjs";
import { readReviewBundle } from "../review-store.mjs";
import { parseYaml, digest } from "../formats.mjs";
import { createReviewInput } from "../report-model.mjs";
import { checkPreparedIndex } from "../report-index.mjs";
import { compareSnapshots } from "../snapshots.mjs";

const { values } = parseArgs({ options: {
  root: { type: "string" }, port: { type: "string", default: "4317" },
  "state-dir": { type: "string" }, help: { type: "boolean", short: "h" },
  "import-review": { type: "string" }, "build-report": { type: "boolean" },
  "complete-analysis": { type: "string" },
  "prepare-analysis": { type: "string" },
  "check-index": { type: "boolean" }, "export-review-input": { type: "string" },
  output: { type: "string" }, dependencies: { type: "string" },
  "dependencies-complete": { type: "boolean" },
} });
if (values.help) {
  process.stdout.write("ArchiView — archiview [--root DIR] [--port 4317] [--state-dir DIR]\n" +
    "  --build-report                       Построить и уплотнить отчёты без сервера\n" +
    "  --import-review FILE_OR_BUNDLE       Импортировать YAML review или прежний пакет\n" +
    "  --complete-analysis REQUEST_ID       Проверить и импортировать result.yaml запроса панели\n" +
    "  --prepare-analysis REQUEST_ID [--dependencies FILE] [--dependencies-complete]\n" +
    "  --export-review-input MODULE_ID --output FILE [--dependencies FILE] [--dependencies-complete]\n" +
    "  --check-index                        Проверить код и отчёты в подготовленном индексе Git\n");
} else if (values["check-index"]) {
  const result = await checkPreparedIndex(values.root ?? process.cwd());
  process.stdout.write("Index verified: " + result.modules + " modules, " + result.reviews + " reviews\n");
} else {
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be between 0 and 65535");
  const { server, root, store, reports, analysis } = await createArchiView({
    root: values.root ?? process.cwd(), stateDirectory: values["state-dir"],
  });
  if (values["complete-analysis"]) {
    const result = await analysis.complete(values["complete-analysis"]);
    process.stdout.write("Analysis imported: " + result.reviewId + "\n");
  }
  if (values["prepare-analysis"]) {
    const dependencies = values.dependencies ? parseYaml(await readFile(values.dependencies, "utf8"), (value) => value) : [];
    const file = await analysis.prepare(values["prepare-analysis"], dependencies, Boolean(values["dependencies-complete"]));
    process.stdout.write("Analysis input exported: " + file + "\n");
  }
  if (values["import-review"]) {
    const source = values["import-review"];
    const value = (await lstat(source)).isDirectory() ? await readReviewBundle(source) :
      parseYaml(await readFile(source, "utf8"), (data) => data);
    // Входной шаблон редактируется агентом; хеш manifest вычисляет инструмент.
    // Все связи, доказательства и результаты проверяются при сохранении.
    if (value.kind === "review-input") value.report.analysis.input_digest = digest(value.manifest);
    const id = await reports.saveReview(value);
    const comparison = await reports.publishedComparison();
    if (comparison) await reports.rebuild(comparison.baseline, comparison.current,
      compareSnapshots(comparison.baseline, comparison.current).modules);
    process.stdout.write("Review imported: " + JSON.stringify(id) + "\n");
  }
  if (values["export-review-input"]) {
    if (!values.output) throw new Error("--export-review-input requires --output");
    const comparison = await reports.publishedComparison();
    if (!comparison) throw new Error("No complete published comparison");
    const dependencies = values.dependencies ? parseYaml(await readFile(values.dependencies, "utf8"), (data) => {
      if (!Array.isArray(data)) throw new Error("Dependencies must be a YAML sequence");
      return data;
    }) : [];
    const input = createReviewInput(digest(store.snapshotRoot), comparison.baseline, comparison.current,
      values["export-review-input"], { dependencies, dependencyCoverage: {
        status: values["dependencies-complete"] ? "complete" : "unknown",
        potential_influence: values["dependencies-complete"] ? [] : [{ scope: "project" }],
      } });
    await writeFile(values.output, stringify(input, { aliasDuplicateObjects: false }), { flag: "wx" });
    process.stdout.write("Review input exported: " + values.output + "\n");
  }
  if (values["build-report"] || values["export-review-input"] || values["complete-analysis"] || values["prepare-analysis"]) {
    process.stdout.write("Reports prepared: " + store.directory + "\n");
  } else {
    server.on("error", (error) => { process.stderr.write("ArchiView: " + error.message + "\n"); process.exitCode = 1; });
    server.listen(port, "127.0.0.1", () => {
      process.stdout.write("ArchiView Local: http://127.0.0.1:" + server.address().port +
        "\nProject: " + root + "\nState: " + store.directory + "\n");
      if (store.migration) process.stdout.write("History copied: " + store.migration.snapshots +
        " snapshots, " + store.migration.reviews + " reviews\n");
    });
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => server.close(() => process.exit()));
  }
}
