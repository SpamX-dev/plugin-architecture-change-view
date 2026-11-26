import { createHash } from "node:crypto";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import path from "node:path";
import { assertStateLocation, physicalPath, STATE_DIRECTORY, within } from "../../storage/paths.js";
import { containingWorktree } from "../../analyse/project/workspace.js";
import { digest } from "../../framework/serialization/digest.js";
import { ensureProjectIdentity, readSnapshotRoot } from "../../storage/identity.js";
import { withFileLock } from "../../storage/file-lock.js";
import { errorDetails } from "../../node-errors.js";

// Previous standalone versions could prepare requests before their first publication created project.json.
async function ownsUnpublishedRequests(root: string, directory: string): Promise<boolean | undefined> {
  const requests = path.join(directory, "snapshots", "analysis");
  await assertStateLocation(root, directory, requests);
  let entries;
  try { entries = await readdir(requests, { withFileTypes: true }); }
  catch (error) { if (errorDetails(error).code === "ENOENT") return; throw error; }
  const expected = digest(root);
  let found = false;
  for (const entry of entries.filter(entry => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name))) {
    const input = path.join(requests, entry.name, "input.yaml");
    await assertStateLocation(root, directory, input);
    if (!(await lstat(input)).isFile()) throw new Error("Invalid saved analysis input");
    const file = await open(input, "r");
    try {
      // The native exporter writes the scalar project_id in the top-level header, before the snapshots.
      const { buffer, bytesRead } = await file.read(Buffer.alloc(64 * 1024));
      const owner = /^project_id: (sha256:[a-f0-9]{64})\r?$/m.exec(buffer.toString("utf8", 0, bytesRead))?.[1];
      if (owner !== expected) return false;
      found = true;
    } finally { await file.close(); }
  }
  return found || undefined;
}

/** External state belongs to a physical checkout. Portable identity remains valid in checkout-local state. */
export async function repositoryStateDirectory(root: string, requested?: string, shared = false) {
  if (!requested) return;
  const directory = path.resolve(root, requested);
  const key = createHash("sha256").update(root).digest("hex");
  if (within(root, directory)) {
    await assertStateLocation(root, directory);
    const localPartitions = path.join(root, STATE_DIRECTORY, "repositories");
    // The entire partition namespace is reserved, including alternate spellings and descendants.
    if (within(localPartitions, await physicalPath(directory)))
      return path.join(localPartitions, key);
    return directory;
  }
  await assertStateLocation(root, directory);
  const destination = await physicalPath(directory);
  let partition = path.join(directory, "repositories", key);
  const owned = (origin: string) => path.isAbsolute(origin) && path.relative(root, origin) === "";
  async function partitionDirectory() {
    const origin = await readSnapshotRoot(root, partition);
    if (!origin || !owned(origin)) await ensureProjectIdentity(root, partition, root);
    return partition;
  }
  // Portable project.json can have the caller's origin in another clone. Its local storage
  // belongs to that checkout even before its first publication or when reached via a link.
  for (let parent = destination; path.dirname(parent) !== parent; parent = path.dirname(parent)) {
    if (path.relative(path.join(path.dirname(parent), STATE_DIRECTORY), parent) === "" &&
        await containingWorktree(path.dirname(parent))) {
      partition = path.join(parent, "repositories", key);
      return partitionDirectory();
    }
  }
  const origin = await readSnapshotRoot(root, directory);
  if (origin) return owned(origin) ? directory : partitionDirectory();
  await mkdir(directory, { recursive: true });
  return withFileLock(directory, ".repository-routing.lock", async () => {
    const claimed = await readSnapshotRoot(root, directory);
    if (claimed) return owned(claimed) ? directory : partitionDirectory();
    const previous = await ownsUnpublishedRequests(root, directory);
    const entries = await readdir(directory);
    if (previous === false || previous === undefined && (shared || entries.includes("repositories"))) {
      return partitionDirectory();
    }
    await ensureProjectIdentity(root, directory, root);
    return directory;
  });
}
