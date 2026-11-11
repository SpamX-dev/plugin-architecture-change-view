import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
/** Use the nearest package manifest both in a source checkout and inside each distribution. */
function packageDirectory(moduleUrl: string): URL {
  let directory = new URL("./", moduleUrl);
  while (!existsSync(new URL("package.json", directory))) {
    const parent = new URL("../", directory);
    if (parent.href === directory.href) throw new Error("ArchiView package.json is missing");
    directory = parent;
  }
  return directory;
}

export const packageUrl = packageDirectory(import.meta.url);
const sourceCli = new URL("src/cli.ts", packageUrl);
const sourceCheckout = existsSync(sourceCli);
export const webAssetUrl = new URL(sourceCheckout ? "dist/web/archiview/" : "web/archiview/", packageUrl);

/** Runtime argv for source execution and autonomous installed CLI bundles. */
export function cliArguments(): string[] {
  return sourceCheckout ? ["--import", import.meta.resolve("tsx"), fileURLToPath(sourceCli)] : [fileURLToPath(new URL("src/cli.mjs", packageUrl))];
}
