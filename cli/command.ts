import type { ReviewInput } from "../framework/static-report/types.js";
/**
 * CLI локального просмотра, построения переносимых отчётов и обмена входами
 * с агентом. Проверка индекса читает staged-набор, остальные операции сохраняют
 * данные только в выбранном хранилище ArchiView.
 */
import { parseArgs } from "node:util";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { stringify } from "yaml";
import { createWorkspaceSession } from "../web/web-backend/workspace-session.js";
import type { SessionOperations } from "../module-operations/api.js";
import type { SnapshotStore } from "../analyse/git-changes/snapshot-store.js";
import { readReviewBundle } from "../analyse/module-review/review-store.js";
import { parseYaml } from "../framework/serialization/yaml.js";
import { digest } from "../framework/serialization/digest.js";
import { createReviewInput } from "../analyse/module-review/review-input.js";
import { checkPreparedIndex } from "../analyse/module-review/report-index.js";
import { moduleContext, moduleInventory } from "../analyse/project/inventory.js";
import { resolveWorkspaceRepository } from "../analyse/project/workspace.js";
import { createScaffold } from "../module-operations/prototypes.js";
import { listModules, listModuleFiles, getModuleContract, saveModuleContract } from "../module-operations/module-access.js";
import { errorDetails } from "../node-errors.js";

async function serve(workspace: SessionOperations & { root: string }, port: number, prepareWeb?: () => Promise<void>, store?: SnapshotStore) {
  await prepareWeb?.();
  const { createArchiViewHttpServer } = await import("../web/web-backend/web-service/http.js");
  const server = createArchiViewHttpServer(workspace);
  server.on("error", (error) => { process.stderr.write("ArchiView: " + error.message + "\n"); process.exitCode = 1; });
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write("ArchiView Local: http://127.0.0.1:" + (server.address() as import("node:net").AddressInfo).port +
      "\nProject: " + workspace.root + "\n");
    if (store) process.stdout.write("State: " + store.directory + "\n");
    if (store?.migration) process.stdout.write("History copied: " + store.migration.snapshots +
      " snapshots, " + store.migration.reviews + " reviews\n");
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, server.shutdown);
}

export async function runCli(prepareWeb?: () => Promise<void>) {
  try { await execute(prepareWeb); }
  catch (error) {
    process.stderr.write("ArchiView: " + errorDetails(error).message + "\n");
    process.exitCode = 1;
  }
}

async function execute(prepareWeb?: () => Promise<void>) {
  const { values } = parseArgs({ options: {
    root: { type: "string" }, port: { type: "string", default: "4317" },
    "state-dir": { type: "string" }, help: { type: "boolean", short: "h" },
    "import-review": { type: "string" }, "build-report": { type: "boolean" },
    "complete-analysis": { type: "string" },
    "prepare-analysis": { type: "string" },
    "check-index": { type: "boolean" }, "export-review-input": { type: "string" },
    output: { type: "string" }, dependencies: { type: "string" },
    "dependencies-complete": { type: "boolean" },
    repository: { type: "string" }, target: { type: "string" }, directory: { type: "string" }, input: { type: "string" },
    "list-modules": { type: "boolean" }, "module-files": { type: "string" }, "get-contract": { type: "string" },
    "write-contract": { type: "string" }, inventory: { type: "boolean" },
    "module-context": { type: "string" }, scaffold: { type: "string" },
  } });
  const root = values.root ?? process.cwd();
  const selection = { repository: values.repository, target: values.target };
  const moduleCommands = (["list-modules", "module-files", "get-contract", "write-contract", "inventory", "module-context", "scaffold"] as const)
    .filter(name => values[name] !== undefined);
  if (!values.help && moduleCommands.length && (moduleCommands.length > 1 || values["check-index"] || values["import-review"] ||
    values["build-report"] || values["export-review-input"] || values["complete-analysis"] || values["prepare-analysis"]))
    throw new Error("Выберите одну операцию с модулем");
  if (!values.help && (values.input !== undefined || values.directory !== undefined) && !values["write-contract"])
    throw new Error("--input и --directory используются с --write-contract");
  if (!values.help && values.target !== undefined && !["list-modules", "module-files", "get-contract", "write-contract"].some(name => name === moduleCommands[0]))
    throw new Error("--target используется с операциями снимка модуля");
  if (!values.help && (values.dependencies !== undefined || values["dependencies-complete"]))
    throw new Error("Сбор зависимостей через LLM отключён; определение через AST не подключено.");
  if (values.help) {
    process.stdout.write("ArchiView — archiview [--root DIR] [--port 4317] [--state-dir DIR]\n" +
      "  --build-report                       Построить и уплотнить отчёты без сервера\n" +
      "  --import-review FILE_OR_BUNDLE       Импортировать YAML review или прежний пакет\n" +
      "  --complete-analysis REQUEST_ID       Проверить и импортировать result.yaml запроса панели\n" +
      "  --prepare-analysis REQUEST_ID        Повторить экспорт исходного снимка без зависимостей\n" +
      "  --export-review-input MODULE_ID --output FILE\n" +
      "  --list-modules                       Проекты и модули выбранной рабочей папки (JSON)\n" +
      "  --module-files ID                    Список файлов модуля (JSON)\n" +
      "  --get-contract ID                    Прочитать YAML контракта\n" +
      "  --write-contract ID --input FILE [--directory DIR]   Зарегистрировать или обновить контракт\n" +
      "  --inventory                          Инвентаризация исходников и состояния контрактов (JSON)\n" +
      "  --module-context PATH                Контракты предков для файла или каталога (JSON)\n" +
      "  --scaffold PLAN                      Зарегистрировать прототипы из YAML-списка в файле PLAN\n" +
      "  --repository RELATIVE_PATH           Выбрать репозиторий внутри рабочей папки\n" +
      "  --target current|index|git-<hash>    Состояние Git для чтения модулей, файлов и контрактов\n" +
      "  --check-index                        Проверить код и отчёты в подготовленном индексе Git\n");
  } else if (moduleCommands.length) {
    const json = (value: unknown) => process.stdout.write(JSON.stringify(value, null, 2) + "\n");
    switch (moduleCommands[0]) {
      case "list-modules": json(await listModules(root, selection)); break;
      case "module-files": json(await listModuleFiles(root, values["module-files"]!, selection)); break;
      case "get-contract": process.stdout.write(await getModuleContract(root, values["get-contract"]!, selection)); break;
      case "write-contract": {
        if (!values.input) throw new Error("--write-contract requires --input FILE");
        json(await saveModuleContract(root, values["write-contract"]!, await readFile(values.input, "utf8"), { ...selection, directory: values.directory }));
        break;
      }
      case "inventory": json(await moduleInventory(root, { repository: values.repository })); break;
      case "module-context": {
        const checkout = values.repository === undefined ? root : await resolveWorkspaceRepository(root, values.repository);
        const context = await moduleContext(checkout, values["module-context"]);
        if (values.repository !== undefined && context.repository !== ".") throw new Error("Путь находится за пределами выбранного репозитория");
        json(context);
        break;
      }
      case "scaffold": json(await createScaffold(root, values.repository, await readFile(values.scaffold!, "utf8"))); break;
    }
  } else if (values["check-index"]) {
    const result = await checkPreparedIndex(await resolveWorkspaceRepository(root, values.repository ?? "."));
    process.stdout.write("Index verified: " + result.modules + " modules, " + result.reviews + " reviews\n");
  } else {
    const batch = values["build-report"] || values["export-review-input"] || values["complete-analysis"] || values["prepare-analysis"];
    const port = Number(values.port);
    if (!batch && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error("--port must be between 0 and 65535");
    const workspace = await createWorkspaceSession({
      root, stateDirectory: values["state-dir"], initialRepository: values.repository,
    });
    if (!batch && !values["import-review"]) return serve(workspace, port, prepareWeb);
    // Batch commands operate on their explicit --root. A workspace container has no shared history.
    const { store, reports, analysis } = await workspace.session(values.repository ?? ".", !(values["build-report"] || values["export-review-input"]));
    if (values["complete-analysis"]) {
      const result = await analysis.complete(values["complete-analysis"]);
      process.stdout.write("Analysis imported: " + result.reviewId + "\n");
    }
    if (values["prepare-analysis"]) {
      const file = await analysis.prepare(values["prepare-analysis"], []);
      process.stdout.write("Analysis input exported: " + file + "\n");
    }
    if (values["import-review"]) {
      const source = values["import-review"];
      const value = (await lstat(source)).isDirectory() ? await readReviewBundle(source) :
        parseYaml(await readFile(source, "utf8"), (data) => data);
      // Входной шаблон редактируется агентом; хеш manifest вычисляет инструмент.
      // Все связи, доказательства и результаты проверяются при сохранении.
      if (value && typeof value === "object" && "kind" in value && value.kind === "review-input") {
        const input = value as ReviewInput;
        input.report.analysis.input_digest = digest(input.manifest);
      }
      const id = await reports.saveReview(value);
      process.stdout.write("Review imported: " + JSON.stringify(id) + "\n");
    }
    if (values["export-review-input"]) {
      if (!values.output) throw new Error("--export-review-input requires --output");
      const comparison = await reports.publishedComparison();
      if (!comparison) throw new Error("No complete published comparison");
      const input = createReviewInput(digest(store.snapshotRoot), comparison.baseline, comparison.current,
        values["export-review-input"]);
      await writeFile(values.output, stringify(input, { aliasDuplicateObjects: false }), { flag: "wx" });
      process.stdout.write("Review input exported: " + values.output + "\n");
    }
    if (batch) {
      process.stdout.write("Reports prepared: " + store.directory + "\n");
      await workspace.close();
    } else {
      await serve(workspace, port, prepareWeb, store);
    }
  }
}
