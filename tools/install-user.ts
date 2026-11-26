import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// npm supplies its actual CLI entry point on every supported platform.
const npm = process.env.npm_execpath;
if (!npm) throw new Error("Запустите установку через npm run install:user.");
const prefix = path.join(homedir(), ".archiview", "npm");
const distribution = fileURLToPath(new URL("../dist/", import.meta.url));
execFileSync(process.execPath, [npm, "install", "--global", "--prefix", prefix,
  "--install-links", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", distribution],
  { stdio: "inherit", windowsHide: true });
const launcher = process.platform === "win32" ? "archiview.cmd" : "bin/archiview";
console.log("ArchiView установлен: " + path.join(prefix, launcher));
