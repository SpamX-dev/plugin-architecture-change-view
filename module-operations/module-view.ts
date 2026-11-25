import path from "node:path";
import { isModuleDocumentFile } from "../framework/project/storage-paths.js";
import { isPrototype } from "../framework/contracts/types.js";
import { currentContractYaml } from "../framework/contracts/document.js";
import { diffLines } from "diff";
import { compareContracts, compareRoles } from "../analyse/git-changes/contract-diff.js";
import type { Snapshot } from "../framework/snapshots/types.js";
import type { ReportModel } from "../analyse/module-review/model.js";
import type { ReviewEntry } from "../framework/static-report/types.js";
import type { ReviewBundle } from "../framework/ai-report/types.js";
import { effectiveClauses } from "../analyse/module-review/bundle.js";
import { canonical } from "../framework/serialization/digest.js";
import { moduleReportName } from "../analyse/module-review/report-store.js";
import type { DocumentDiffLine, ModuleDetail } from "./api.js";
import type { SessionView } from "./session-view.js";

/** Метаданные базы, необходимые интерфейсу без передачи всех документов. */
export function metadata(snapshot: Snapshot) {
  return { id: snapshot.id, label: snapshot.label, kind: snapshot.kind,
    capturedAt: snapshot.capturedAt, revision: snapshot.revision,
    baseRevision: snapshot.baseRevision, subject: snapshot.subject, isHead: snapshot.isHead };
}

/** Передаёт только использованные доказательства, а не исходники всего проекта. */
function evidenceForReport(bundle: Pick<ReviewBundle, "report"> & { baseline: Pick<Snapshot, "facts"> | null; current: Pick<Snapshot, "facts"> }) {
  const references = [...bundle.report.checks.flatMap((c) => c.evidence),
    ...bundle.report.findings.flatMap((f) => f.evidence),
    ...Object.values(bundle.report.observed).flatMap((o) => o?.responsibilities.flatMap((r) => r.evidence) ?? [])];
  function facts(side: "baseline" | "current") {
    const ids = new Set(references.filter((r) => r.snapshot === side).map((r) => r.fact_id));
    return (bundle[side]?.facts ?? []).filter((fact) => ids.has(fact.id));
  }
  return { baseline: facts("baseline"), current: facts("current") };
}

/** Дополняет навигацию пунктами сохранённых предков, не расширяя чеклист. */
function referencedContracts(bundle: ReviewEntry) {
  const references = new Set(bundle.report.findings.flatMap(finding => finding.clauses).map(canonical));
  function clauses(side: "baseline" | "current") {
    const declared = new Set(bundle.manifest.contracts[side].map(item => canonical(item.reference)));
    return effectiveClauses(bundle[side], bundle.report.module[`${side}_path`], side, "effective", bundle.manifest.clause_format ?? "legacy")
      .filter(item => references.has(canonical(item.reference)) && !declared.has(canonical(item.reference)));
  }
  return { baseline: clauses("baseline"), current: clauses("current") };
}

/** Разбивает разницу на строки с координатами прежнего и текущего документов. */
function documentDiff(before?: string | null, after?: string | null) {
  let oldLine = 1;
  let newLine = 1;
  const rows: DocumentDiffLine[] = [];
  for (const part of diffLines(before ?? "", after ?? "")) {
    const lines = part.value.split("\n");
    if (lines.at(-1) === "") lines.pop();
    for (const text of lines) rows.push({
      kind: part.added ? "added" : part.removed ? "removed" : "same",
      beforeLine: part.added ? null : oldLine++,
      afterLine: part.removed ? null : newLine++,
      text,
    });
  }
  return rows;
}

function contentFileChanges({ files, before, after }: SessionView["modules"][number]) {
  return files.filter(file => !isModuleDocumentFile(file.path, before?.documentPath) && !isModuleDocumentFile(file.path, after?.documentPath));
}

export function moduleSummary(entry: SessionView["modules"][number]) {
  const { before, after, files, ...module } = entry;
  module.filesChanged = contentFileChanges(entry).length;
  const roles = compareRoles(before?.document.contract, after?.document.contract, module.status !== "initial")
    .filter(role => role.status !== "removed");
  return { ...module, ...(roles.length ? { roles } : {}), ...(isPrototype((after ?? before)?.document.contract) ? { prototypeModule: true } : {}) };
}

export function reviewSummary(matching: ReviewEntry[], model: ReportModel) {
  const latest = matching.find((bundle) => {
    const freshness = model.reviewFreshness(bundle);
    return freshness.current.status === "fresh" && freshness.change.status === "fresh";
  }) ?? matching.find((bundle) => model.reviewFreshness(bundle).current.status === "fresh") ?? matching[0];
  // Прежние записи об изменении контракта сохраняются в истории, но не считаются замечаниями.
  const findings = latest?.report.findings.filter((finding) => finding.kind !== "contract_change") ?? [];
  return latest ? { id: latest.report.id, stale: model.reviewFreshness(latest).current.status !== "fresh",
    assessment: latest.report.assessment, findings: findings.length,
    activeFindings: findings.length ? findings.filter((finding) => finding.lifecycle !== "resolved").length :
      Number(latest.report.assessment.current.verdict === "violation"),
    createdAt: latest.report.analysis.created_at } : null;
}

export function reviewFilePath(root: string, work: string, moduleId: string) {
  return path.relative(root, path.join(work, moduleReportName(moduleId) + ".review.yaml")).split(path.sep).join("/");
}

export function moduleDetail(module: SessionView["modules"][number], matching: ReviewEntry[], model: ReportModel | undefined,
  _modules: SessionView["modules"], root: string, work: string): ModuleDetail {
  const files = contentFileChanges(module);
  const document = (module.after ?? module.before)?.document;
  const yaml = document?.text && document.contract ? currentContractYaml(document.text) : undefined;
  return structuredClone({ ...module, ...(yaml && yaml !== document?.text ? { contractYaml: yaml } : {}),
    files, filesChanged: files.length, reviews: matching.map((bundle) => ({
    report: bundle.report, stale: model!.reviewFreshness(bundle).current.status !== "fresh",
    // Путь берётся из фактического хранилища, включая явно заданное внешнее.
    // ID попытки и замечания выбирают запись внутри общей истории модуля.
    reviewFile: reviewFilePath(root, work, bundle.module_id),
    freshness: model!.reviewFreshness(bundle),
    dependencies: [],
    facts: evidenceForReport(bundle),
    contracts: bundle.manifest.contracts,
    referencedContracts: referencedContracts(bundle),
  })), diff: documentDiff(module.before?.document.text, module.after?.document.text),
  contractDiff: compareContracts(module.before?.document.contract, module.after?.document.contract, module.status !== "initial") } satisfies ModuleDetail);
}
