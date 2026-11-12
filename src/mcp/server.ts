#!/usr/bin/env node
/**
 * Stdio MCP-сервер контрактов проекта. Раздаёт канонический SKILL.md и инструменты
 * чтения; явный --panel добавляет локальное MCP App со скрытыми от модели операциями UI.
 * Рабочий проект задаётся явно, контекстом рабочей папки Codex или cwd вне плагина.
 */
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema,
  ListResourcesRequestSchema, ReadResourceRequestSchema,
  ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { parse } from "yaml";
import { moduleContext, moduleInventory, SOURCE_EXTENSIONS } from "../contracts/inventory.js";
import { createCodexPanel, PANEL_URI, PANEL_TOOL, PROJECT_INPUT } from "../codex/panel.js";
import { createProjectBinding } from "../application/project.js";
import { createCodexProjectBinding } from "../codex/project-context.js";
import { UI_TOOLS, UI_TOOL_METHODS } from "../codex/ui-tools.js";
import { packageUrl } from "../runtime/package-paths.js";

/** Версионированная метаинформация пакета для MCP initialize. */
const packageValue: unknown = JSON.parse(await readFile(new URL("package.json", packageUrl), "utf8"));
if (!packageValue || typeof packageValue !== "object" || !("name" in packageValue) || typeof packageValue.name !== "string" ||
    !("version" in packageValue) || typeof packageValue.version !== "string") throw new Error("Invalid package metadata");
const packageInfo = { name: packageValue.name, version: packageValue.version };
/** Параметры запуска; повторяемый --extension добавляет расширения исходников. */
const { values } = parseArgs({ options: {
  root: { type: "string" }, extension: { type: "string", multiple: true },
  "max-files": { type: "string", default: "50000" },
  help: { type: "boolean", short: "h" },
  panel: { type: "boolean" },
} });
if (values.help) {
  process.stdout.write(packageInfo.name + " [--root DIR] [--extension .ext] " +
    "[--max-files 50000] [--panel]\n");
} else {
  await serve();
}

/** Создаёт каталог ресурсов и обработчики SDK; stdout резервируется протоколу. */
async function serve() {
  // Portable plugins запускаются с cwd=PLUGIN_ROOT. Этот cwd нельзя выдавать за проект.
  const bindProject = values.panel ? createCodexProjectBinding : createProjectBinding;
  const project = await bindProject(values.root ?? process.env.PLUGIN_ARCHITECTURE_CHANGE_VIEW_ROOT ??
    (process.env.PLUGIN_ROOT ? undefined : process.cwd()));
  const maxFiles = Number(values["max-files"]);
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) {
    throw new Error("--max-files must be a positive integer");
  }
  const extensions = new Set(SOURCE_EXTENSIONS);
  for (const extension of values.extension ?? []) {
    if (!/^\.[a-z0-9]+$/i.test(extension)) throw new Error("Invalid source extension");
    extensions.add(extension.toLowerCase());
  }
  const text = await readFile(new URL("skills/module-boundaries/SKILL.md", packageUrl), "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!frontmatter) throw new Error("Skill frontmatter is missing");
  const metadataValue: unknown = parse(frontmatter[1]);
  if (!metadataValue || typeof metadataValue !== "object" || !("name" in metadataValue) || typeof metadataValue.name !== "string" ||
      !("description" in metadataValue) || typeof metadataValue.description !== "string") throw new Error("Invalid skill metadata");
  const metadata = { name: metadataValue.name, description: metadataValue.description };
  const uri = "skill://" + metadata.name;
  const panel = values.panel ? createCodexPanel(project) : null;
  const server = new Server({ name: packageInfo.name, version: packageInfo.version },
    { capabilities: { resources: {}, tools: {} },
      instructions: "For source-code changes, read skill://module-boundaries. " +
        "Use module_inventory to find repositories and module_context with a workspace-relative source path " +
        "to read the owning repository's contracts, root first. Maintain that repository's .archiview/modules.tree and .archiview/modules/<id>.yaml " +
        "with your file tools. Analyze source when a contract is missing. " +
        "Responsibility changes require user agreement." });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri, name: metadata.name, description: metadata.description,
      mimeType: "text/markdown" }, ...(panel ? [{ uri: PANEL_URI, name: "ArchiView", mimeType: "text/html;profile=mcp-app" }] : [])],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (panel && request.params.uri === PANEL_URI) return panel.resource();
    if (request.params.uri !== uri) {
      throw new McpError(ErrorCode.InvalidParams, "Unknown resource: " + request.params.uri);
    }
    return { contents: [{ uri, mimeType: "text/markdown", text }] };
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    ...(panel ? [PANEL_TOOL, ...UI_TOOLS] : []),
    { name: "module_inventory",
      description: "List repositories, source directories and mapped contracts in the workspace, including " +
        "missing or invalid entries in .archiview/modules.tree and contract files. " +
        "Presence is not a semantic compliance verdict. Read skill://module-boundaries.",
      inputSchema: { type: "object", properties: { projectRoot: PROJECT_INPUT }, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    { name: "module_context",
      description: "Find the Git repository owning a source file or directory and read its contract chain, root first. " +
        "Use before editing source code. Reports missing documents explicitly.",
      inputSchema: { type: "object", properties: { projectRoot: PROJECT_INPUT,
        path: { type: "string", description: "File or directory relative to the chat workspace, e.g. backend/src/main.ts." },
        directory: { type: "string", description: "Alternative to path for existing callers. Defaults to the workspace root." } },
        additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    const name = request.params.name;
    if (panel && UI_TOOL_METHODS.has(name)) return panel.callUi(name, args, request.params._meta);
    if (panel && name === PANEL_TOOL.name) {
      if (Object.keys(args).some((key) => key !== "projectRoot") ||
          (args.projectRoot !== undefined && typeof args.projectRoot !== "string")) throw new McpError(ErrorCode.InvalidParams, "Invalid tool arguments");
      try { return await panel.open(args.projectRoot, request.params._meta); }
      catch (error) { return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] }; }
    }
    if (name !== "module_inventory" && name !== "module_context") {
      throw new McpError(ErrorCode.InvalidParams, "Unknown tool: " + name);
    }
    const allowed = name === "module_context" ? ["path", "directory", "projectRoot"] : ["projectRoot"];
    if (Object.keys(args).some((key) => !allowed.includes(key)) ||
        (args.path !== undefined && (typeof args.path !== "string" || args.directory !== undefined)) ||
        (args.directory !== undefined && typeof args.directory !== "string") ||
        (args.projectRoot !== undefined && typeof args.projectRoot !== "string")) {
      throw new McpError(ErrorCode.InvalidParams, "Invalid tool arguments");
    }
    try {
      const root = await project.select(args.projectRoot, request.params._meta);
      const result = name === "module_inventory"
        ? await moduleInventory(root, { extensions, maxFiles })
        : await moduleContext(root, args.path ?? args.directory);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
    }
  });
  if (panel) server.onclose = () => { panel.close().catch(() => {}); };
  await server.connect(new StdioServerTransport());
}
