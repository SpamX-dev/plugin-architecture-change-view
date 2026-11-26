import { build } from "esbuild";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWeb } from "./build-web.js";

const root = new URL("../", import.meta.url);
const output = new URL("dist/", root);
await buildWeb(root);
for (const [host, entry] of [["codex", "server"], ["dsh", "host"]]) {
  const folder = new URL("bridges/" + host + "/", output);
  await mkdir(folder, { recursive: true });
  await build({ entryPoints: [fileURLToPath(new URL("bridges/" + host + "/" + entry + ".ts", root))],
    outfile: fileURLToPath(new URL(entry + ".mjs", folder)), platform: "node", format: "esm", target: "node22", bundle: true });
}
for (const file of ["package.json", "cordis.patch.yml"]) {
  await copyFile(new URL("bridges/dsh/" + file, root), new URL("bridges/dsh/" + file, output));
}
await build({entryPoints:[fileURLToPath(new URL("bridges/dsh/session-hooks.ts", root))],
  outfile:fileURLToPath(new URL("bridges/dsh/session-hooks.mjs", output)), platform:"node", format:"esm", target:"node22", bundle:true});
await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: ["cli/packaged-cli.ts"],
  outfile: fileURLToPath(new URL("cli.mjs", output)),
  bundle: true, format: "esm", platform: "node", target: "node22",
  define: { ARCHIVIEW_SCIP_WORKER: '"./scip/indexer.mjs"', ARCHIVIEW_SCIP_COMPILER: '"./scip/compiler.mjs"' },
  banner: { js: 'import { createRequire as makeArchRequire } from "node:module"; const require = makeArchRequire(import.meta.url);' },
});
// Keep the compiler out of the server process. Its standard library is resolved
// beside the running compiler, including in a standalone copy of dist/.
const require = createRequire(import.meta.url);
const worker = require.resolve("@sourcegraph/scip-typescript");
const workerRequire = createRequire(worker);
const workerDirectory = new URL("scip/", output);
await build({
  entryPoints: { indexer: worker, compiler: workerRequire.resolve("typescript") },
  outdir: fileURLToPath(workerDirectory), splitting: true, chunkNames: "shared-[name]", outExtension: { ".js": ".mjs" },
  bundle: true, format: "esm", platform: "node", target: "node22", legalComments: "linked",
  plugins: [{
    name: "standalone-svelte-shim",
    setup(builder) {
      // The indexer resolves this declaration at runtime when a TS project also contains Svelte.
      builder.onLoad({ filter: /[\\/]scip-typescript[\\/]dist[\\/]src[\\/]Svelte\.js$/ }, async ({ path: source }) => ({
        contents: (await readFile(source, "utf8")).replace("'svelte2tsx/svelte-shims-v4.d.ts'", "'./svelte-shims-v4.d.ts'"),
        loader: "js",
      }));
    },
  }],
  banner: { js: 'import { createRequire as makeScipRequire } from "node:module"; import { fileURLToPath as scipPath } from "node:url"; import { dirname as scipDir } from "node:path"; const require = makeScipRequire(import.meta.url), __filename = scipPath(import.meta.url), __dirname = scipDir(__filename);' },
});
await copyFile(workerRequire.resolve("svelte2tsx/svelte-shims-v4.d.ts"), new URL("svelte-shims-v4.d.ts", workerDirectory));
await copyFile(path.join(path.dirname(require.resolve("@sourcegraph/scip-typescript/package.json")), "LICENSE"), new URL("scip-typescript-LICENSE.txt", workerDirectory));
const compilerDirectory = path.dirname(workerRequire.resolve("typescript"));
for (const notice of ["LICENSE.txt", "ThirdPartyNoticeText.txt"]) {
  await copyFile(path.join(compilerDirectory, "..", notice), new URL("typescript-" + notice, workerDirectory));
}
for (const name of await readdir(compilerDirectory)) {
  if (/^lib[.\w-]*\.d\.ts$/.test(name)) await copyFile(path.join(compilerDirectory, name), new URL(name, workerDirectory));
}
const manifest = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
const { name, version, type, license, engines } = manifest;
const files = (manifest.files as string[]).filter(file => file.startsWith("dist/")).map(file => file.slice("dist/".length));
await writeFile(new URL("package.json", output), JSON.stringify({ name, version, type, license, engines, files, bin: { archiview: "cli.mjs" } }, null, 2) + "\n");
await mkdir(new URL("docs/", output), { recursive: true });
await mkdir(new URL("skills/module-boundaries/", output), { recursive: true });
for (const file of ["LICENSE", "skills/module-boundaries/SKILL.md", "docs/report-format-v2.md", "docs/arch-review-format-v1.md", "docs/module-roles.md", "docs/report-storage-and-compaction-design.md"]) {
  await copyFile(new URL(file, root), new URL(file, output));
}
