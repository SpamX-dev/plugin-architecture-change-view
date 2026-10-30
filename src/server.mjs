#!/usr/bin/env node
/**
 * Stdio MCP-сервер правил module.md. Раздаёт единственный канонический SKILL.md
 * по контракту skill:// и предоставляет только читающие инструменты.
 * Рабочий проект задаётся --root, PLUGIN_ARCHITECTURE_CHANGE_VIEW_ROOT или cwd.
 */
import { readFile, realpath } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema,
  ListResourcesRequestSchema, ReadResourceRequestSchema,
  ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { parse } from "yaml";
import { moduleContext, moduleInventory, SOURCE_EXTENSIONS } from "./inventory.mjs";

/** Версионированная метаинформация пакета для MCP initialize. */
const packageInfo = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
/** Параметры запуска; повторяемый --extension добавляет расширения исходников. */
const { values } = parseArgs({ options: {
  root: { type: "string" }, extension: { type: "string", multiple: true },
  "max-files": { type: "string", default: "50000" },
  help: { type: "boolean", short: "h" },
} });
if (values.help) {
  process.stdout.write(packageInfo.name + " [--root DIR] [--extension .ext] " +
    "[--max-files 50000]\n");
} else {
  await serve();
}

/** Создаёт каталог ресурсов и обработчики SDK; stdout резервируется протоколу. */
async function serve() {
  const root = await realpath(values.root ?? process.env.PLUGIN_ARCHITECTURE_CHANGE_VIEW_ROOT ??
    process.cwd());
  const maxFiles = Number(values["max-files"]);
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) {
    throw new Error("--max-files must be a positive integer");
  }
  const extensions = new Set(SOURCE_EXTENSIONS);
  for (const extension of values.extension ?? []) {
    if (!/^\.[a-z0-9]+$/i.test(extension)) throw new Error("Invalid source extension");
    extensions.add(extension.toLowerCase());
  }
  const text = await readFile(new URL(
    "../skills/module-boundaries/SKILL.md", import.meta.url), "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  if (!frontmatter) throw new Error("Skill frontmatter is missing");
  const metadata = parse(frontmatter[1]);
  const uri = "skill://" + metadata.name;
  const server = new Server({ name: packageInfo.name, version: packageInfo.version },
    { capabilities: { resources: {}, tools: {} },
      instructions: "For source-code changes, read skill://module-boundaries. " +
        "Use module_inventory to find missing module.md contracts and module_context " +
        "to read target and ancestor boundaries. Tools are read-only; write documents " +
        "with your file tools. Responsibility changes require user agreement." });
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [{ uri, name: metadata.name, description: metadata.description,
      mimeType: "text/markdown" }],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== uri) {
      throw new McpError(ErrorCode.InvalidParams, "Unknown resource: " + request.params.uri);
    }
    return { contents: [{ uri, mimeType: "text/markdown", text }] };
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: "module_inventory",
      description: "List every source directory and module.md coverage, including " +
        "missing/empty contracts, source-container directories and planned modules. " +
        "Presence is not a semantic compliance verdict. Read skill://module-boundaries.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    { name: "module_context",
      description: "Read module.md for a target directory and all ancestors, root first. " +
        "Use before editing source code. Reports missing documents explicitly.",
      inputSchema: { type: "object", properties: { directory: {
        type: "string", description: "Project-relative directory; default is ." } },
        additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const args = request.params.arguments ?? {};
    const name = request.params.name;
    if (name !== "module_inventory" && name !== "module_context") {
      throw new McpError(ErrorCode.InvalidParams, "Unknown tool: " + name);
    }
    const allowed = name === "module_context" ? ["directory"] : [];
    if (Object.keys(args).some((key) => !allowed.includes(key)) ||
        (args.directory !== undefined && typeof args.directory !== "string")) {
      throw new McpError(ErrorCode.InvalidParams, "Invalid tool arguments");
    }
    try {
      const result = name === "module_inventory"
        ? await moduleInventory(root, { extensions, maxFiles })
        : await moduleContext(root, args.directory);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  });
  await server.connect(new StdioServerTransport());
}
