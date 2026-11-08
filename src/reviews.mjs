/**
 * Проверка структуры и связи отчёта со снимками. Не выводит семантику кода:
 * пункты ответственности получают not_checked, а наблюдения — явное ограничение.
 * Полноценный внешний анализ использует тот же формат и сохранённые доказательства.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { digest, validateReview } from "./formats.mjs";
import { snapshotDigest } from "./snapshots.mjs";

/** Версия включает алгоритм структурной проверки; настройки участвуют в manifest. */
export const ANALYZER = { name: "archiview-structure", version: "1.0.1",
  config_digest: digest({ semantic: false, inherited: ["boundaries", "invariants"] }) };

/** Точная ссылка на сохранённое содержание, независимо от пользовательской метки. */
export const snapshotReference = (snapshot) => snapshot ?
  { id: snapshot.id, digest: snapshot.digest ?? snapshotDigest(snapshot) } : null;

/** Выбирает собственные пункты и ограничения предков, от корня к модулю. */
export function effectiveClauses(snapshot, directory, side) {
  if (!snapshot || directory === null) return [];
  const parents = new Set([directory]);
  let parent = directory;
  while (parent !== ".") { parent = path.posix.dirname(parent); parents.add(parent); }
  return snapshot.modules.filter((m) => parents.has(m.directory) && m.document.state === "documented" && m.document.contract)
    .flatMap((m) => ["responsibilities", "boundaries", "invariants"]
      .filter((section) => section !== "responsibilities" || m.directory === directory)
      .flatMap((section) => Object.entries(m.document.contract[section]).map(([id, text]) => ({
        reference: { snapshot: side, module_id: m.document.contract.id, section, id }, text,
      }))));
}

/** Манифест фиксирует все использованные входы, включая действовавшие ограничения. */
export function reviewManifest(before, after, module, analyzer = ANALYZER) {
  return { schema_version: 1, comparison: { baseline: snapshotReference(before), current: snapshotReference(after) },
    module: { id: module.moduleId ?? null, baseline_path: module.baselinePath, current_path: module.currentPath },
    analyzer, scope: "module", contracts: {
      baseline: effectiveClauses(before, module.baselinePath, "baseline"),
      current: effectiveClauses(after, module.currentPath, "current"),
    }, instructions: "Проверять структуру контрактов; смысл кода не анализировать.", context: {} };
}

/** Формирует честный частичный отчёт без подмены анализа наличием документов. */
export function createStructuralReview(before, after, module) {
  const manifest = reviewManifest(before, after, module);
  const limitations = ["Семантика кода не анализировалась. Соответствие обязанностям, границам и инвариантам требует отдельного анализа.",
    ...before?.evidenceLimitations ?? [], ...after.evidenceLimitations ?? []];
  const findings = [];
  const checks = [];
  const fact = (snapshot, side, kind, file) => (snapshot?.facts ?? [])
    .filter((f) => f.kind === kind && f.path === file).map((f) => ({ snapshot: side, fact_id: f.id }));
  for (const [snapshot, side, entry] of [[before, "baseline", module.before], [after, "current", module.after]]) {
    if (!entry) continue;
    if (!entry.document.contract || entry.document.state !== "documented") {
      const evidence = fact(snapshot, side, "module", entry.directory);
      const migrated = side === "baseline" && entry.document.state !== "invalid" && module.after?.document.state === "documented" && module.after.document.contract;
      if (migrated) evidence.push(...fact(after, "current", "module", module.after.directory));
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
  const beforeContract = module.before?.document.contract;
  const afterContract = module.after?.document.contract;
  if (before && module.before && module.after && digest(beforeContract ?? null) !== digest(afterContract ?? null)) {
    const evidence = [...fact(before, "baseline", "file", module.before.documentPath),
      ...fact(after, "current", "file", module.after.documentPath)];
    if (evidence.length) findings.push({ id: "contract-change", kind: "contract_change",
      certainty: "confirmed", severity: "info", lifecycle: "introduced",
      summary: "Изменился принятый контракт модуля.",
      details: "Изменение текста само по себе не доказывает выход за границы или согласование новых обязанностей.",
      clauses: [], evidence });
  }
  for (const [clauses, subject] of [[manifest.contracts.baseline, "baseline"],
    [manifest.contracts.current, "current"], ...(module.after ? [[manifest.contracts.baseline, "current"]] : [])]) {
    for (const item of clauses) checks.push({ id: "check-" + (checks.length + 1), contract: item.reference,
      subject, verdict: "not_checked", explanation: "Структурный анализ не определяет соответствие кода этому пункту.", evidence: [] });
  }
  const observed = (entry) => entry ? { summary: "Обнаружено собственных исходных файлов: " + entry.sourceFiles +
    ". Ответственность из кода не выводилась.", responsibilities: [] } : null;
  const report = { schema_version: 1, id: "review-" + randomUUID(), module: manifest.module,
    comparison: manifest.comparison,
    analysis: { created_at: new Date().toISOString(), analyzer: ANALYZER,
      input_digest: digest(manifest), scope: "module", coverage: { status: "partial", limitations } },
    observed: { baseline: observed(module.before), current: observed(module.after) }, checks, findings,
    assessment: {
      current: { verdict: !module.after ? "not_applicable" : findings.some((f) => f.id === "contract-current") ? "needs_review" : "inconclusive",
        summary: !module.after ? "Модуль отсутствует в текущем снимке." : "Структура проверена; соответствие кода контракту не установлено." },
      change: { verdict: !before ? "not_applicable" : findings.some((f) => f.kind === "contract_change") ? "needs_review" : "inconclusive",
        summary: !before ? "Первый анализ без базового снимка." : "Изменения файлов зафиксированы; оценка ответственности требует анализа кода." },
    } };
  validateReviewBundle({ report, manifest, baseline: before, current: after });
  return { report, manifest, baseline: before, current: after };
}

/** Проверяет происхождение отчёта: хеши, пути, пункты контрактов и каждый факт. */
export function validateReviewBundle(bundle) {
  const { report, manifest, baseline, current } = bundle;
  validateReview(report);
  if (!manifest || digest(manifest) !== report.analysis.input_digest) throw new Error("Review input digest mismatch");
  if (digest(manifest.comparison) !== digest(report.comparison) || digest(manifest.module) !== digest(report.module) ||
      digest(manifest.analyzer) !== digest(report.analysis.analyzer) || manifest.scope !== report.analysis.scope) throw new Error("Review manifest mismatch");
  if (report.analysis.model && (digest(manifest.model) !== digest(report.analysis.model) || manifest.prompt_digest !== report.analysis.prompt_digest)) throw new Error("Review model inputs mismatch");
  if (!current || (baseline && baseline.root !== current.root)) throw new Error("Foreign review snapshot");
  for (const [side, snapshot] of [["baseline", baseline], ["current", current]]) {
    const reference = report.comparison[side];
    if ((snapshot == null) !== (reference === null)) throw new Error("Missing " + side + " snapshot");
    if (snapshot && (snapshot.id !== reference.id || snapshotDigest(snapshot) !== reference.digest)) throw new Error("Review snapshot digest mismatch: " + side);
    const directory = report.module[side + "_path"];
    const module = snapshot?.modules.find((m) => m.directory === directory);
    if (directory !== null && !module) throw new Error("Review module path is missing: " + side);
    if (module?.document.contract && report.module.id !== null && module.document.contract.id !== report.module.id) throw new Error("Review module identity mismatch");
    if (digest(manifest.contracts?.[side]) !== digest(effectiveClauses(snapshot, directory, side))) throw new Error("Effective contracts mismatch: " + side);
  }
  const resolveClause = (ref) => {
    const snapshot = ref.snapshot === "baseline" ? baseline : current;
    const matches = snapshot?.modules.filter((m) => m.document.state === "documented" && m.document.contract?.id === ref.module_id) ?? [];
    if (matches.length !== 1 || !Object.hasOwn(matches[0].document.contract[ref.section], ref.id)) throw new Error("Unresolved contract clause: " + ref.module_id + "/" + ref.id);
  };
  const resolveEvidence = (ref) => {
    const snapshot = ref.snapshot === "baseline" ? baseline : current;
    const matches = snapshot?.facts?.filter((f) => f.id === ref.fact_id) ?? [];
    if (matches.length !== 1 || typeof matches[0].text !== "string") throw new Error("Unresolved evidence: " + ref.fact_id);
    const { id, ...fact } = matches[0];
    if (digest(fact) !== id) throw new Error("Evidence content digest mismatch");
  };
  for (const check of report.checks) {
    resolveClause(check.contract);
    if (report.module[check.subject + "_path"] === null) throw new Error("Check subject is absent");
    check.evidence.forEach(resolveEvidence);
  }
  for (const finding of report.findings) { finding.clauses.forEach(resolveClause); finding.evidence.forEach(resolveEvidence); }
  for (const observed of Object.values(report.observed)) observed?.responsibilities.forEach((r) => r.evidence.forEach(resolveEvidence));
  for (const [clauses, subject] of [[manifest.contracts.baseline, "baseline"], [manifest.contracts.current, "current"],
    ...(report.module.current_path !== null ? [[manifest.contracts.baseline, "current"]] : [])]) {
    for (const item of clauses) if (!report.checks.some((c) => c.subject === subject && digest(c.contract) === digest(item.reference))) throw new Error("Missing explicit clause check: " + item.reference.id);
  }
  return bundle;
}

/** Устаревание вычисляется снаружи отчёта и никогда не записывается в review.yaml. */
export function reviewIsStale(bundle, before, after) {
  return (bundle.report.analysis.analyzer.name === ANALYZER.name && digest(bundle.report.analysis.analyzer) !== digest(ANALYZER)) ||
    bundle.report.comparison.current.digest !== snapshotDigest(after) ||
    (bundle.report.comparison.baseline?.digest ?? null) !== (before ? snapshotDigest(before) : null);
}
