import type { SessionOperations } from "../application/api.js";
/** Каталог операций панели. Хост видит схемы, но visibility=app исключает их из инструментов модели. */
import { ApplicationError } from "../application/errors.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

type Rule = { type: "string"; maxLength: number } | { type: "integer"; minimum: number; maximum: number } | { type: "boolean" };
type Method = "getProject" | "chooseProject" | "setProject" | keyof SessionOperations;
type Operation = [string, Method, string, Record<string, Rule>, string[], boolean];

const string: Rule = { type: "string", maxLength: 4096 };
const selectedModule = { view: string, path: string, repository: string };
/** Явный набор операций сервиса, без произвольного URL, имени функции или доступа к файлам. */
const operations: Operation[] = [
  ["get_project", "getProject", "Resolve this panel's project directory without loading snapshots or history.", {}, [], true],
  ["choose_project", "chooseProject", "Show a native folder chooser after an explicit user click. Cancellation keeps the current input.", {}, [], false],
  ["set_project", "setProject", "Bind this panel to a project directory.", { projectRoot: string }, ["projectRoot"], false],
  ["get_comparison", "getComparison", "Load the selected repository comparison and timeline. With published=true, prefer the last complete publication.", { repository: string, target: string, baseline: string, watch: { type: "boolean" }, historyLimit: { type: "integer", minimum: 1, maximum: 10000 }, published: { type: "boolean" } }, [], false],
  ["wait_for_changes", "waitForChanges", "Wait for the selected working tree or its saved reviews to change.", { repository: string, cursor: string }, ["cursor"], true],
  ["get_review_statuses", "getReviewStatuses", "Load analysis statuses for the selected tree.", { view: string, repository: string }, ["view"], true],
  ["get_module", "getModule", "Load module details from an existing comparison.", { ...selectedModule, analysis: {type:"boolean"} }, ["view", "path"], true],
  ["prepare_analysis", "prepareAnalysis", "Prepare immutable inputs for an explicit module analysis.", selectedModule, ["view", "path"], false],
  ["get_analysis", "getAnalysis", "Read the saved status of a prepared analysis.", { id: string, repository: string }, ["id"], true],
  ["build_review", "buildReview", "Refresh a structural report for a selected module.", selectedModule, ["view", "path"], false],
  ["save_snapshot", "saveSnapshot", "Save the selected complete snapshot.", { view: string, repository: string, label: { type: "string", maxLength: 120 } }, ["view"], false],
];

export const UI_TOOL_METHODS = new Map(operations.map(([name, method]) => ["archiview_ui_" + name, method]));
export const UI_TOOLS = operations.map(([name, , description, properties, required, readOnlyHint]) => ({
  name: "archiview_ui_" + name, description,
  inputSchema: { type: "object" as const, properties, required, additionalProperties: false },
  annotations: { readOnlyHint, destructiveHint: false, openWorldHint: false },
  _meta: { ui: { visibility: ["app"] } },
})) satisfies Tool[];

/** SDK низкого уровня не валидирует inputSchema; проверяем тот же контракт перед вызовом сервиса. */
export function validateUiArguments(name: string, args: unknown): asserts args is Record<string, unknown> {
  const schema = UI_TOOLS.find((tool) => tool.name === name)?.inputSchema;
  const invalid = () => { throw new ApplicationError("INVALID_ARGUMENT", "Некорректные параметры операции панели"); };
  if (!schema || !args || typeof args !== "object" || Array.isArray(args)) return invalid();
  if (Object.keys(args).some((key) => !Object.hasOwn(schema.properties, key)) ||
      schema.required.some((key) => !Object.hasOwn(args, key))) invalid();
  for (const [key, value] of Object.entries(args)) {
    const rule = schema.properties[key];
    if (rule.type === "string" && (typeof value !== "string" || value.length > rule.maxLength)) invalid();
    if (rule.type === "integer" && (typeof value !== "number" || !Number.isSafeInteger(value) || value < rule.minimum || value > rule.maximum)) invalid();
    if (rule.type === "boolean" && typeof value !== "boolean") invalid();
  }
}
