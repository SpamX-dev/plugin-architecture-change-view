/** Адаптер MCP Apps: собранный UI и скрытые операции прикладного сервиса, без HTTP-сервера. */
import { readFile } from "node:fs/promises";
import { createArchiViewSession } from "../application/session.mjs";
import { createProjectBinding } from "../application/project.mjs";
import { applicationError, ApplicationError } from "../application/errors.mjs";
import { packageUrl } from "../package-paths.mjs";
import { UI_TOOL_METHODS, validateUiArguments } from "./ui-tools.mjs";

export const PANEL_URI = "ui://archiview/panel-v4.html";
export const PROJECT_INPUT = { type: "string", description: "Absolute project directory of the current chat, not the plugin installation. Required until this process is bound to a project." };
export const PANEL_TOOL = {
  name: "archiview_open", title: "ArchiView",
  description: "Open the local architecture panel for this project. Browsing stays in the UI; only an explicit Analyze action sends a request to the agent.",
  inputSchema: { type: "object", properties: { projectRoot: PROJECT_INPUT }, additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  _meta: { ui: { resourceUri: PANEL_URI }, "openai/ui": { entrypoints: [{ type: "thread" }, { type: "global" }] } },
};

/** Одна панель владеет одной сессией; загрузка HTML не читает проект и не открывает сокеты. */
export function createCodexPanel(rootOrBinding, { stateDirectory } = {}) {
  const binding = rootOrBinding && typeof rootOrBinding.select === "function" ? Promise.resolve(rootOrBinding) : createProjectBinding(rootOrBinding);
  let session;
  let closed = false;
  let queue = Promise.resolve();
  const checkOpen = () => { if (closed) throw new ApplicationError("SESSION_CLOSED", "Сессия панели закрыта"); };
  async function service() {
    const project = await binding;
    const root = await project.select();
    if (!session) session = createArchiViewSession({ root, stateDirectory }).catch((error) => { session = null; throw error; });
    return session;
  }
  return {
    /** Публичный инструмент сообщает только выбранный корень; большие данные остаются внутри UI. */
    async open(projectRoot) {
      checkOpen();
      const project = await binding;
      if (projectRoot !== undefined) await project.select(projectRoot);
      const root = project.root;
      if (!root) return { content: [{ type: "text", text: "Выберите папку проекта в панели или передайте projectRoot." }], structuredContent: { projectRequired: true } };
      return { content: [{ type: "text", text: "ArchiView: " + root }], structuredContent: { root } };
    },
    /** Сериализация операций сохраняет согласованность view и публикации; ошибки тоже доставляются только UI. */
    callUi(name, args) {
      const operation = queue.then(async () => {
        checkOpen();
        validateUiArguments(name, args);
        const method = UI_TOOL_METHODS.get(name);
        const result = method === "setProject" ? { root: await (await binding).select(args.projectRoot) } :
          await (await service())[method](args);
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
        .replace("<head>", '<head><meta name="archiview-transport" content="mcp">')
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
