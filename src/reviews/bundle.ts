import type { SnapshotData, SnapshotModule, Snapshot, ComparisonModule } from "../snapshots/types.js";
import type {
  Side, ReviewBundle, ReviewReport, ReviewManifest, ClauseReference, ClauseInput,
  ClauseCheck, Finding, EvidenceReference,
} from "./types.js";
/**
 * Проверка структуры и связи отчёта со снимками. Не выводит семантику кода:
 * пункты ответственности получают not_checked, а наблюдения — явное ограничение.
 * Полноценный внешний анализ использует тот же формат и сохранённые доказательства.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { canonical, digest } from "../serialization/digest.js";
import { validateReview } from "./schema.js";
import { snapshotDigest } from "../snapshots/identity.js";

/** Версия включает алгоритм структурной проверки; настройки участвуют в manifest. */
export const ANALYZER = { name: "archiview-structure", version: "1.0.2",
  config_digest: digest({ semantic: false, inherited: ["boundaries", "invariants"] }) };

/** Точная ссылка на сохранённое содержание, независимо от пользовательской метки. */
export const snapshotReference = (snapshot: Snapshot | null | undefined) => snapshot ?
  { id: snapshot.id, digest: snapshot.digest ?? snapshotDigest(snapshot) } : null;

/**
 * Собственная проверка содержит только локальный контракт. Режим effective
 * нужен для проверки целостности прежних неизменяемых отчётов с пунктами предков.
 */
export function effectiveClauses(snapshot: SnapshotData | null, directory: string | null | undefined, side: Side, contractScope = "effective"): ClauseInput[] {
  if (!["own", "effective"].includes(contractScope)) throw new Error("Unsupported contract scope");
  if (!snapshot || directory == null) return [];
  const parents = new Set([directory]);
  let parent = directory;
  while (contractScope === "effective" && parent !== ".") { parent = path.posix.dirname(parent); parents.add(parent); }
  return snapshot.modules.filter((m) => parents.has(m.directory) && m.document.state === "documented" && m.document.contract)
    .flatMap((m) => (["responsibilities", "boundaries", "invariants"] as const)
      .filter((section) => section !== "responsibilities" || m.directory === directory)
      .flatMap((section) => Object.entries(m.document.contract![section]).map(([id, text]) => ({
        reference: { snapshot: side, module_id: m.document.contract!.id, section, id }, text,
      }))));
}

type ReviewedModule = Pick<ComparisonModule, "moduleId" | "baselinePath" | "currentPath" | "before" | "after">;

/** Манифест отделяет собственный чеклист от сохранённого контекста предков. */
export function reviewManifest(before: Snapshot | null, after: Snapshot, module: ReviewedModule, analyzer = ANALYZER, contractScope = "own"): ReviewManifest {
  return { schema_version: 1, comparison: { baseline: snapshotReference(before), current: snapshotReference(after) },
    module: { id: module.moduleId ?? null, baseline_path: module.baselinePath ?? null, current_path: module.currentPath ?? null },
    analyzer, scope: "module", ...(contractScope === "own" ? { contract_scope: "own" } : {}), contracts: {
      baseline: effectiveClauses(before, module.baselinePath, "baseline", contractScope),
      current: effectiveClauses(after, module.currentPath, "current", contractScope),
    }, instructions: "Проверять структуру контрактов; смысл кода не анализировать.", context: {} };
}

/**
 * База и текущее состояние проверяются отдельно. Повторная проверка текущего
 * кода по базовому пункту нужна лишь при изменении или удалении этого пункта;
 * старый формат сохраняет первоначальные требования к набору проверок.
 */
export function requiredClauseChecks(manifest: ReviewManifest, hasCurrent: boolean) {
  const baseline = manifest.contracts?.baseline ?? [];
  const current = manifest.contracts?.current ?? [];
  const previousRequirements = manifest.contract_scope === "own" ? baseline.filter((item) =>
    !current.some((other) => other.reference.module_id === item.reference.module_id &&
      other.reference.section === item.reference.section && other.reference.id === item.reference.id && other.text === item.text)) : baseline;
  return [...baseline.map((item) => ({ item, subject: "baseline" as const })),
    ...current.map((item) => ({ item, subject: "current" as const })),
    ...(hasCurrent ? previousRequirements.map((item) => ({ item, subject: "current" as const })) : [])];
}

/** Новый локальный чеклист не может расширяться пунктами чужого контракта. */
export function validateContractScope(report: ReviewReport, manifest: ReviewManifest) {
  const scope = manifest.contract_scope ?? "effective";
  if (!["own", "effective"].includes(scope)) throw new Error("Unsupported contract scope");
  if (scope === "own" && report.checks.some((check) => check.contract.module_id !== report.module.id))
    throw new Error("Own review checks must reference the module contract");
  const clauses = new Set([...manifest.contracts.baseline, ...manifest.contracts.current].map((item) => canonical(item.reference)));
  if (report.checks.some((check) => !clauses.has(canonical(check.contract))))
    throw new Error("Review check references a clause outside the manifest");
  if (scope === "own" && report.findings.some((finding) => finding.clauses.length &&
    !finding.clauses.some((clause) => clause.module_id === report.module.id)))
    throw new Error("Own review finding must reference the module contract");
  return scope;
}

/** Формирует честный частичный отчёт без подмены анализа наличием документов. */
export function createStructuralReview(before: Snapshot | null, after: Snapshot, module: ReviewedModule, { contractScope = "own" }: {contractScope?:string} = {}): ReviewBundle {
  const manifest = reviewManifest(before, after, module, ANALYZER, contractScope);
  const limitations = ["Семантика кода не анализировалась. Соответствие обязанностям, границам и инвариантам требует отдельного анализа.",
    ...before?.evidenceLimitations ?? [], ...after.evidenceLimitations ?? []];
  const findings: Finding[] = [];
  const checks: ClauseCheck[] = [];
  const fact = (snapshot: Snapshot | null, side: Side, kind: string, file: string): EvidenceReference[] => (snapshot?.facts ?? [])
    .filter((f) => f.kind === kind && f.path === file).map((f) => ({ snapshot: side, fact_id: f.id }));
  for (const [snapshot, side, entry] of ([[before, "baseline", module.before], [after, "current", module.after]] as const)) {
    if (!entry) continue;
    if (!entry.document.contract || entry.document.state !== "documented") {
      const evidence = fact(snapshot, side, "module", entry.directory);
      const migrated = side === "baseline" && entry.document.state !== "invalid" && module.after?.document.state === "documented" && module.after.document.contract;
      if (migrated) evidence.push(...fact(after, "current", "module", module.after!.directory));
      if (evidence.length) findings.push({ id: "contract-" + side,
        kind: entry.document.state === "invalid" ? "contract_conflict" : "missing_contract",
        certainty: "confirmed", severity: migrated ? "info" : "warning", lifecycle: migrated ? "resolved" : "unknown",
        summary: (side === "baseline" ? "В базовом снимке: " : "") + (entry.document.state === "invalid" ? "контракт не соответствует схеме v1." :
          entry.document.format === "module.md" ? "контракт хранится в module.md." : "нет действующего arch.yaml."),
        details: migrated ? "В текущем снимке arch.yaml уже создан. Базовый снимок сохраняется неизменным; наличие нового контракта не подтверждает соответствие кода его смыслу." :
          entry.document.errors?.join("\n") ?? "Для проверки пунктов нужен arch.yaml. Подготовьте текущий контракт согласно скиллу; исторические снимки не переписываются.",
        clauses: [], evidence });
      else limitations.push(side + ": снимок прежнего формата не содержит фактов о модуле.");
    }
  }
  for (const { item, subject } of requiredClauseChecks(manifest, Boolean(module.after))) {
    checks.push({ id: "check-" + (checks.length + 1), contract: item.reference,
      subject, verdict: "not_checked", explanation: "Структурный анализ не определяет соответствие кода этому пункту.", evidence: [] });
  }
  const observed = (entry: SnapshotModule | null | undefined) => entry ? { summary: "Обнаружено собственных исходных файлов: " + entry.sourceFiles +
    ". Ответственность из кода не выводилась.", responsibilities: [] } : null;
  const report: ReviewReport = { schema_version: 1, id: "review-" + randomUUID(), module: manifest.module,
    comparison: manifest.comparison,
    analysis: { created_at: new Date().toISOString(), analyzer: ANALYZER,
      input_digest: digest(manifest), scope: "module", coverage: { status: "partial", limitations } },
    observed: { baseline: observed(module.before), current: observed(module.after) }, checks, findings,
    assessment: {
      current: { verdict: !module.after ? "not_applicable" : findings.some((f) => f.id === "contract-current") ? "needs_review" : "inconclusive",
        summary: !module.after ? "Модуль отсутствует в текущем снимке." : "Структура проверена; соответствие кода контракту не установлено." },
      change: { verdict: !before ? "not_applicable" : "inconclusive",
        summary: !before ? "Первый анализ без базового снимка." : "Изменения файлов зафиксированы; оценка ответственности требует анализа кода." },
    } };
  validateReviewBundle({ report, manifest, baseline: before, current: after });
  return { report, manifest, baseline: before, current: after };
}

/** Проверяет происхождение отчёта: хеши, пути, пункты контрактов и каждый факт. */
export function validateReviewBundle(bundle: ReviewBundle) {
  const { report, manifest, baseline, current } = bundle;
  validateReview(report);
  if (!manifest || digest(manifest) !== report.analysis.input_digest) throw new Error("Review input digest mismatch");
  validateContractScope(report, manifest);
  if (digest(manifest.comparison) !== digest(report.comparison) || digest(manifest.module) !== digest(report.module) ||
      digest(manifest.analyzer) !== digest(report.analysis.analyzer) || manifest.scope !== report.analysis.scope) throw new Error("Review manifest mismatch");
  if (report.analysis.model && (digest(manifest.model) !== digest(report.analysis.model) || manifest.prompt_digest !== report.analysis.prompt_digest)) throw new Error("Review model inputs mismatch");
  if (!current || (baseline && baseline.root !== current.root)) throw new Error("Foreign review snapshot");
  for (const [side, snapshot] of ([["baseline", baseline], ["current", current]] as const)) {
    const reference = report.comparison[side];
    if ((snapshot == null) !== (reference === null)) throw new Error("Missing " + side + " snapshot");
    if (snapshot && (snapshot.id !== reference?.id || snapshotDigest(snapshot) !== reference?.digest)) throw new Error("Review snapshot digest mismatch: " + side);
    const directory = report.module[`${side}_path`];
    const module = snapshot?.modules.find((m) => m.directory === directory);
    if (directory !== null && !module) throw new Error("Review module path is missing: " + side);
    if (module?.document.contract && report.module.id !== null && module.document.contract.id !== report.module.id) throw new Error("Review module identity mismatch");
    if (digest(manifest.contracts?.[side]) !== digest(effectiveClauses(snapshot, directory, side,
      manifest.contract_scope ?? "effective"))) throw new Error("Effective contracts mismatch: " + side);
  }
  const resolveClause = (ref: ClauseReference) => {
    const snapshot = ref.snapshot === "baseline" ? baseline : current;
    const matches = snapshot?.modules.filter((m) => m.document.state === "documented" && m.document.contract?.id === ref.module_id) ?? [];
    if (matches.length !== 1 || !Object.hasOwn(matches[0].document.contract![ref.section], ref.id)) throw new Error("Unresolved contract clause: " + ref.module_id + "/" + ref.id);
  };
  const resolveEvidence = (ref: EvidenceReference) => {
    const snapshot = ref.snapshot === "baseline" ? baseline : current;
    const matches = snapshot?.facts?.filter((f) => f.id === ref.fact_id) ?? [];
    if (matches.length !== 1 || typeof matches[0].text !== "string") throw new Error("Unresolved evidence: " + ref.fact_id);
    const { id, ...fact } = matches[0];
    if (digest(fact) !== id) throw new Error("Evidence content digest mismatch");
  };
  for (const check of report.checks) {
    resolveClause(check.contract);
    if (report.module[`${check.subject}_path`] === null) throw new Error("Check subject is absent");
    check.evidence.forEach(resolveEvidence);
  }
  for (const finding of report.findings) { finding.clauses.forEach(resolveClause); finding.evidence.forEach(resolveEvidence); }
  for (const observed of Object.values(report.observed)) observed?.responsibilities.forEach((r) => r.evidence.forEach(resolveEvidence));
  for (const { item, subject } of requiredClauseChecks(manifest, report.module.current_path !== null)) {
    if (!report.checks.some((c) => c.subject === subject && digest(c.contract) === digest(item.reference))) throw new Error("Missing explicit clause check: " + item.reference.id);
  }
  return bundle;
}
