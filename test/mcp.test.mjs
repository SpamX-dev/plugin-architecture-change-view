/** Проверяет настоящий MCP handshake, ресурсы skill:// и инструменты чтения. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parse } from "yaml";

test("serves a matching skill descriptor and read-only module tools over stdio", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "module-mcp-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "module.md"), "Root responsibility");
  await writeFile(path.join(root, "src/main.js"), "export const main = 1;");
  const client = new Client({ name: "module-test", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL("../src/server.mjs", import.meta.url)), "--root", root],
    stderr: "pipe" });
  t.after(() => client.close());
  await client.connect(transport);
  assert.equal(client.getServerVersion().name, "plugin-architecture-change-view");
  const listed = await client.listResources();
  assert.equal(listed.resources.length, 1);
  const descriptor = listed.resources[0];
  const resource = await client.readResource({ uri: descriptor.uri });
  const text = resource.contents[0].text;
  const metadata = parse(/^---\n([\s\S]*?)\n---/.exec(text)[1]);
  assert.equal(descriptor.uri, "skill://" + metadata.name);
  assert.equal(descriptor.name, metadata.name);
  assert.equal(descriptor.description, metadata.description);
  await assert.rejects(client.readResource({ uri: "skill://missing" }), /Unknown resource/);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((tool) => tool.name),
    ["module_inventory", "module_context"]);
  assert.ok(tools.tools.every((tool) => tool.annotations.readOnlyHint));
  const coverage = await client.callTool({ name: "module_inventory", arguments: {} });
  const inventory = JSON.parse(coverage.content[0].text);
  assert.equal(inventory.complete, true);
  assert.equal(inventory.modules.find((entry) => entry.directory === "src").status,
    "missing");
  const context = await client.callTool({ name: "module_context",
    arguments: { directory: "src" } });
  assert.equal(JSON.parse(context.content[0].text).contracts[0].text,
    "Root responsibility");
  const outside = await client.callTool({ name: "module_context",
    arguments: { directory: "../" } });
  assert.equal(outside.isError, true);
  await assert.rejects(client.callTool({ name: "module_inventory",
    arguments: { directory: "src" } }), /Invalid tool arguments/);
});
