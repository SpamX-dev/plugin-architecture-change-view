import { lstat, readFile } from "node:fs/promises";

/** Reads the original bytes of a bounded, ordinary archive file. */
export async function readArchiveFile(file: string) {
  const info = await lstat(file);
  if (!info.isFile() || info.size > 64 * 1024 * 1024) throw new Error("Invalid stored file");
  return readFile(file);
}

/** A store owns its cache. Directory listings decide membership on every scan. */
export class ArchiveCache<T> {
  readonly #files = new Map<string, { version: string; value: T }>();

  async read(file: string, load: () => Promise<T>, key = file): Promise<T> {
    const version = await fileVersion(file);
    const cached = this.#files.get(key);
    if (cached?.version === version) return cached.value;
    const value = await load();
    if (await fileVersion(file) !== version) throw new Error("Archive file changed while being read: " + file);
    this.#files.set(key, { version, value });
    return value;
  }

  retain(keys: Set<string>) {
    for (const key of this.#files.keys()) if (!keys.has(key)) this.#files.delete(key);
  }
}

async function fileVersion(file: string) {
  const info = await lstat(file, { bigint: true });
  if (!info.isFile()) throw new Error("Archive file must be an ordinary file: " + file);
  return [info.dev, info.ino, info.size, info.ctimeNs, info.mtimeNs].join("/");
}
