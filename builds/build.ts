import { build } from "esbuild";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { buildWeb } from "./build-web.js";

const root = new URL("../", import.meta.url);
const output = new URL("dist/", root);
await buildWeb(root);
await build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: ["cli/packaged-cli.ts"],
  outfile: fileURLToPath(new URL("cli.mjs", output)),
  bundle: true, format: "esm", platform: "node", target: "node22",
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});
const { name, version, type, license, engines } = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
await writeFile(new URL("package.json", output), JSON.stringify({ name, version, type, license, engines, bin: { archiview: "cli.mjs" } }, null, 2) + "\n");
await mkdir(new URL("docs/", output), { recursive: true });
await mkdir(new URL("skills/module-boundaries/", output), { recursive: true });
for (const file of ["LICENSE", "skills/module-boundaries/SKILL.md", "docs/report-format-v2.md", "docs/arch-review-format-v1.md", "docs/module-roles.md", "docs/report-storage-and-compaction-design.md"]) {
  await copyFile(new URL(file, root), new URL(file, output));
}
