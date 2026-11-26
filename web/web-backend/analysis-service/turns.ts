import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { analysisTypes, type AnalysisType } from "../../../framework/ai-report/types.js";
import { digest } from "../../../framework/serialization/digest.js";
import { projectAnalysisScopes } from "../../../analyse/module-review/analysis-scope.js";
import { moduleId } from "../../../analyse/module-review/module-state.js";
import type { FindingDecisions } from "../../../analyse/module-review/dispositions.js";
import type { ReviewEntry } from "../../../framework/static-report/types.js";
import type { SessionView } from "../../../module-operations/session-view.js";
import { reviewFilePath } from "../../../module-operations/module-view.js";
import type { Delivery } from "../../../module-operations/analysis-record.js";
import { withFileLock } from "../../../storage/file-lock.js";
import { errorDetails } from "../../../node-errors.js";
import type { HarnessKind } from "../host-bridge/channel.js";
import type { AnalysisRequests } from "./analysis.js";

export interface TurnHost { kind: HarnessKind; instanceId?: string }
type Fingerprints = Record<AnalysisType, string>;
interface Turn { host: TurnHost; baseline: [string, Fingerprints][]; requestIndexVersion?: 2 }
interface Check {
  moduleId: string; type: AnalysisType; status: "pending" | "reviewed" | "unavailable" | "unconfirmed";
  requestId?: string; reviewId?: string; harnessId?: string; delivery?: Delivery; message?: string; result?: Awaited<ReturnType<typeof reviewResult>>;
}
interface Batch { host: TurnHost; checks: Check[] }
interface RequestReference {
  requestId: string; reviewId: string; snapshot: string; head?: string | null;
  harnessId?: string; turns?: string[];
}

async function reviewResult(entry: ReviewEntry, decisions: FindingDecisions, file: string) {
  const dispositions = await decisions.read(entry.review_id);
  return { file, assessment: entry.report.assessment.current, assessmentDecision: dispositions["assessment-summary"],
    coverage: entry.report.analysis.coverage, findings: entry.report.findings.filter(f => f.kind !== "contract_change")
      .map(f => ({...f, disposition: dispositions[f.id]})) };
}

function scopes(view: SessionView) {
  if (!view.complete) throw new Error("Неполный снимок: " + view.diagnostics.join("; "));
  return projectAnalysisScopes(view.currentSnapshot);
}

async function readRecord<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (errorDetails(error).code !== "ENOENT") throw error; }
}

/** Turn baselines and request references are immutable. Publish only complete records. */
async function writeRecord(file: string, record: unknown) {
  const temp = file + "." + randomUUID();
  try {
    await writeFile(temp, JSON.stringify(record), {flag:"wx"});
    await rename(temp, file);
  } finally { await rm(temp, {force:true}); }
}

export class AgentTurns {
  constructor(private analysis: AnalysisRequests, private decisions: FindingDecisions,
    private view: () => Promise<SessionView>, private evidence: (view: SessionView) => Promise<SessionView>,
    private currentEntries: (entries: ReviewEntry[], view: SessionView) => Promise<ReviewEntry[]>) {}

  private async file(kind: "turns" | "requests" | "batches" | "reviewers", id: string) {
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error("Некорректный идентификатор хода");
    const file = path.join(this.analysis.store.directory, "snapshots", "agent-turns", kind, id + ".json");
    await this.analysis.store.assertLocation(file);
    await mkdir(path.dirname(file), {recursive:true});
    return file;
  }

  async isReviewSession(sessionKey: string, reviewAssignment: boolean) {
    const file = await this.file("reviewers", sessionKey);
    if (reviewAssignment) await writeRecord(file, true);
    return reviewAssignment || await readRecord<boolean>(file) === true;
  }

  async begin(id: string, host: TurnHost) {
    const file = await this.file("turns", id);
    await withFileLock(path.dirname(file), id + ".lock", async () => {
      if (await readRecord<Turn>(file)) return;
      const baseline = scopes(await this.view()).map(({module, hashes}) => [moduleId(module), hashes]);
      await writeRecord(file, {host, baseline, requestIndexVersion:2});
    });
  }

  private async harness(host: TurnHost) {
    if (host.instanceId) return host.instanceId;
    const {harnesses} = await this.analysis.harnesses();
    const matches = harnesses.filter(h => !h.reason && h.id.startsWith(host.kind + "-"));
    if (matches.length !== 1) throw new Error(matches.length ?
      "Доступно несколько мостов " + host.kind + ". Укажите ID экземпляра в поле " + host.kind + " файла agent-review.json." :
      "Нет доступного моста " + host.kind + " для этого репозитория.");
    return matches[0].id;
  }

  private async reviewed(check: Check, entry: ReviewEntry) {
    const file = reviewFilePath(this.analysis.store.root, this.analysis.reports.work, entry.module_id);
    check.result = await reviewResult(entry, this.decisions, file);
    check.reviewId = entry.review_id;
    check.status = "reviewed";
    delete check.message;
  }

  private async prepare(turnId: string, turn: Turn) {
    const before = new Map(turn.baseline);
    const view = await this.view();
    const checks: Check[] = [];
    let evidence: Promise<SessionView> | undefined;
    let selectedHarness: Promise<string | undefined> | undefined;
    for (const {module, hashes} of scopes(view)) {
      const owner = moduleId(module);
      const changed = analysisTypes.filter(type => before.get(owner)?.[type] !== hashes[type]);
      if (!changed.length) continue;
      const current = await this.currentEntries(await this.analysis.reports.readModuleReviews(owner), view);
      for (const type of changed) {
        const check: Check = { moduleId: owner, type, status: "pending" };
        checks.push(check);
        const existing = current.find(entry => entry.manifest.analysis_type === type);
        if (existing) { await this.reviewed(check, existing); continue; }
        try {
          if (!module.document.contract) throw new Error("Требуется контракт каталога " + module.directory);
          const version = view.currentSnapshot.observations?.[owner];
          const harnessId = await (selectedHarness ??= this.harness(turn.host).catch(() => undefined));
          const inputs = [owner, type, hashes[type], version?.lineage, version?.[type]];
          const key = digest(["request-instances", turn.host.kind, ...inputs]).slice(7);
          const head = view.currentSnapshot.baseRevision;
          const file = await this.file("requests", key);
          const ref = await withFileLock(path.dirname(file), key + ".lock", async () => {
            const refs = await readRecord<RequestReference[]>(file) ?? [];
            // The original cache stored one reference per selector, without its originating turn.
            const selectors: TurnHost[] = [{kind:turn.host.kind}];
            if (harnessId) selectors.push({kind:turn.host.kind, instanceId:harnessId});
            for (const selector of selectors) {
              const oldKey = digest(["request", selector, ...inputs]).slice(7);
              const legacy = await readRecord<RequestReference>(await this.file("requests", oldKey));
              if (legacy && !refs.some(ref => ref.requestId === legacy.requestId))
                refs.push({...legacy, harnessId:selector.instanceId});
            }
            // A manual delivery can select a recipient after the request is prepared.
            for (const ref of refs) ref.harnessId = (await this.analysis.requestDelivery(ref.requestId))?.harnessId ?? ref.harnessId;
            const own = refs.findLast(ref => ref.turns?.includes(turnId) &&
              (!turn.host.instanceId || ref.harnessId === turn.host.instanceId));
            const candidates = refs.filter(ref => {
              if (ref === own) return false;
              if (harnessId && ref.harnessId === harnessId) return true;
              // Unclaimed legacy requests can be adopted. For an older offline turn, keep its original receipt.
              return !ref.turns && (!ref.harnessId || !turn.requestIndexVersion && !harnessId);
            }).reverse();
            if (own) candidates.unshift(own);
            for (const saved of candidates) {
              if (saved.snapshot !== view.after.digest || saved.head !== head) {
                const input = await this.analysis.typedInput(saved.requestId);
                if (!(await this.currentEntries([input], view)).length) continue;
              }
              if (!saved.turns?.includes(turnId) || !saved.harnessId && harnessId) {
                saved.harnessId ??= harnessId;
                if (!saved.turns?.includes(turnId)) (saved.turns ??= []).push(turnId);
                await writeRecord(file, refs);
              }
              return saved;
            }
            const selected = view.modules.find(m => m.after?.directory === module.directory)!;
            const source = type === "implementation" ? await (evidence ??= this.evidence(view)) : view;
            const request = await this.analysis.create(source, selected, type, view.after);
            const ref = {requestId: request.id, reviewId: request.reviewId, snapshot:view.after.digest, head, harnessId, turns:[turnId]};
            await writeRecord(file, [...refs, ref]);
            return ref;
          });
          check.requestId = ref.requestId;
          check.reviewId = ref.reviewId;
          check.harnessId = ref.harnessId;
        } catch (error) { check.status = "unavailable"; check.message = errorDetails(error).message; }
      }
    }

    return {snapshot:view.after, checks};
  }

  private async dispatch({host, checks}: Batch) {
    let harness: Promise<string> | undefined;
    for (const check of checks.filter(item => item.requestId)) {
      try {
        const request = await this.analysis.status(check.requestId!);
        if (request.status === "completed" || request.limitation) continue;
        const target = check.harnessId ?? host.instanceId;
        const recipient = target ?? request.delivery?.harnessId ?? await (harness ??= this.harness(host));
        if (!recipient.startsWith(host.kind + "-") || request.delivery && request.delivery.harnessId !== recipient)
          throw new Error("Запрос уже передан в другой экземпляр harness.");
        const delivery = request.delivery ?? await this.analysis.deliver(request.id, recipient);
        check.delivery = delivery;
        if (delivery.state === "unknown") { check.status = "unconfirmed"; check.message = delivery.message; }
      } catch (error) { check.status = "unavailable"; check.message = errorDetails(error).message; }
    }
  }

  /** The worker receives immutable request IDs. It never recaptures the working tree. */
  async dispatchBatch(id: string) {
    const file = await this.file("batches", id);
    const batch = await readRecord<Batch>(file);
    if (!batch || digest(["dispatch", batch]).slice(7) !== id) throw new Error("Неизвестная очередь проверок");
    await this.dispatch(batch);
    const receipt = file + ".delivery.json";
    await this.analysis.store.assertLocation(receipt);
    await writeRecord(receipt, batch.checks);
    return batch.checks;
  }

  /** Both the synchronous check and the final hook use the same saved baseline and preparation. */
  async review(id: string, waitSeconds: number, enqueue?: (batchId: string) => Promise<void>) {
    const turn = await readRecord<Turn>(await this.file("turns", id));
    if (!turn) {
      if (enqueue) return;
      throw new Error("Нет начального снимка хода. Проверьте подключение UserPromptSubmit.");
    }
    const {snapshot, checks} = await this.prepare(id, turn);
    if (enqueue) {
      const pending: Check[] = [];
      for (const check of checks.filter(check => check.requestId)) {
        const request = await this.analysis.status(check.requestId!);
        if (request.limitation) { check.status = "unavailable"; check.message = request.limitation; }
        else if (request.delivery?.state === "unknown") { check.status = "unconfirmed"; check.message = request.delivery.message; }
        else if (request.status === "prepared" && !request.delivery) pending.push(check);
      }
      if (pending.length) {
        const batch: Batch = {host:turn.host, checks:pending};
        const key = digest(["dispatch", batch]).slice(7);
        await writeRecord(await this.file("batches", key), batch);
        await enqueue(key);
      }
      return {turnId:id, snapshot, checks};
    }
    await this.dispatch({host:turn.host, checks});
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      for (const check of checks.filter(item => item.status === "pending" || item.status === "unconfirmed")) {
        const entries = await this.analysis.reports.readModuleReviews(check.moduleId);
        const entry = entries.find(entry => entry.review_id === check.reviewId);
        if (entry) await this.reviewed(check, entry);
        else {
          const limitation = await this.analysis.limitation(check.requestId!);
          if (limitation) { check.status = "unavailable"; check.message = limitation; }
        }
      }
      if (Date.now() >= deadline || !checks.some(c => c.status === "pending")) break;
      await delay(Math.min(1500, deadline - Date.now()));
    }
    return {turnId:id, snapshot, checks};
  }
}
