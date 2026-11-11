/** Compile browser sources without publishing TypeScript to installed plugins. */
import { build } from "esbuild";
import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export async function buildWeb(root = new URL("../", import.meta.url), output = new URL("dist/web/", root)) {
  const directory = new URL("archiview/", output);
  await mkdir(directory, { recursive: true });
  await build({
    absWorkingDir: fileURLToPath(root),
    entryPoints: {
      app: "web/archiview/web-entry.ts",
      client: "web/archiview/client.ts",
      review: "web/archiview/review.ts",
      "panel-bridge": "web/archiview/panel-bridge.ts",
    },
    outdir: fileURLToPath(directory), outExtension: { ".js": ".mjs" },
    bundle: true, platform: "browser", target: "es2022", format: "esm",
  });
  for (const name of ["index.html", "styles.css", "arch.yaml"]) {
    await cp(new URL(`web/archiview/${name}`, root), new URL(name, directory));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await buildWeb();
