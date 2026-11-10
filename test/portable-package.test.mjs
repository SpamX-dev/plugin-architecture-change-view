/** Проверяет настоящий перенос ZIP и установку без Node, npm или Codex в PATH. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("portable Windows ZIP installs its bundled Node after relocation without system Node or npm", {
  skip: process.platform !== "win32" || !process.env.ARCHIVIEW_PORTABLE_TEST_ARCHIVE, timeout: 60000,
}, async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "archiview-portable-"));
  const client = new Client({ name: "portable-archive-test", version: "1" });
  t.after(async () => {
    await client.close();
    await rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const archive = path.resolve(process.env.ARCHIVIEW_PORTABLE_TEST_ARCHIVE);
  const extracted = path.join(temporary, "Перенос с пробелами");
  const profile = path.join(temporary, "profile"), project = path.join(temporary, "project");
  await mkdir(profile); await mkdir(project);
  const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const env = { ...process.env, CODEX_HOME: profile, USERPROFILE: profile,
    ARCHIVIEW_PACKAGE_ZIP: archive, ARCHIVIEW_PACKAGE_EXTRACT: extracted };
  for (const key of Object.keys(env)) if (["path", "archiview_codex_executable", "codex_app_tools_pipe_path", "codex_app_tools_caller_host_id"].includes(key.toLowerCase())) delete env[key];
  env.PATH = temporary;
  await promisify(execFile)(powershell, ["-NoProfile", "-NonInteractive", "-Command",
    "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:ARCHIVIEW_PACKAGE_ZIP, $env:ARCHIVIEW_PACKAGE_EXTRACT)"], { env, windowsHide: true });
  const root = path.join(extracted, path.basename(archive, ".zip"));
  const marketplace = JSON.parse(await readFile(path.join(root, ".agents", "plugins", "marketplace.json"), "utf8"));
  assert.equal(marketplace.plugins[0].source.path, "./plugin");
  const original = await readFile(path.join(root, "plugin", ".mcp.json"), "utf8");
  assert.equal(JSON.parse(original).mcpServers.archiview.command, "${PLUGIN_ROOT}/runtime/node.exe");
  const { stdout } = await promisify(execFile)(powershell, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
    "-File", path.join(root, "Install.ps1")], { cwd: root, env, windowsHide: true });
  const installed = JSON.parse(stdout.slice(0, stdout.lastIndexOf("}") + 1));
  assert.equal(installed.pluginId, "archiview@archiview-local");
  assert.equal(installed.mcpPathsResolved, true);
  const relative = path.relative(profile, installed.installedPath);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "installation stays in the isolated test profile");
  const configuration = JSON.parse(await readFile(path.join(installed.installedPath, ".mcp.json"), "utf8"));
  const server = configuration.mcpServers.archiview;
  assert.equal(server.command, path.join(installed.installedPath, "runtime", "node.exe"));
  assert.equal(server.cwd, undefined);
  assert.equal(await readFile(path.join(root, "plugin", ".mcp.json"), "utf8"), original);
  assert.match(await readFile(path.join(installed.installedPath, "runtime", "LICENSE.txt"), "utf8"), /Node\.js/);
  await client.connect(new StdioClientTransport({ command: server.command, args: server.args,
    cwd: project, env: { ...env, ...server.env }, stderr: "pipe" }));
  const entrypoint = (await client.listTools()).tools.find((tool) => tool.name === "archiview_open");
  assert.deepEqual(entrypoint._meta["openai/ui"].entrypoints, [{ type: "thread" }]);
});
