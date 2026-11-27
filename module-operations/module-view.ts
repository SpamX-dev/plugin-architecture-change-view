import type { FindingDecisions } from "../analyse/module-review/dispositions.js";
import type { ModuleReviewState } from "./api.js";
import path from "node:path";
import { isModuleDocumentFile } from "../framework/project/storage-paths.js";
import { isPrototype } from "../framework/contracts/types.js";
import { currentContractYaml } from "../framework/contracts/document.js";
import { diffLines } from "diff";
import { compareContracts, compareRoles } from "../analyse/git-changes/contract-diff.js";
import type { ChangeStatus, FileChange, Snapshot } from "../framework/snapshots/types.js";
import type { ReportModel } from "../analyse/module-review/model.js";
import type { ReviewEntry } from "../framework/static-report/types.js";
import { normalizeAnalysisType, type AnalysisType, type ReviewBundle } from "../framework/ai-report/types.js";
import { effectiveClauses } from "../analyse/module-review/bundle.js";
import { canonical } from "../framework/serialization/digest.js";
import { moduleReportName } from "../analyse/module-review/report-store.js";
import type { DocumentDiffLine, ModuleDetail, ModuleSummary } from "./api.js";
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
    if (normalizeAnalysisType(bundle.manifest.analysis_type) === "composition") return (bundle[side]?.modules ?? []).flatMap(module =>
      effectiveClauses(bundle[side], module.directory, side, "own").filter(item => references.has(canonical(item.reference)) && !declared.has(canonical(item.reference))));
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

function filesStatus(changes: FileChange[], initial: boolean): ChangeStatus {
  if (!changes.length) return "unchanged";
  if (initial) return "initial";
  const { status } = changes[0];
  return (status === "new" || status === "removed") && changes.every(file => file.status === status) ? status : "changed";
}

function contractStatus({ before, after, status, documentChanged }: SessionView["modules"][number]): ModuleSummary["contractStatus"] {
  const previousText = before?.document.text;
  const currentText = after?.document.text;
  if (previousText != null && currentText != null) return documentChanged ? "changed" : "unchanged";
  // An invalid registry cannot identify the contract file for its directory.
  if ((before?.document.state === "invalid" && previousText == null) ||
      (after?.document.state === "invalid" && currentText == null)) return "unavailable";
  const previousFile = before?.files.find(file => isModuleDocumentFile(file.path, before.documentPath));
  const currentFile = after?.files.find(file => isModuleDocumentFile(file.path, after.documentPath));
  const hadContract = previousText != null || Boolean(previousFile);
  const hasContract = currentText != null || Boolean(currentFile);
  if (hasContract && status === "initial") return "initial";
  if (!hadContract) return hasContract ? "new" : "unchanged";
  if (!hasContract) return "removed";
  if (!previousFile?.hash || !currentFile?.hash) return "unavailable";
  return previousFile.hash === currentFile.hash ? "unchanged" : "changed";
}

export function moduleSummary(entry: SessionView["modules"][number]): ModuleSummary {
  const { before, after, files, ...module } = entry;
  const changes = contentFileChanges(entry);
  const roles = compareRoles(before?.document.contract, after?.document.contract, module.status !== "initial")
    .filter(role => role.status !== "removed");
  return { ...module, filesChanged: changes.length, filesStatus: filesStatus(changes, module.status === "initial"),
    contractStatus: contractStatus(entry), ...(roles.length ? { roles } : {}),
    ...(isPrototype((after ?? before)?.document.contract) ? { prototypeModule: true } : {}) };
}

export function reviewSummary(matching: ReviewEntry[], model: ReportModel) {
  matching = matching.filter(entry => !entry.manifest.analysis_type);
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

/** Prefer the result of this slice over a carried-forward result, including after late imports. */
export async function currentAnalysisEntries(entries: ReviewEntry[], model: ReportModel, target: Snapshot, follows: (entry: ReviewEntry) => Promise<boolean>) {
  const selected = new Map<AnalysisType, ReviewEntry>();
  const exact = (entry: ReviewEntry) => entry.manifest.source_snapshot?.id === target.id &&
    (target.revision || entry.manifest.source_snapshot.digest === target.digest) ? 1 : 0;
  const ordered = [...entries].sort((a, b) => exact(b) - exact(a) || (b.registration_order ?? 0) - (a.registration_order ?? 0));
  for (const entry of ordered) {
    const type = normalizeAnalysisType(entry.manifest.analysis_type);
    if (!type || selected.has(type) || model.reviewFreshness(entry).current.status !== "fresh") continue;
    if (await follows(entry)) selected.set(type, entry);
  }
  return [...selected.values()];
}

export async function analysisSummary(entries: ReviewEntry[], decisions: Pick<FindingDecisions, "read">, details: ModuleDetail["reviews"] = []) {
  const analyses: NonNullable<ModuleReviewState["analyses"]> = {};
  for (const entry of entries) {
    const type = normalizeAnalysisType(entry.manifest.analysis_type);
    if (!type) continue;
    const states = await decisions.read(entry.review_id);
    const detail = details.find(review => review.report.id === entry.review_id);
    if (detail) detail.dispositions = states;
    const findings = entry.report.findings.filter(item => item.kind !== "contract_change");
    const open = findings.length ? findings.filter(item => (states[item.id]?.status ?? (item.lifecycle === "resolved" ? "resolved" : "open")) === "open").length :
      Number(entry.report.assessment.current.verdict === "violation" && (states["assessment-summary"]?.status ?? "open") === "open");
    analyses[type] = {id:entry.review_id, openFindings:open};
  }
  return analyses;
}

export function reviewFilePath(root: string, work: string, moduleId: string) {
  return path.relative(root, path.join(work, moduleReportName(moduleId) + ".analysis.yaml")).split(path.sep).join("/");
}

export function moduleDetail(module: SessionView["modules"][number], matching: ReviewEntry[], model: ReportModel | undefined,
  _modules: SessionView["modules"], root: string, work: string): ModuleDetail {
  const files = contentFileChanges(module);
  const document = (module.after ?? module.before)?.document;
  const yaml = document?.text && document.contract ? currentContractYaml(document.text) : undefined;
  return structuredClone({ ...module, ...(yaml && yaml !== document?.text ? { contractYaml: yaml } : {}),
    files, filesChanged: files.length, reviews: matching.map((bundle) => ({
    analysisType: normalizeAnalysisType(bundle.manifest.analysis_type), report: bundle.report, stale: model!.reviewFreshness(bundle).current.status !== "fresh",
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
