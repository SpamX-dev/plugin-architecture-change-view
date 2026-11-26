import { randomUUID } from "node:crypto";
import { readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { digest } from "../../framework/serialization/digest.js";
import { errorDetails } from "../../node-errors.js";
import { analysisFingerprint, projectAnalysisScopes } from "./analysis-scope.js";
import { moduleId } from "./module-state.js";
import type { SkillObservationHistory, Snapshot, SnapshotModule } from "../../framework/snapshots/types.js";
import type { SnapshotStore } from "../git-changes/snapshot-store.js";

interface Version { hash: string | null; revision: number }
interface ModuleCursor {
  fingerprint: string | null;
  composition?: string | null;
  revision: number;
  types?: { grasp?: Version; composition?: Version; implementation: Version };
  skillHistory?: SkillObservationHistory;
}
interface ObservationFile { lineage: string; modules: Record<string, ModuleCursor> }

async function readObservations(store: SnapshotStore, file: string): Promise<ObservationFile | undefined> {
  await store.assertLocation(file);
  try {
    const saved: ObservationFile = JSON.parse(await readFile(file, "utf8"));
    if (typeof saved.lineage !== "string" || !saved.modules || Object.values(saved.modules).some(m =>
      !Number.isSafeInteger(m.revision) || m.revision < 1 || m.fingerprint !== null && typeof m.fingerprint !== "string" ||
      m.composition != null && typeof m.composition !== "string"))
      throw new Error("Invalid module observation history");
    return saved;
  } catch (cause) {
    if (errorDetails(cause).code !== "ENOENT") throw cause;
  }
}

/** Both files can predate synchronization. Continue from the furthest observed compatible cursor. */
function advance(hash: string | null, ...versions: (Version | undefined)[]): Version {
  const highest = Math.max(0, ...versions.map(version => version?.revision ?? 0));
  const unchanged = versions.some(version => version?.revision === highest && version.hash === hash);
  return {hash, revision:unchanged ? highest : highest + 1};
}

function implementationHashes(module: SnapshotModule, current: string) {
  const withoutSkills = module.files.filter(file => path.posix.basename(file.path) !== "SKILL.md");
  const legacy = withoutSkills.length === module.files.length ? current :
    analysisFingerprint("implementation", [{...module, files:withoutSkills}]);
  return {current, legacy};
}

async function saveObservations(file: string, previous: ObservationFile | undefined, next: ObservationFile) {
  const contents = JSON.stringify(next);
  if (previous && JSON.stringify(previous) === contents) return;
  const temporary = file + "." + randomUUID();
  try {
    await writeFile(temporary, contents, {flag:"wx"});
    await rename(temporary, file);
  } finally { await rm(temporary, {force:true}); }
}

/** Called under the live publication lock, so capture and cursor updates use the same order in every process. */
export async function observeModules(store: SnapshotStore, current: Snapshot) {
  current.observations = Object.create(null) as NonNullable<Snapshot["observations"]>;
  if (!current.complete) return;
  const directory = path.join(store.directory, "snapshots");
  const commonFile = path.join(directory, "module-observations.json");
  const currentFile = path.join(directory, "module-observations-v2.json");
  const common = await readObservations(store, commonFile);
  const generation = await readObservations(store, currentFile);
  const lineage = common?.lineage ?? generation?.lineage ?? randomUUID();
  const compatible = generation?.lineage === lineage ? generation : undefined;
  const sharedById = new Map(Object.entries(common?.modules ?? {}));
  const currentById = new Map(Object.entries(compatible?.modules ?? {}));
  const commonModules = new Map<string, ModuleCursor>();
  const currentModules = new Map<string, ModuleCursor>();
  const fingerprints = new Map(projectAnalysisScopes(current).map(({module, composition, hashes}) => [moduleId(module), {
    fingerprint: digest([module.directory, module.files, module.document]),
    composition: digest(composition),
    compositionHash: hashes.composition,
    implementation: implementationHashes(module, hashes.implementation),
  }]));
  for (const id of new Set([...sharedById.keys(), ...currentById.keys(), ...fingerprints.keys()])) {
    const shared = sharedById.get(id);
    const privateCursor = currentById.get(id);
    const state = fingerprints.get(id);
    const fingerprint = state?.fingerprint ?? null, composition = state?.composition ?? null;
    const previous = [shared, privateCursor].filter(cursor => cursor !== undefined);
    const highest = Math.max(0, ...previous.map(cursor => cursor.revision));
    const unchanged = previous.some(cursor => cursor.revision === highest && cursor.fingerprint === fingerprint &&
      (cursor.composition === undefined || cursor.composition === composition));
    const revision = unchanged ? highest : highest + 1;
    const compositionVersion = advance(state?.compositionHash ?? null,
      shared?.types?.grasp ?? shared?.types?.composition, privateCursor?.types?.composition ?? privateCursor?.types?.grasp);
    const full = state?.implementation.current ?? null, narrow = state?.implementation.legacy ?? null;
    let implementation: Version, legacyImplementation: Version;
    let skillHistory = privateCursor?.skillHistory;
    if (full !== narrow) {
      const last = privateCursor ?? shared;
      const prior = last?.types?.implementation;
      // At migration, equal full inputs prove the older projection only omitted evidence.
      implementation = !privateCursor && shared?.fingerprint === fingerprint && prior ?
        {hash:full, revision:prior.revision} : advance(full, prior);
      // An older observer may have already used either projection. Leave that clock alone on equal full inputs.
      legacyImplementation = shared?.fingerprint === fingerprint && shared.types?.implementation ?
        shared.types.implementation : advance(narrow, shared?.types?.implementation ?? prior);
      skillHistory = {...skillHistory, since:skillHistory?.since ?? last?.revision ?? revision};
      delete skillHistory.sharedSince;
    } else {
      implementation = legacyImplementation = advance(full, shared?.types?.implementation, privateCursor?.types?.implementation);
      if (skillHistory && skillHistory.sharedSince === undefined) skillHistory = {...skillHistory, sharedSince:revision};
    }
    if (skillHistory && privateCursor && revision > privateCursor.revision) {
      skillHistory = {...skillHistory};
      // A legacy-only round trip can change excluded files or SKILL.md; the endpoints cannot distinguish them.
      const gap = (shared?.revision ?? 0) - privateCursor.revision;
      const lastShared = shared?.types?.implementation;
      if ((skillHistory.sharedSince ?? revision) > privateCursor.revision && shared &&
          (gap > 1 || gap > 0 && shared.fingerprint !== fingerprint && shared.fingerprint !== privateCursor.fingerprint &&
            lastShared?.hash !== full))
        skillHistory.uncertainAt = shared.revision;
      // A mismatch with both supported projections proves a change after the last shared observation.
      if (shared && gap > 0 && revision > shared.revision && lastShared && lastShared.hash !== full && lastShared.hash !== narrow)
        skillHistory.changedAt = revision;
      else if (privateCursor.types?.implementation.hash !== full)
        skillHistory.changedAt = gap > 0 ? privateCursor.revision + 1 : revision;
    }
    const cursor = {fingerprint, composition, revision};
    // Older observers still read and write this common cursor under its original name.
    commonModules.set(id, {...cursor, types:{grasp:compositionVersion, implementation:legacyImplementation}});
    const history = skillHistory ? {skillHistory} : {};
    currentModules.set(id, {...cursor, types:{composition:compositionVersion, implementation}, ...history});
    current.observations[id] = {lineage, revision, composition:compositionVersion.revision, implementation:implementation.revision, ...history};
  }
  await saveObservations(commonFile, common, {lineage, modules:Object.fromEntries(commonModules)});
  await saveObservations(currentFile, generation, {lineage, modules:Object.fromEntries(currentModules)});
}
