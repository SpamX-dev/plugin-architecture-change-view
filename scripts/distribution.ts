import { mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withFileLock } from "../src/storage/file-lock.js";

/** Publish only the files produced by this build. Keep the last successful package on failure. */
export async function buildDistribution(root: URL, name: "codex" | "dsh", build: (directory: URL) => Promise<void>) {
  const dist = fileURLToPath(new URL("dist/", root));
  await mkdir(dist, { recursive: true });
  const staging = await mkdtemp(path.join(dist, "." + name + "-build-"));
  const target = path.join(dist, name);
  const previous = path.join(dist, "." + name + "-previous");
  try {
    await build(pathToFileURL(staging + path.sep));
    await withFileLock(dist, "." + name + "-build.lock", async () => {
      // A previous publisher may have stopped between the two renames.
      if (existsSync(previous)) {
        if (existsSync(target)) await rm(previous, { recursive: true });
        else await rename(previous, target);
      }
      const hadPrevious = existsSync(target);
      if (hadPrevious) await rename(target, previous);
      try { await rename(staging, target); }
      catch (error) { if (hadPrevious) await rename(previous, target); throw error; }
      if (hadPrevious) await rm(previous, { recursive: true, force: true });
    });
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return target;
}
