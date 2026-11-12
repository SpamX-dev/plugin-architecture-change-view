/** Compile browser sources without publishing TypeScript to installed plugins. */
import { build } from "esbuild";
import { spawnSync } from "node:child_process";
import { cp, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function buildWeb(root = new URL("../", import.meta.url), output = new URL("dist/web/", root), packageWeb?: URL) {
  const compiler = new URL("./bin/tsc", import.meta.resolve("typescript/package.json"));
  const check = spawnSync(process.execPath, [fileURLToPath(compiler), "--project", fileURLToPath(new URL("tsconfig.json", root)), "--noEmit"],
    { cwd: root, stdio: "inherit", windowsHide: true });
  if (check.error) throw check.error;
  if (check.status !== 0) throw new Error("ArchiView TypeScript check failed");
  const directory = new URL("archiview/", output);
  const entryPoints = {
    app: "web/archiview/web-entry.ts", client: "web/archiview/client.ts",
    review: "web/archiview/review.ts", "panel-bridge": "web/archiview/panel-bridge.ts",
  };
  const result = await build({
    absWorkingDir: fileURLToPath(root),
    entryPoints,
    outdir: fileURLToPath(directory), outExtension: { ".js": ".mjs" },
    bundle: true, write: false, platform: "browser", target: "es2022", format: "esm",
  });
  const destinations = packageWeb ? [directory, new URL("archiview/", packageWeb)] : [directory];
  for (const destination of destinations) {
    await mkdir(destination, { recursive: true });
    for (const file of result.outputFiles) {
      await writeFile(new URL(path.basename(file.path), destination), file.contents);
    }
    for (const name of ["index.html", "styles.css", "favicon.svg"]) {
      await cp(new URL(`web/archiview/${name}`, root), new URL(name, destination));
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await buildWeb();
