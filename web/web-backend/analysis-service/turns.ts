import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { analysisTypes, normalizeAnalysisType, type AnalysisType } from "../../../framework/ai-report/types.js";
import type { Snapshot } from "../../../framework/snapshots/types.js";
import type { FindingDecisions } from "../../../analyse/module-review/dispositions.js";
import { createReportModel } from "../../../analyse/module-review/model.js";
import { moduleId } from "../../../analyse/module-review/module-state.js";
import type { ReviewEntry } from "../../../framework/static-report/types.js";
import { currentAnalysisEntries, reviewFilePath } from "../../../module-operations/module-view.js";
import { errorDetails } from "../../../node-errors.js";
import type { AnalysisRequests } from "./analysis.js";
import { RelationReviews } from "./relation-review.js";

async function openReviewResult(entry: ReviewEntry, decisions: FindingDecisions, file: string) {
  const dispositions = await decisions.read(entry.review_id);
  const findings = entry.report.findings.filter(finding => finding.kind !== "contract_change");
  const open = findings.filter(finding =>
    (dispositions[finding.id]?.status ?? (finding.lifecycle === "resolved" ? "resolved" : "open")) === "open");
  const assessment = entry.report.assessment.current;
  const assessmentDecision = dispositions["assessment-summary"];
  if (!open.length && (findings.length || assessment.verdict !== "violation" ||
      (assessmentDecision?.status ?? "open") !== "open")) return;

  return {
    file, assessment, assessmentDecision, coverage: entry.report.analysis.coverage,
    findings: open.map(finding => ({ ...finding, disposition: dispositions[finding.id] })),
  };
}

type Check = {moduleId: string; type: AnalysisType} & (
  {status: "pending"; message?: undefined} |
  {status: "unavailable"; message: string} |
  {status: "reviewed"; reviewId: string; result: NonNullable<Awaited<ReturnType<typeof openReviewResult>>>; message?: undefined}
);

/** Chooses work from the current report status without a turn or comparison baseline. */
export class AgentTurns {
  private readonly relations: RelationReviews;

  constructor(private analysis: AnalysisRequests, private decisions: FindingDecisions,
    private working: (evidence?: boolean) => Promise<Snapshot>,
    private follows: (entry: ReviewEntry, snapshot: Snapshot) => Promise<boolean>) {
    this.relations = new RelationReviews(analysis.store);
  }

  async isReviewSession(sessionKey: string, reviewAssignment: boolean) {
    if (!/^[a-f0-9]{64}$/.test(sessionKey)) throw new Error("Некорректный идентификатор чата");
    const file = path.join(this.analysis.store.directory, "snapshots", "agent-turns", "reviewers", sessionKey + ".json");
    await this.analysis.store.assertLocation(file);
    if (reviewAssignment) {
      await mkdir(path.dirname(file), {recursive:true});
      const temporary = file + "." + randomUUID();
      try {
        await writeFile(temporary, "true", {flag:"wx"});
        await rename(temporary, file);
      } finally { await rm(temporary, {force:true}); }
      return true;
    }
    try { return JSON.parse(await readFile(file, "utf8")) === true; }
    catch (error) { if (errorDetails(error).code !== "ENOENT") throw error; }
    return false;
  }

  async current() {
    const snapshot = await this.working();
    if (!snapshot.complete) throw new Error("Неполное рабочее дерево: " + snapshot.diagnostics.join("; "));
    const model = createReportModel(null, snapshot);
    const reviews = new Map<string, ReviewEntry[]>();
    for (const entry of await this.analysis.reports.readReviews()) {
      const group = reviews.get(entry.module_id);
      if (group) group.push(entry);
      else reviews.set(entry.module_id, [entry]);
    }
    const checks: Check[] = [];
    for (const module of snapshot.modules) {
      const owner = moduleId(module);
      if (module.document.state !== "documented") {
        for (const type of analysisTypes) {
          checks.push({moduleId:owner, type, status:"unavailable", message:"Требуется контракт каталога " + module.directory});
        }
        continue;
      }
      const current = await currentAnalysisEntries(reviews.get(owner) ?? [], model, snapshot, entry => this.follows(entry, snapshot));
      for (const type of analysisTypes) {
        const entry = current.find(entry => normalizeAnalysisType(entry.manifest.analysis_type) === type);
        if (!entry) {
          checks.push({moduleId:owner, type, status:"pending"});
          continue;
        }
        const file = reviewFilePath(this.analysis.store.root, this.analysis.reports.work, owner);
        const result = await openReviewResult(entry, this.decisions, file);
        if (result) checks.push({moduleId:owner, type, status:"reviewed", reviewId:entry.review_id, result});
      }
    }
    return {checks, relations:await this.relations.status(snapshot)};
  }

  async relationReviewInput() {
    return this.relations.input(await this.working());
  }

  async completeRelationReview(report: unknown) {
    return this.relations.complete(await this.working(), report);
  }

  async prepareCurrent(owner: string, type: AnalysisType) {
    const snapshot = await this.working(type === "implementation");
    const module = snapshot.modules.find(module => moduleId(module) === owner);
    if (!module) throw new Error("Текущий модуль не найден: " + owner);
    return this.analysis.create({id:snapshot.id, complete:snapshot.complete, baselineSnapshot:null, currentSnapshot:snapshot},
      {moduleId:owner, directory:module.directory, before:null, after:module}, type);
  }
}
