/** Opt-in real-browser acceptance, sharing the normal Node test runner. */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const child = spawn(process.execPath, ["--import", import.meta.resolve("tsx"), "--test", "test/web-browser.test.ts"], {
  cwd: fileURLToPath(new URL("../", import.meta.url)),
  windowsHide: true,
  stdio: "inherit",
  env: { ...process.env, ARCHIVIEW_BROWSER_TEST: "1" },
});
child.once("error", (error) => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
child.once("exit", (code) => { process.exitCode = code ?? 1; });
