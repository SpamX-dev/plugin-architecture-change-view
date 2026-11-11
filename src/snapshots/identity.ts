import { createHash } from "node:crypto";
import { digest as contentDigest } from "../serialization/digest.js";
import type { Snapshot } from "./types.js";

/** Стабильная контрольная сумма структуры, не зависящая от времени индексации. */
export function structureHash(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

/** Метки и время не меняют содержание снимка; факты и неполнота входят в отпечаток. */
export function snapshotDigest(snapshot: Snapshot) {
  return contentDigest({ root: snapshot.root, modules: snapshot.modules,
    facts: snapshot.facts ?? [], complete: snapshot.complete,
    diagnostics: snapshot.diagnostics, evidenceLimitations: snapshot.evidenceLimitations ?? [] });
}
