import type { ReviewInput } from "../framework/static-report/types.js";
/**
 * CLI локального просмотра, построения переносимых отчётов и обмена входами
 * с агентом. Проверка индекса читает staged-набор, остальные операции сохраняют
 * данные только в выбранном хранилище ArchiView.
 */
import { parseArgs } from "node:util";
import { readFile, writeFile, lstat } from "node:fs/promises";
import { stringify } from "yaml";
import { createWorkspaceSession, listWorkspaceModules } from "../web/web-backend/workspace-session.js";
import type { SessionOperations } from "../module-operations/api.js";
import type { openProjectHistory } from "../analyse/module-review/legacy-history.js";
import { readReviewBundle } from "../analyse/module-review/review-store.js";
import { parseYaml } from "../framework/serialization/yaml.js";
import { digest } from "../framework/serialization/digest.js";
import { normalizeAnalysisType } from "../framework/ai-report/types.js";
import { createReviewInput } from "../analyse/module-review/review-input.js";
import { checkPreparedIndex } from "../analyse/module-review/report-index.js";
import { moduleContext, moduleInventory } from "../analyse/project-sources/inventory.js";
import { resolveWorkspaceRepository } from "../analyse/project/workspace.js";
import { createScaffold } from "../module-operations/prototypes.js";
import { listModuleFiles, getModuleContract, saveModuleContract, saveGitComparison } from "../module-operations/module-access.js";
import { errorDetails } from "../node-errors.js";
import { turnHook } from "./turn-hook.js";

async function serve(workspace: SessionOperations & { root: string }, port: number, prepareWeb?: () => Promise<void>, history?: Awaited<ReturnType<typeof openProjectHistory>>) {
  await prepareWeb?.();
  const { createArchiViewHttpServer } = await import("../web/web-backend/web-service/http.js");
  const server = createArchiViewHttpServer(workspace);
  server.on("error", (error) => { process.stderr.write("ArchiView: " + error.message + "\n"); process.exitCode = 1; });
  server.listenLocal(port, () => {
    const address = server.address() as import("node:net").AddressInfo;
    process.stdout.write("ArchiView Local: http://" + address.address + ":" + address.port +
      "\nProject: " + workspace.root + "\n");
    if (history) process.stdout.write("State: " + history.store.directory + "\n");
    if (history?.migration) process.stdout.write("History copied: " + history.migration.snapshots +
      " snapshots, " + history.migration.reviews + " reviews\n");
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
    "save-comparison": { type: "boolean" }, "read-comparison": { type: "string" }, baseline: { type: "string" },
    "complete-analysis": { type: "string" },
    "analysis-limitation": { type: "string" }, reason: { type: "string" },
    "turn-hook": { type: "string" }, "review-current": { type: "boolean" }, "prepare-current-review": { type: "string" },
    "relation-review-input": { type: "boolean" }, "complete-relation-review": { type: "string" },
    "review-turn": { type: "string" }, wait: { type: "string" },
    "prepare-analysis": { type: "string" },
    "check-index": { type: "boolean" }, "export-review-input": { type: "string" }, "analysis-type": {type:"string"},
    output: { type: "string" }, dependencies: { type: "string" },
    "dependencies-complete": { type: "boolean" },
    repository: { type: "string" }, target: { type: "string" }, directory: { type: "string" }, input: { type: "string" },
    "list-modules": { type: "boolean" }, "module-files": { type: "string" }, "get-contract": { type: "string" },
    "build-relations": { type: "boolean" }, "module-relations": { type: "string" },
    "write-contract": { type: "string" }, inventory: { type: "boolean" },
    "module-context": { type: "string" }, scaffold: { type: "string" },
  } });
  const root = values.root ?? process.cwd();
  const analysisType = normalizeAnalysisType(values["analysis-type"]);
  if (values.reason !== undefined && !values["analysis-limitation"]) throw new Error("--reason используется с --analysis-limitation");
  if (values.wait !== undefined && values["review-turn"] === undefined) throw new Error("--wait используется с --review-turn");
  const mode = (["turn-hook", "review-current", "prepare-current-review", "relation-review-input",
    "complete-relation-review", "review-turn"] as const).find(key => values[key] !== undefined);
  if (mode && !values.help) {
    const allowed = new Set(["root", "state-dir", mode, "port"]);
    if (mode !== "turn-hook") allowed.add("repository");
    if (mode === "review-turn") allowed.add("wait");
    if (mode === "prepare-current-review") allowed.add("analysis-type");
    if (Object.keys(values).some(key => !allowed.has(key))) throw new Error("Выберите одну операцию текущего анализа");
    if (mode === "turn-hook") {
      let input = "";
      process.stdin.setEncoding("utf8");
      for await (const chunk of process.stdin) input += chunk;
      const response = await turnHook(values[mode]!, JSON.parse(input), values.root, values["state-dir"]);
      process.stdout.write(JSON.stringify(response) + "\n");
    } else {
      const turnId = values["review-turn"];
      if (turnId !== undefined) {
        if (!/^[a-f0-9]{64}$/.test(turnId)) throw new Error("Некорректный идентификатор хода");
        const wait = Number(values.wait ?? 0);
        if (!Number.isSafeInteger(wait) || wait < 0 || wait > 3600) throw new Error("--wait принимает от 0 до 3600 секунд");
      }
      if (mode === "prepare-current-review" && !analysisType)
        throw new Error("--prepare-current-review требует --analysis-type composition|implementation");
      const workspace = await createWorkspaceSession({root, stateDirectory:values["state-dir"], initialRepository:values.repository});
      try {
        const session = await workspace.session(values.repository ?? ".", true);
        let result;
        if (mode === "prepare-current-review" && analysisType) {
          result = await session.turns.prepareCurrent(values[mode]!, analysisType);
        } else if (mode === "relation-review-input") {
          result = await session.turns.relationReviewInput();
        } else if (mode === "complete-relation-review") {
          const report: unknown = JSON.parse(await readFile(values[mode]!, "utf8"));
          result = await session.turns.completeRelationReview(report);
        } else {
          result = {...(turnId && {turnId}), ...await session.turns.current()};
        }
        process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      } finally { await workspace.close(); }
    }
    return;
  }
  const selection = { repository: values.repository, target: values.target };
  const moduleCommands = (["list-modules", "module-files", "module-relations", "build-relations", "get-contract", "write-contract", "inventory", "module-context", "scaffold", "save-comparison", "read-comparison"] as const)
    .filter(name => values[name] !== undefined);
  const reportCommands = (["import-review", "build-report", "export-review-input", "complete-analysis", "prepare-analysis", "analysis-limitation"] as const)
    .filter(name => values[name] !== undefined);
  if (!values.help && moduleCommands.length && (moduleCommands.length > 1 || values["check-index"] || reportCommands.length))
    throw new Error("Выберите одну операцию с модулем");
  if (!values.help && values["check-index"] && reportCommands.length)
    throw new Error("--check-index несовместим с --" + reportCommands[0]);
  if (!values.help && (values.input !== undefined || values.directory !== undefined) && !values["write-contract"])
    throw new Error("--input и --directory используются с --write-contract");
  if (!values.help && values.baseline !== undefined && !values["save-comparison"])
    throw new Error("--baseline используется с --save-comparison");
  if (!values.help && values.target !== undefined && !["list-modules", "module-files", "module-relations", "get-contract", "write-contract", "save-comparison"].some(name => name === moduleCommands[0]))
    throw new Error("--target используется с операциями снимка модуля");
  if (values["analysis-type"] !== undefined && (!analysisType || !values["export-review-input"]))
    throw new Error("--analysis-type composition|implementation применяется с --export-review-input");
  if (!values.help && (values.dependencies !== undefined || values["dependencies-complete"]))
    throw new Error("Сбор зависимостей через LLM отключён. Для связей TS/JS используйте --build-relations.");
  if (values.help) {
    process.stdout.write("ArchiView — archiview [--root DIR] [--port 4317] [--state-dir DIR]\n" +
      "  --build-report                       Построить и уплотнить отчёты без сервера\n" +
      "  --save-comparison [--baseline FROM] [--target TO]    Сохранить отчёт об изменениях и вывести его ID (JSON)\n" +
      "      Состояния Git: HEAD, index, current, git-<хеш>. Пустая база: empty. По умолчанию: HEAD и current.\n" +
      "  --read-comparison ID                 Прочитать сохранённый отчёт об изменениях (JSON)\n" +
      "  --import-review FILE_OR_BUNDLE       Импортировать YAML review или прежний пакет\n" +
      "  --complete-analysis REQUEST_ID       Проверить и импортировать result.yaml запроса панели\n" +
      "  --analysis-limitation ID --reason TEXT  Сохранить причину незавершённой проверки\n" +
      "  --turn-hook codex|dsh                Обработать событие UserPromptSubmit или Stop из stdin\n" +
      "  --review-current                    Показать актуальные потребности в анализе и исправлениях (JSON)\n" +
      "  --relation-review-input             Получить текущий граф связей и цепочки циклов (JSON)\n" +
      "  --complete-relation-review FILE     Импортировать JSON-отчёт разбора текущего графа\n" +
      "  --prepare-current-review MODULE_ID --analysis-type composition|implementation\n" +
      "                                      Подготовить входы выбранной проверки для подагента (JSON)\n" +
      "  --review-turn ID [--wait SECONDS]    Прежнее имя команды списка текущих проверок\n" +
      "  --prepare-analysis REQUEST_ID        Повторить экспорт исходного снимка без зависимостей\n" +
      "  --export-review-input MODULE_ID --output FILE [--analysis-type composition|implementation]\n" +
      "  --list-modules                       Проекты и модули выбранной рабочей папки (JSON)\n" +
      "  --module-files ID                    Список файлов модуля (JSON)\n" +
      "  --build-relations                    Построить связи TS/JS всего репозитория\n" +
      "  --module-relations ID                Связи рабочего дерева, git-<hash> или сохранённого снимка\n" +
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
      case "save-comparison":
      case "read-comparison": {
        const workspace = await createWorkspaceSession({ root, stateDirectory: values["state-dir"], initialRepository: values.repository });
        try {
          const { store } = await workspace.session(values.repository ?? ".");
          if (values["save-comparison"]) {
            const report = await saveGitComparison(store, values.baseline, values.target);
            json({ id: report.id });
          } else {
            const report = await store.readComparison(values["read-comparison"]!);
            if (!report) throw new Error("Сохранённый отчёт сравнения не найден");
            json(report);
          }
        } finally { await workspace.close(); }
        break;
      }
      case "build-relations":
      case "module-relations": {
        const workspace = await createWorkspaceSession({ root, stateDirectory: values["state-dir"], initialRepository: values.repository });
        try {
          const session = await workspace.session(values.repository ?? ".", true);
          if (values.target === "index") throw new Error("Для чтения связей укажите current, git-<хеш> или идентификатор сохранённого снимка.");
          const comparison = await session.getComparison({ target: values.target });
          if (values["build-relations"]) {
            const module = comparison.modules.find(m => m.currentPath === ".") ?? comparison.modules.find(m => m.currentPath !== null);
            if (!module) throw new Error("В рабочем дереве нет модулей.");
            const result = await session.buildRelations({view: comparison.id, path: module.key});
            if (result.ready) json({ indexed: result.indexed, eligible: result.eligible, indexer: result.indexer });
          } else {
            const selector = values["module-relations"];
            const module = comparison.modules.find(m => m.moduleId === selector) ?? comparison.modules.find(m => m.key === selector);
            if (!module) throw new Error("Модуль не найден: " + selector);
            json(await session.getRelations({view: comparison.id, path: module.key}));
          }
        } finally { await workspace.close(); }
        break;
      }
      case "list-modules": json(await listWorkspaceModules(root, selection)); break;
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
    const batch = values["build-report"] || values["export-review-input"] || values["complete-analysis"] || values["prepare-analysis"] || values["analysis-limitation"];
    const port = Number(values.port);
    if (!batch && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error("--port must be between 0 and 65535");
    const workspace = await createWorkspaceSession({
      root, stateDirectory: values["state-dir"], initialRepository: values.repository,
    });
    if (!batch && !values["import-review"]) return serve(workspace, port, prepareWeb);
    // Batch commands operate on their explicit --root. A workspace container has no shared history.
    const session = await workspace.session(values.repository ?? ".", !(values["build-report"] || values["export-review-input"]));
    const { store, reports, analysis } = session;
    if (values["analysis-limitation"]) await analysis.reportLimitation(values["analysis-limitation"], values.reason ?? "");
    if (values["build-report"] && session.startupComparison) {
      const saved = await store.saveComparison(session.startupComparison);
      process.stdout.write("Git comparison saved: " + saved.id + "\n");
    }
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
        values["export-review-input"], {analysisType});
      await writeFile(values.output, stringify(input, { aliasDuplicateObjects: false }), { flag: "wx" });
      process.stdout.write("Review input exported: " + values.output + "\n");
    }
    if (batch) {
      process.stdout.write("Reports prepared: " + store.directory + "\n");
      await workspace.close();
    } else {
      await serve(workspace, port, prepareWeb, session);
    }
  }
}
