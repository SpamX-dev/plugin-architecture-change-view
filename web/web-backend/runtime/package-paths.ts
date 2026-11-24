import { fileURLToPath } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { errorDetails } from "../../../node-errors.js";
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
const sourceCli = new URL("cli/cli.ts", packageUrl);
const sourceCheckout = existsSync(sourceCli);
const webAssetUrl = new URL(sourceCheckout ? "dist/web/archiview/" : "web/archiview/", packageUrl);

export function readWebAsset(name: string): Buffer {
  const asset = new URL(name, webAssetUrl);
  try {
    return readFileSync(asset);
  } catch (cause) {
    const error = errorDetails(cause);
    throw new Error(`Не удалось прочитать ресурс ArchiView ${fileURLToPath(asset)} (${error.code ?? error.message})`, { cause });
  }
}

/** Runtime argv for source execution and autonomous installed CLI bundles. */
export function cliArguments(): string[] {
  return sourceCheckout ? ["--import", import.meta.resolve("tsx"), fileURLToPath(sourceCli)] : [fileURLToPath(new URL("cli.mjs", packageUrl))];
}
