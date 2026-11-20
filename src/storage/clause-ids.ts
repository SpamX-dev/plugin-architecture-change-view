import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { contractDocument } from "../contracts/document.js";
import { moduleDocumentPath } from "../contracts/module-tree.js";
import type { Section, StoredContract } from "../contracts/types.js";
import { assertStateLocation, STATE_DIRECTORY } from "../project/paths.js";
import { errorDetails } from "../runtime/errors.js";
import { gitContractTexts } from "../snapshots/git-tree.js";

type NumberedSection = Exclude<Section, "purpose">;
const prefixes = { boundaries: "B", invariants: "I" } as const;

function clauseNumber(section: NumberedSection, id: string) {
  return id.startsWith(prefixes[section]) && /^[0-9]+$/.test(id.slice(1)) ? BigInt(id.slice(1)) : 0n;
}

async function counter(root: string, moduleId: string, section: NumberedSection) {
  const directory = path.join(root, STATE_DIRECTORY);
  const filename = path.basename(moduleDocumentPath(moduleId), ".yaml") + ".seq";
  const file = path.join(directory, "snapshots", "clause-ids", section, filename);
  await assertStateLocation(root, directory, file);
  try {
    const value = (await readFile(file, "utf8")).trim();
    if (!/^[0-9]+$/.test(value)) throw new Error("Некорректный счётчик ID пунктов модуля " + moduleId);
    return { file, last: BigInt(value) };
  } catch (cause) {
    if (errorDetails(cause).code !== "ENOENT") throw cause;
    return { file, last: 0n };
  }
}

/** The contract edit lock covers choosing the number, recording it, and replacing the YAML. */
export async function nextClauseId(root: string, current: StoredContract, section: NumberedSection, baseline?: StoredContract | null) {
  const [{ last }, texts] = await Promise.all([counter(root, current.id, section), gitContractTexts(root, current.id)]);
  let highest = last;
  for (const contract of [current, baseline, ...texts.map(text => contractDocument(text).contract)]) {
    if (contract?.id !== current.id) continue;
    for (const id of Object.keys(contract[section])) {
      const number = clauseNumber(section, id);
      if (number > highest) highest = number;
    }
  }
  return prefixes[section] + (highest + 1n);
}

/** An uncommitted ID stays reserved even after deletion and a server restart. */
export async function rememberClauseId(root: string, moduleId: string, section: NumberedSection, id: string) {
  const number = clauseNumber(section, id);
  if (!number) return;
  const { file, last } = await counter(root, moduleId, section);
  if (number <= last) return;
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), ".pending-" + randomUUID());
  try {
    await writeFile(temporary, number + "\n", { flag: "wx" });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
