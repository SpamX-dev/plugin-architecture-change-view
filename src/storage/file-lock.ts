import { createHash, randomUUID } from "node:crypto";
import { link, lstat, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { errorDetails } from "../runtime/errors.js";

interface Owner {
  pid: number;
  token: string;
}

async function readOwner(file: string): Promise<Owner | undefined> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Invalid storage lock");
    const owner = JSON.parse(await readFile(file, "utf8"));
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || typeof owner.token !== "string")
      throw new Error("Invalid storage lock owner");
    return { pid: owner.pid, token: owner.token };
  } catch (error) {
    if (errorDetails(error).code !== "ENOENT") throw error;
  }
}

function processExited(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return errorDetails(error).code === "ESRCH";
  }
}

/** Only one contender may remove a particular abandoned ownership record. */
async function acquire(file: string, candidate: string, deadline: number): Promise<void> {
  for (;;) {
    try {
      await link(candidate, file);
      return;
    } catch (error) {
      if (errorDetails(error).code !== "EEXIST") throw error;
    }
    if (Date.now() >= deadline) throw new Error("Storage is locked by another writer");
    const observed = await readOwner(file);
    if (!observed) continue;
    if (!processExited(observed.pid)) {
      await wait(25);
      continue;
    }

    // A second observer can reach this point after a new writer acquired the original name.
    // Serialize recovery for the unique dead token, then re-read under that recovery lock.
    // Recovery locks follow the same protocol if the recovering process itself exits.
    const key = createHash("sha256").update(JSON.stringify([path.basename(file), observed.token])).digest("hex");
    const recovery = path.join(path.dirname(file), ".recover-" + key);
    await acquire(recovery, candidate, deadline);
    try {
      if ((await readOwner(file))?.token === observed.token) await rm(file);
    } finally {
      await rm(recovery);
    }
  }
}

/** The caller supplies a verified storage directory. The on-disk pid/token format is portable across versions. */
export async function withFileLock<T>(directory: string, name: string, action: () => Promise<T>): Promise<T> {
  const file = path.join(directory, name);
  const token = randomUUID();
  const candidate = path.join(directory, ".owner-" + token);
  await writeFile(candidate, JSON.stringify({ pid: process.pid, token }), { flag: "wx" });
  try {
    await acquire(file, candidate, Date.now() + 30_000);
    try {
      await rm(candidate);
      return await action();
    } finally {
      await rm(file);
    }
  } finally {
    await rm(candidate, { force: true });
  }
}
