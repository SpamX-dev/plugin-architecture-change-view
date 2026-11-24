/** Opt-in real-browser acceptance, sharing the normal Node test runner. */
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// Playwright installations and local Windows browsers both support these standalone scenarios.
const binaries = process.platform === "win32" ?
  [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA]
    .filter((directory): directory is string => Boolean(directory))
    .flatMap(directory => ["Google/Chrome/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe"]
      .map(executable => path.join(directory, executable))) : [];
const executable = process.env.ARCHIVIEW_CHROMIUM_PATH || [chromium.executablePath(), ...binaries].find(file => existsSync(file));

const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--test", "test/web-browser.test.ts"], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  windowsHide: true,
  stdio: "inherit",
  env: { ...process.env, ARCHIVIEW_BROWSER_TEST: "1", ARCHIVIEW_CHROMIUM_PATH: executable },
});
child.once("error", (error) => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
