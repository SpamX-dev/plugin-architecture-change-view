import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { digest } from "../../framework/serialization/digest.js";
import { openFinding, validDisposition, type FindingDisposition } from "../../framework/ai-report/types.js";
import { assertStateLocation } from "../../storage/paths.js";
import { withFileLock } from "../../storage/file-lock.js";
import { errorDetails } from "../../node-errors.js";

export class DecisionConflict extends Error {}

export function parseFindingDecisions(text: string): Record<string, FindingDisposition> {
  const values = JSON.parse(text);
  if (!values || typeof values !== "object" || Array.isArray(values) || !Object.values(values).every(validDisposition))
    throw new Error("Некорректные решения по замечаниям");
  return Object.assign(Object.create(null), values);
}

export class FindingDecisions {
  constructor(private root: string, private state: string) {}

  private file(reviewId: string) {
    return path.join(this.state, "decisions", digest(reviewId).slice(7) + ".json");
  }

  async read(reviewId: string): Promise<Record<string, FindingDisposition>> {
    const file = this.file(reviewId);
    await assertStateLocation(this.root, this.state, file);
    try {
      return parseFindingDecisions(await readFile(file, "utf8"));
    } catch (error) { if (errorDetails(error).code !== "ENOENT") throw error; return Object.create(null); }
  }

  async update(reviewId: string, findingId: string, next: FindingDisposition, expected: FindingDisposition, initial = openFinding) {
    if (!validDisposition(next) || !validDisposition(expected)) throw new Error("Некорректный статус или решение");
    const file = this.file(reviewId);
    await assertStateLocation(this.root, this.state, file);
    const directory = path.dirname(file);
    await mkdir(directory, {recursive:true});
    return withFileLock(directory, path.basename(file) + ".lock", async () => {
      const all = await this.read(reviewId);
      const old = all[findingId] ?? initial;
      if (old.status === next.status && old.decision === next.decision) return next;
      if (old.status !== expected.status || old.decision !== expected.decision) throw new DecisionConflict("Решение изменилось. Обновите карточку.");
      all[findingId] = next;
      const temporary = file + "." + randomUUID();
      try {
        await writeFile(temporary, JSON.stringify(all), {flag:"wx"});
        await rename(temporary, file);
      } finally { await rm(temporary, {force:true}); }
      return next;
    });
  }
}
