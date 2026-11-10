/**
 * Переносимый Windows x64-пакет включает плагин, локальный marketplace,
 * установщик и Node с лицензией. ZIP не содержит настроек исходной машины.
 * Повторная сборка заменяет только свой явно проверенный каталог внутри dist.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Build this Windows x64 package using Node x64 on Windows.");
await import("./build-plugin.mjs");
const root = fileURLToPath(new URL("../", import.meta.url));
const dist = path.resolve(root, "dist");
const manifest = JSON.parse(await readFile(path.join(dist, "codex", ".codex-plugin", "plugin.json"), "utf8"));
if (!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version)) throw new Error("Invalid portable package version");
const name = "archiview-codex-" + manifest.version + "-windows-x64";
const output = path.resolve(dist, name), archive = path.resolve(dist, name + ".zip");
if (path.dirname(output) !== dist || path.dirname(archive) !== dist) throw new Error("Portable output must stay inside dist");

// Лицензия соответствует ровно тому Node, чей исполняемый файл включён в архив.
const licenseUrl = "https://raw.githubusercontent.com/nodejs/node/v" + process.versions.node + "/LICENSE";
const response = await fetch(licenseUrl);
if (!response.ok) throw new Error("Cannot retrieve the bundled Node license: " + response.status);
const license = await response.text();
if (!license.includes("Node.js") || !license.includes("Permission is hereby granted")) throw new Error("Unexpected Node license document");
await rm(output, { recursive: true, force: true });
await mkdir(path.join(output, "scripts"), { recursive: true });
await cp(path.join(dist, "codex"), path.join(output, "plugin"), { recursive: true });
await mkdir(path.join(output, "plugin", "runtime"));
await copyFile(process.execPath, path.join(output, "plugin", "runtime", "node.exe"));
await writeFile(path.join(output, "plugin", "runtime", "LICENSE.txt"), license);
await writeFile(path.join(output, "plugin", "runtime", "VERSION.txt"), process.version + " windows-x64\n" + licenseUrl + "\n");
const configurationPath = path.join(output, "plugin", ".mcp.json");
const configuration = JSON.parse(await readFile(configurationPath, "utf8"));
configuration.mcpServers.archiview.command = "${PLUGIN_ROOT}/runtime/node.exe";
await writeFile(configurationPath, JSON.stringify(configuration, null, 2) + "\n");
for (const file of ["install-plugin.mjs", "install-portable.mjs"]) await copyFile(path.join(root, "scripts", file), path.join(output, "scripts", file));
await copyFile(path.join(root, "scripts", "install-portable.ps1"), path.join(output, "Install.ps1"));
await mkdir(path.join(output, ".agents", "plugins"), { recursive: true });
await writeFile(path.join(output, ".agents", "plugins", "marketplace.json"), JSON.stringify({
  name: "archiview-local", plugins: [{ name: "archiview", source: { source: "local", path: "./plugin" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" }, category: "Developer Tools" }],
}, null, 2) + "\n");
await writeFile(path.join(output, "INSTALL.md"), [
  "# ArchiView " + manifest.version + " — Windows x64", "",
  "На ноутбуке должно быть установлено приложение Codex для Windows. Node.js " + process.version + " включён в пакет; npm и отдельная установка Node.js не нужны.", "",
  "1. Распакуйте ZIP в постоянную папку, например `C:\\Tools\\ArchiView`.",
  "2. Откройте PowerShell в распакованной папке, рядом с `Install.ps1`.",
  "3. Выполните:", "", "```powershell", "powershell -NoProfile -ExecutionPolicy Bypass -File .\\Install.ps1", "```", "",
  "4. Перезапустите Codex и откройте ArchiView в чате с выбранной папкой проекта.", "",
  "Скрипт регистрирует эту папку как локальный marketplace, устанавливает плагин в кеш Codex и настраивает пути на этом компьютере. Сохраните распакованную папку для последующего обновления.", "",
  "Если Codex установлен нестандартно, перед запуском задайте `$env:ARCHIVIEW_CODEX_EXECUTABLE = 'C:\\путь\\к\\codex.exe'`.", "",
].join("\n"));

// .NET включает в ZIP служебные каталоги .agents и .codex-plugin вместе с остальными файлами.
await rm(archive, { force: true });
const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
await promisify(execFile)(powershell, ["-NoProfile", "-NonInteractive", "-Command",
  "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:ARCHIVIEW_PACKAGE_SOURCE, $env:ARCHIVIEW_PACKAGE_ZIP, [System.IO.Compression.CompressionLevel]::Optimal, $true)"], {
  windowsHide: true, env: { ...process.env, ARCHIVIEW_PACKAGE_SOURCE: output, ARCHIVIEW_PACKAGE_ZIP: archive },
});
const checksum = createHash("sha256").update(await readFile(archive)).digest("hex");
await writeFile(archive + ".sha256", checksum + "  " + path.basename(archive) + "\n");
process.stdout.write(JSON.stringify({ archive, bytes: (await stat(archive)).size, sha256: checksum, node: process.version }, null, 2) + "\n");
