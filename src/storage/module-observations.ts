import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { digest } from "../serialization/digest.js";
import { errorDetails } from "../runtime/errors.js";
import { directChildContracts, moduleId } from "../reports/module-state.js";
import type { Snapshot } from "../snapshots/types.js";
import type { SnapshotStore } from "./snapshot-store.js";

interface ObservationFile {
  lineage: string;
  modules: Record<string, { fingerprint: string | null; composition?: string | null; revision: number }>;
}

/** Called under the live publication lock, so capture and cursor updates use the same order in every process. */
export async function observeModules(store: SnapshotStore, current: Snapshot) {
  current.observations = Object.create(null) as NonNullable<Snapshot["observations"]>;
  if (!current.complete) return;
  const file = path.join(store.directory, "snapshots", "module-observations.json");
  await store.assertLocation(file);
  let saved: ObservationFile;
  try {
    saved = JSON.parse(await readFile(file, "utf8"));
    if (typeof saved.lineage !== "string" || !saved.modules || Object.values(saved.modules).some(m =>
      !Number.isSafeInteger(m.revision) || m.revision < 1 || m.fingerprint !== null && typeof m.fingerprint !== "string" ||
      m.composition != null && typeof m.composition !== "string"))
      throw new Error("Invalid module observation history");
  } catch (cause) {
    if (errorDetails(cause).code !== "ENOENT") throw cause;
    saved = {lineage: randomUUID(), modules: {}};
  }
  const children = directChildContracts(current.modules);
  const fingerprints = new Map(current.modules.map(module => [moduleId(module), {
    fingerprint: digest([module.directory, module.files, module.document]),
    composition: digest(children.get(module.directory) ?? []),
  }]));
  const modules = new Map(Object.entries(saved.modules));
  let changed = false;
  for (const id of new Set([...modules.keys(), ...fingerprints.keys()])) {
    const { fingerprint, composition } = fingerprints.get(id) ?? { fingerprint: null, composition: null };
    const previous = modules.get(id);
    // Seed the composition of an existing cursor without inventing a change during migration.
    const unchanged = previous?.fingerprint === fingerprint &&
      (previous.composition === undefined || previous.composition === composition);
    const revision = unchanged ? previous.revision : (previous?.revision ?? 0) + 1;
    current.observations[id] = {lineage: saved.lineage, revision};
    if (unchanged && previous.composition === composition) continue;
    modules.set(id, {fingerprint, composition, revision});
    changed = true;
  }
  if (changed) {
    const temporary = file + "." + randomUUID();
    try {
      await writeFile(temporary, JSON.stringify({lineage: saved.lineage, modules: Object.fromEntries(modules)}), {flag:"wx"});
      await rename(temporary, file);
    } finally { await rm(temporary, {force:true}); }
  }
}
