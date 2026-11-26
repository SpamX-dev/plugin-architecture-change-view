import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SnapshotStore } from "../../../analyse/git-changes/snapshot-store.js";
import { dependencyCycles } from "../../../analyse/implementation/dependency-cycles.js";
import { hasRelationSources, readRelationGraph, relationGraphPath } from "../../../analyse/module-relations/store.js";
import { moduleId } from "../../../analyse/module-review/module-state.js";
import type { CycleStep, RelationGraph, Site } from "../../../framework/module-relations/types.js";
import { digest } from "../../../framework/serialization/digest.js";
import type { Snapshot } from "../../../framework/snapshots/types.js";
import { errorDetails } from "../../../node-errors.js";

interface RelationEvidence extends Site { from: string; to: string }
interface RelationFinding { summary: string; evidence: RelationEvidence[] }
interface DependencyCycleFinding extends RelationFinding { kind: "dependency_cycle" }
interface RelationReviewReport {
  graphId: string;
  summary: string;
  findings: RelationFinding[];
}

type GraphState =
  | {status: "unsupported"}
  | {status: "unindexed"; message?: string}
  | {status: "indexed"; graphId: string; graph: RelationGraph};

export type RelationReviewStatus = Exclude<GraphState, {status: "indexed"}>
  | {status: "pending"; graphId: string; message?: string}
  | {status: "reviewed"; graphId: string; report: RelationReviewReport; findings: RelationFinding[]};

function graphCycles(graph: RelationGraph) {
  return [...new Set(graph.edges.map(edge => edge.from))].flatMap(owner => dependencyCycles(graph.edges, owner));
}

function cycleFindings(cycles: CycleStep[][]): DependencyCycleFinding[] {
  const findings = new Map<string, DependencyCycleFinding>();
  for (const cycle of cycles) {
    const directories = cycle.map(step => step.from);
    const first = directories.indexOf([...directories].sort()[0]);
    const chain = [...cycle.slice(first), ...cycle.slice(0, first)];
    const route = [...chain.map(step => step.from), chain[0].from];
    const key = JSON.stringify(route);
    if (findings.has(key)) continue;
    findings.set(key, {
      kind: "dependency_cycle",
      summary: "Циклическая зависимость модулей: " + route.join(" → "),
      evidence: chain.map(({from, to, use: {file, line, column}}) => ({from, to, file, line, column})),
    });
  }
  return [...findings.values()];
}

function fields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Ожидался объект отчёта о связях");
  return value as Record<string, unknown>;
}

function summaryText(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Для разбора связей требуется содержательный вывод");
  return value.trim();
}

function siteKey(from: unknown, to: unknown, file: unknown, line: unknown, column: unknown) {
  return JSON.stringify([from, to, file, line, column]);
}

function hasGraphEvidence(graph: RelationGraph) {
  return Number.isSafeInteger(graph.indexed) && graph.indexed > 0 &&
    graph.sources && Array.isArray(graph.edges) && graph.edges.every(edge =>
    edge && typeof edge.from === "string" && typeof edge.to === "string" &&
    Array.isArray(edge.symbols) && edge.symbols.length > 0 && edge.symbols.every(symbol =>
      symbol && typeof symbol.id === "string" && Array.isArray(symbol.uses) && symbol.uses.length > 0 &&
      symbol.uses.every((use: Site) => use && typeof use.file === "string" &&
        Object.hasOwn(graph.sources, use.file) && typeof graph.sources[use.file] === "string" &&
        Number.isSafeInteger(use.line) && use.line > 0 && Number.isSafeInteger(use.column) && use.column > 0)));
}

function readReport(value: unknown, graphId: string, graph: RelationGraph): RelationReviewReport {
  const report = fields(value);
  if (report.graphId !== graphId) throw new Error("Граф связей изменился. Требуется разбор текущего graphId");
  const summary = summaryText(report.summary);
  if (!Array.isArray(report.findings)) throw new Error("Ожидался список замечаний о связях");
  const sites = new Set<string>();
  if (report.findings.length) {
    for (const {from, to, symbols} of graph.edges) {
      for (const symbol of symbols) for (const use of symbol.uses) {
        sites.add(siteKey(from, to, use.file, use.line, use.column));
      }
    }
  }
  const findings = report.findings.map(value => {
    const finding = fields(value);
    const summary = summaryText(finding.summary);
    if (!Array.isArray(finding.evidence) || !finding.evidence.length)
      throw new Error("Замечание о связях требует доказательства из графа");
    const evidence = finding.evidence.map(value => {
      const {from, to, file, line, column} = fields(value);
      if (typeof from !== "string" || typeof to !== "string" || typeof file !== "string" ||
          typeof line !== "number" || typeof column !== "number" || !sites.has(siteKey(from, to, file, line, column)))
        throw new Error("Доказательство отсутствует в актуальном графе связей");
      return {from, to, file, line, column};
    });
    return {summary, evidence};
  });
  return {graphId, summary, findings};
}

/** Keeps the substantive review tied to both the SCIP graph and the module contracts it was checked against. */
export class RelationReviews {
  constructor(private store: SnapshotStore) {}

  private async target(snapshot: Snapshot): Promise<GraphState> {
    if (!snapshot.complete) throw new Error("Неполное рабочее дерево: " + snapshot.diagnostics.join("; "));
    if (!hasRelationSources(snapshot)) return {status:"unsupported"};
    let graph: RelationGraph | null;
    try { graph = await readRelationGraph(this.store.root, this.store.directory, snapshot); }
    catch (error) { return {status:"unindexed", message:errorDetails(error).message}; }
    if (!graph) return {status:"unindexed"};
    if (!hasGraphEvidence(graph)) return {status:"unindexed", message:"Сохранённый граф не содержит корректных доказательств связей"};
    const contracts = snapshot.modules.map(module => [module.directory, module.document.contract]);
    const graphId = digest([graph.version, graph.indexer, graph.inputs, graph.edges, contracts]);
    return {status:"indexed", graphId, graph};
  }

  private async reportPath(graphId: string) {
    const file = path.join(this.store.directory, "snapshots", "relation-reviews", graphId.slice(7) + ".json");
    await this.store.assertLocation(file);
    return file;
  }

  async status(snapshot: Snapshot): Promise<RelationReviewStatus> {
    const target = await this.target(snapshot);
    if (target.status !== "indexed") return target;
    const {graphId, graph} = target;
    let report: RelationReviewReport;
    try {
      const file = await this.reportPath(graphId);
      report = readReport(JSON.parse(await readFile(file, "utf8")), graphId, graph);
    } catch (error) {
      const message = errorDetails(error);
      return {status:"pending", graphId, ...(message.code !== "ENOENT" && {message:message.message})};
    }
    return {status:"reviewed", graphId, report, findings:[...cycleFindings(graphCycles(graph)), ...report.findings]};
  }

  private async indexed(snapshot: Snapshot) {
    const target = await this.target(snapshot);
    if (target.status === "unsupported") throw new Error("В рабочем дереве нет файлов TypeScript или JavaScript");
    if (target.status === "unindexed") throw new Error("Сначала постройте актуальный граф через --build-relations");
    return target;
  }

  async input(snapshot: Snapshot) {
    const {graphId, graph} = await this.indexed(snapshot);
    return {
      graphId,
      graphFile: relationGraphPath(this.store.directory, graph.inputs),
      indexer: graph.indexer,
      indexed: graph.indexed,
      eligible: graph.eligible,
      edges: graph.edges.length,
      modules: snapshot.modules.map(module => ({id:moduleId(module), directory:module.directory})),
      cycles: graphCycles(graph),
    };
  }

  async complete(snapshot: Snapshot, value: unknown) {
    const {graphId, graph} = await this.indexed(snapshot);
    const report = readReport(value, graphId, graph);
    const file = await this.reportPath(graphId);
    await mkdir(path.dirname(file), {recursive:true});
    const temporary = file + "." + randomUUID();
    try {
      await writeFile(temporary, JSON.stringify(report, null, 2) + "\n", {flag:"wx"});
      await rename(temporary, file);
    } finally { await rm(temporary, {force:true}); }
    return {graphId, reportFile:file};
  }
}
