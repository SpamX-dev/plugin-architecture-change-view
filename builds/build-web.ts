import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export async function buildWeb(root = new URL("../", import.meta.url)) {
  const assets = new URL("dist/web/archiview/", root);
  await mkdir(assets, { recursive: true });
  await build({
    absWorkingDir: fileURLToPath(root),
    entryPoints: {
      app: "web/web-ui/web-entry.ts",
      client: "web/web-ui/archiview-client/client.ts",
      review: "web/web-ui/views/review.ts",
    },
    outdir: fileURLToPath(assets),
    outExtension: { ".js": ".mjs" },
    bundle: true, platform: "browser", target: "es2022", format: "esm",
  });
  for (const name of ["index.html", "styles.css", "favicon.svg"]) {
    await copyFile(new URL("web/web-ui/views/" + name, root), new URL(name, assets));
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await buildWeb();
