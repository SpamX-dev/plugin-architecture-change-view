import { callSessionOperation } from "../application/arguments.js";
/** Адаптер MCP Apps: собранный UI и скрытые операции прикладного сервиса, без HTTP-сервера. */
import { readFile } from "node:fs/promises";
import { createWorkspaceSession } from "../application/workspace-session.js";
import { createProjectBinding } from "../application/project.js";
import { applicationError, ApplicationError } from "../application/errors.js";
import { packageUrl } from "../runtime/package-paths.js";
import { UI_TOOL_METHODS, validateUiArguments } from "./ui-tools.js";
import { chooseProjectDirectory } from "./directory-picker.js";

export const PANEL_URI = "ui://archiview/panel-v7.html";
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
  let session: ReturnType<typeof createWorkspaceSession> | null | undefined;
  let closed = false;
  const lifetime = new AbortController();
  let projectSelection = Promise.resolve();
  let mutations = Promise.resolve();
  const reads = new Set<Promise<void>>();
  const checkOpen = () => { if (closed) throw new ApplicationError("SESSION_CLOSED", "Сессия панели закрыта"); };
  async function service(metadata?: Record<string, unknown>) {
    const project = await binding;
    const root = await project.select(undefined, metadata);
    if (!session) session = createWorkspaceSession({ root, stateDirectory }).catch((error) => { session = null; throw error; });
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
        return { content: [{ type: "text" as const, text: unavailable ? "ArchiView: выберите папку проекта." : "ArchiView: подготовка рабочей папки проекта." }],
          structuredContent: { projectRequired: true, projectStatus: unavailable ? "unavailable" : "initializing" },
          _meta: { bootstrap: applicationError(error) } };
      }
      const root = project.root;
      return { content: [{ type: "text" as const, text: "ArchiView: " + root }], structuredContent: { root } };
    },
    /** A published tree and its cards can be read while another checkout refreshes. Bind the project before routing either request. */
    callUi(name: string, args: unknown, metadata?: Record<string, unknown>) {
      const method = UI_TOOL_METHODS.get(name);
      const selectsProject = method === "setProject" || method === "chooseProject" || method === "getProject";
      const read = method === "waitForChanges" || method === "getReviewStatuses" || method === "getModule" || method === "getComparison";
      const ready = read || selectsProject ? projectSelection : Promise.all([projectSelection, mutations]);
      const operation = ready.then(async () => {
        checkOpen();
        validateUiArguments(name, args);
        if (!method) throw new ApplicationError("INVALID_ARGUMENT", "Неизвестная операция панели");
        if (method === "chooseProject") {
          try { await (await binding).select(undefined, metadata); }
          catch (error) { if (!["PROJECT_REQUIRED", "CODEX_CONTEXT_UNAVAILABLE", "PROJECT_UNAVAILABLE"].includes(applicationError(error).code)) throw error; }
          return { content: [], _meta: { result: await chooseDirectory() } };
        }
        // Проверка папки не создаёт сессию и не ждёт обхода исходников или истории.
        const result = (method === "getProject" || method === "setProject") ?
          { root: await (await binding).select(method === "setProject" ? args.projectRoot as string : undefined, metadata) } :
          await callSessionOperation(await service(metadata), method, args, lifetime.signal);
        // Ни content, ни structuredContent не содержат данные просмотра.
        return { content: [], _meta: { result } };
      }).catch((error) => ({ isError: true, content: [], _meta: { error: applicationError(error) } }));
      const finished = operation.then(() => {});
      if (selectsProject) {
        projectSelection = finished;
      } else if (read) {
        reads.add(finished);
        void finished.then(() => reads.delete(finished));
      } else {
        mutations = finished;
      }
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
    async close() { closed = true; lifetime.abort(); await Promise.all([projectSelection, mutations, ...reads]); await (await session)?.close(); session = null; },
  };
}
