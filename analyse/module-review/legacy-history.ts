import { createHash, randomUUID } from "node:crypto";
import { copyFile, link, lstat, mkdir, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { errorDetails } from "../../node-errors.js";
import { defaultSnapshotDirectory, readSavedSnapshot, savedSnapshotPaths, SnapshotStore } from "../git-changes/snapshot-store.js";
import { readArchiveFile } from "../../storage/archive-cache.js";
import { ensureProjectIdentity, readSnapshotRoot } from "../../storage/identity.js";
import { assertStateLocation } from "../../storage/paths.js";
import { readReviewBundle } from "./review-store.js";

function legacyDirectoryFor(root: string) {
  const key = createHash("sha256").update(root).digest("hex").slice(0, 20);
  return path.join(os.homedir(), ".archiview", key);
}

/** Existing identical files can be reused after an interrupted or concurrent migration. */
async function copyArchive(source: string, destination: string) {
  const parent = path.dirname(destination);
  await mkdir(parent, { recursive: true });
  const temporary = path.join(parent, ".pending-" + randomUUID());
  try {
    await copyFile(source, temporary);
    try { await link(temporary, destination); }
    catch (cause) {
      if (errorDetails(cause).code !== "EEXIST") throw cause;
      if (!(await readArchiveFile(source)).equals(await readArchiveFile(destination))) {
        throw new Error("State migration collision: " + path.basename(destination));
      }
    }
  } finally { await rm(temporary, { force: true }); }
}

async function migrateLegacyHistory(store: SnapshotStore, legacy: string) {
  if (legacy === store.directory) return null;
  await assertStateLocation(store.root, legacy);
  let entries: string[];
  try {
    if (!(await lstat(legacy)).isDirectory()) throw new Error("Invalid legacy state directory");
    entries = await readdir(legacy);
  } catch (cause) { if (errorDetails(cause).code === "ENOENT") return null; throw cause; }

  const snapshotRoot = await readSnapshotRoot(store.root, legacy) ?? store.root;
  const files = await savedSnapshotPaths(store.root, legacy);
  const snapshots = files.length;
  for (const file of files) await readSavedSnapshot(file, snapshotRoot);
  let reviews = 0;
  if (entries.includes("reviews")) {
    const directory = path.join(legacy, "reviews");
    if (!(await lstat(directory)).isDirectory()) throw new Error("Invalid legacy review directory");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (!entry.isDirectory()) throw new Error("Invalid legacy review entry");
      const bundleDirectory = path.join(directory, entry.name);
      const bundle = await readReviewBundle(bundleDirectory);
      if (bundle.current.root !== snapshotRoot) throw new Error("Foreign legacy review project");
      const names = ["review.yaml", "input.json", "current.json"];
      if (bundle.baseline) names.push("baseline.json");
      for (const name of names) files.push(path.join(bundleDirectory, name));
      reviews += 1;
    }
  }
  if (!files.length) return null;
  for (const file of files) {
    const destination = path.join(store.directory, path.relative(legacy, file));
    await store.assertLocation(destination);
    await copyArchive(file, destination);
  }
  await ensureProjectIdentity(store.root, store.directory, snapshotRoot);
  return { from: legacy, snapshots, reviews };
}

/** Validate and copy the complete legacy history before opening the repository's stores. */
export async function openProjectHistory(root: string, directory?: string, legacyDirectory?: string) {
  const store = new SnapshotStore(root, directory);
  const migration = store.directory === defaultSnapshotDirectory(store.root) && await readSnapshotRoot(store.root, store.directory) === null
    ? await migrateLegacyHistory(store, path.resolve(legacyDirectory ?? legacyDirectoryFor(store.root))) : null;
  await store.open();
  return { store, migration };
}
