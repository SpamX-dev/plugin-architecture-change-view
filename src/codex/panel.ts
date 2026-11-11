import { callSessionOperation } from "../application/arguments.js";
/** Адаптер MCP Apps: собранный UI и скрытые операции прикладного сервиса, без HTTP-сервера. */
import { readFile } from "node:fs/promises";
import { createArchiViewSession } from "../application/session.js";
import { createProjectBinding } from "../application/project.js";
import { applicationError, ApplicationError } from "../application/errors.js";
import { packageUrl } from "../runtime/package-paths.js";
import { UI_TOOL_METHODS, validateUiArguments } from "./ui-tools.js";
import { chooseProjectDirectory } from "./directory-picker.js";

export const PANEL_URI = "ui://archiview/panel-v6.html";
export const PROJECT_INPUT = { type: "string", description: "Absolute project directory of the current chat, not the plugin installation. Normally selected automatically from the working folder supplied by Codex." };
export const PANEL_TOOL: import("@modelcontextprotocol/sdk/types.js").Tool = {
  name: "archiview_open", title: "ArchiView",
  description: "Open the local architecture panel for this project. Browsing stays in the UI; only an explicit Analyze action sends a request to the agent.",
  inputSchema: { type: "object", properties: { projectRoot: PROJECT_INPUT }, additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  _meta: { ui: { resourceUri: PANEL_URI }, "openai/ui": { entrypoints: [{ type: "thread" }] } },
};

/** Одна панель владеет одной сессией; загрузка HTML не читает проект и не открывает сокеты. */
interface ProjectBinding { readonly root: string | undefined; select(requested?: string, metadata?: Record<string, unknown>): Promise<string> }
export function createCodexPanel(rootOrBinding?: string | ProjectBinding, { stateDirectory, chooseDirectory = chooseProjectDirectory }: { stateDirectory?: string; chooseDirectory?: () => Promise<{ projectRoot: string | null }> } = {}) {
  const binding = rootOrBinding && typeof rootOrBinding === "object" ? Promise.resolve(rootOrBinding) : createProjectBinding(rootOrBinding);
  let session: ReturnType<typeof createArchiViewSession> | null | undefined;
  let closed = false;
  let queue = Promise.resolve();
  const checkOpen = () => { if (closed) throw new ApplicationError("SESSION_CLOSED", "Сессия панели закрыта"); };
  async function service(metadata?: Record<string, unknown>) {
    const project = await binding;
    const root = await project.select(undefined, metadata);
    if (!session) session = createArchiViewSession({ root, stateDirectory }).catch((error) => { session = null; throw error; });
    return session;
  }
  return {
    /** Открытие UI не зависит от готовности контекста пустого чата; ошибки папки затем показывает сама панель. */
    async open(projectRoot?: string, metadata?: Record<string, unknown>) {
      checkOpen();
      const project = await binding;
      try { await project.select(projectRoot, metadata); }
      catch (error) {
        if (!["PROJECT_REQUIRED", "CODEX_CONTEXT_UNAVAILABLE", "PROJECT_UNAVAILABLE"].includes(applicationError(error).code)) throw error;
        const unavailable = applicationError(error).code === "PROJECT_UNAVAILABLE";
        return { content: [{ type: "text" as const, text: unavailable ? applicationError(error).message : "ArchiView: подготовка рабочей папки проекта." }],
          structuredContent: { projectRequired: !unavailable, projectStatus: unavailable ? "unavailable" : "initializing" },
          _meta: { bootstrap: applicationError(error) } };
      }
      const root = project.root;
      return { content: [{ type: "text" as const, text: "ArchiView: " + root }], structuredContent: { root } };
    },
    /** Сериализация операций сохраняет согласованность view и публикации; ошибки тоже доставляются только UI. */
    callUi(name: string, args: unknown, metadata?: Record<string, unknown>) {
      const operation = queue.then(async () => {
        checkOpen();
        validateUiArguments(name, args);
        const method = UI_TOOL_METHODS.get(name);
        if (!method) throw new ApplicationError("INVALID_ARGUMENT", "Неизвестная операция панели");
        if (method === "chooseProject") {
          try { await (await binding).select(undefined, metadata); }
          catch (error) { if (!["PROJECT_REQUIRED", "CODEX_CONTEXT_UNAVAILABLE"].includes(applicationError(error).code)) throw error; }
          return { content: [], _meta: { result: await chooseDirectory() } };
        }
        // Проверка папки не создаёт сессию и не ждёт обхода исходников или истории.
        const result = (method === "getProject" || method === "setProject") ?
          { root: await (await binding).select(method === "setProject" ? args.projectRoot as string : undefined, metadata) } :
          await callSessionOperation(await service(metadata), method, args);
        // Ни content, ни structuredContent не содержат данные просмотра.
        return { content: [], _meta: { result } };
      }).catch((error) => ({ isError: true, content: [], _meta: { error: applicationError(error) } }));
      queue = operation.then(() => {});
      return operation;
    },
    /** Полностью встроенный HTML подключается к хосту даже при запрете любых сетевых соединений UI. */
    async resource() {
      checkOpen();
      const html = (await readFile(new URL("dist/panel.html", packageUrl), "utf8"))
        .replace("<head>", '<head><meta name="archiview-transport" content="mcp"><meta name="archiview-directory-picker" content="' + (process.platform === "win32") + '">')
        .replace('href="/" aria-label="ArchiView"', 'href="#" aria-label="ArchiView"');
      return { contents: [{ uri: PANEL_URI, mimeType: "text/html;profile=mcp-app", text: html,
        _meta: { ui: { csp: { connectDomains: [], resourceDomains: [] } },
          "openai/widgetCSP": { connect_domains: [], resource_domains: [] },
          "openai/ui": { availableDisplayModes: ["inline", "fullscreen"] } } }] };
    },
    /** После отключения хоста новые операции отклоняются; уже начатая запись безопасно завершается. */
    async close() { closed = true; await queue; session = null; },
  };
}
