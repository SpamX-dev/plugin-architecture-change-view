import path from "node:path";
import { diffLines } from "diff";
import { compareContracts, compareRoles } from "../snapshots/contract-diff.js";
import type { Snapshot } from "../snapshots/types.js";
import type { ReportModel } from "../reports/model.js";
import type { ReviewEntry } from "../reports/types.js";
import type { ReviewBundle } from "../reviews/types.js";
import { effectiveClauses } from "../reviews/bundle.js";
import { canonical } from "../serialization/digest.js";
import { moduleReportName } from "../storage/report-store.js";
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
    return effectiveClauses(bundle[side], bundle.report.module[`${side}_path`], side)
      .filter(item => references.has(canonical(item.reference)) && !declared.has(canonical(item.reference)));
  }
  return { baseline: clauses("baseline"), current: clauses("current") };
}

/** Контракт зависимости задаёт предпосылку; он не подтверждает проверенность поставщика. */
function dependencyAssumptions(entry: ReviewEntry, modules: SessionView["modules"]) {
  return (entry.inputs?.current.dependencies ?? []).map(({ selector, available }) => {
    const provider = selector.module_id ? modules.find((module) => module.moduleId === selector.module_id) :
      modules.find((module) => module.after?.files.some((file) => file.path === selector.path));
    return { selector, available, contractOnly: ["contract", "api"].includes(selector.kind),
      providerStatus: provider?.reviewStatus?.self.current ?? null };
  });
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

export function moduleSummary({ before, after, files, ...module }: SessionView["modules"][number]) {
  const roles = compareRoles(before?.document.contract, after?.document.contract, module.status !== "initial")
    .filter(role => role.status !== "removed");
  return roles.length ? { ...module, roles } : module;
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

export function moduleDetail(module: SessionView["modules"][number], matching: ReviewEntry[], model: ReportModel,
  modules: SessionView["modules"], root: string, work: string): ModuleDetail {
  return structuredClone({ ...module, reviews: matching.map((bundle) => ({
    report: bundle.report, stale: model.reviewFreshness(bundle).current.status !== "fresh",
    // Путь берётся из фактического хранилища, включая явно заданное внешнее.
    // ID попытки и замечания выбирают запись внутри общей истории модуля.
    reviewFile: path.relative(root, path.join(work,
      moduleReportName(bundle.module_id) + ".review.yaml")).split(path.sep).join("/"),
    freshness: model.reviewFreshness(bundle),
    dependencies: dependencyAssumptions(bundle, modules),
    facts: evidenceForReport(bundle),
    contracts: bundle.manifest.contracts,
    referencedContracts: referencedContracts(bundle),
  })), diff: documentDiff(module.before?.document.text, module.after?.document.text),
  contractDiff: compareContracts(module.before?.document.contract, module.after?.document.contract, module.status !== "initial") } satisfies ModuleDetail);
}
