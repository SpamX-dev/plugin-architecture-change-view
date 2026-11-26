import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fromBinary } from "@bufbuild/protobuf";
import { IndexSchema } from "@scip-code/scip";
import { digest } from "../../framework/serialization/digest.js";
import type { Snapshot } from "../../framework/snapshots/types.js";
import { errorDetails } from "../../node-errors.js";
import { assertStateLocation, projectStateDirectory } from "../../storage/paths.js";
import { regularProjectFile } from "../project-sources/source-files.js";
import { excludedProjectPath } from "../../framework/project/paths.js";
import { GitTreeReader } from "../git-changes/git-tree.js";
import { readGitHeadRevision } from "../git-changes/capture.js";
import type { RelationGraph } from "../../framework/module-relations/types.js";
import { directImportEdges, extractEdges, indexImportSites, projectDocuments, supportsFile } from "./graph.js";
import { inferredProject } from "./inferred-project.js";

declare const ARCHIVIEW_SCIP_WORKER: string;
const run = promisify(execFile);
const active = new Map<string, Promise<RelationGraph>>();

export class RelationBuildError extends Error {
  constructor(readonly code: "INCOMPLETE_VIEW" | "STALE_VIEW" | "INVALID_ARGUMENT", message: string) { super(message); }
}

/** A saved evidence snapshot and a lightweight Git view of the same files share this key. */
function inputs(snapshot: Snapshot) {
  return digest([snapshot.root, snapshot.modules.map(m => [m.directory, m.documentPath,
    m.files.map(f => [f.path, f.hash, f.mode ?? "100644"])])]);
}

function graphPath(directory: string, key: string) {
  return path.join(directory, "snapshots", "relations", key.slice(7) + ".json");
}

export async function readRelationGraph(root: string, state: string | undefined, snapshot: Snapshot) {
  if (!snapshot.complete) return null;
  const directory = projectStateDirectory(root, state);
  const key = inputs(snapshot);
  const file = graphPath(directory, key);
  await assertStateLocation(root, directory, file);
  try {
    const graph: RelationGraph = JSON.parse(await readFile(file, "utf8"));
    if (![1, 2, 3, 4, 5].includes(graph.version) || graph.inputs !== key) throw new Error("Некорректный сохранённый граф связей");
    if (graph.indexed !== graph.eligible) return null;
    // Live callers can rebuild older indexes with location-specific TypeScript resolution.
    if (graph.version < 5 && snapshot.kind === "working") return null;
    if (graph.version === 1) graph.edges = await directImportEdges(graph.edges, graph.sources);
    return graph;
  } catch (cause) {
    if (errorDetails(cause).code === "ENOENT") return null;
    throw cause;
  }
}

export function rebuildRelationGraph(root: string, state: string | undefined, snapshot: Snapshot): Promise<RelationGraph> {
  const directory = projectStateDirectory(root, state);
  const key = inputs(snapshot);
  const destination = graphPath(directory, key);
  const pending = active.get(destination);
  if (pending) return pending;
  const task = build(root, directory, snapshot, key, destination).finally(() => active.delete(destination));
  active.set(destination, task);
  return task;
}

async function build(root: string, directory: string, snapshot: Snapshot, key: string, destination: string): Promise<RelationGraph> {
  if (!snapshot.complete) throw new RelationBuildError("INCOMPLETE_VIEW", "Для построения связей нужен полный снимок.");
  const reader = new GitTreeReader(root, snapshot.root);
  async function verifyInputs() {
    const current = await reader.working(await readGitHeadRevision(root));
    if (!current.complete || inputs(current) !== key) throw new RelationBuildError("STALE_VIEW", "Рабочее дерево изменилось. Обновите сравнение и повторите построение.");
  }
  await verifyInputs();
  const owners = new Map(snapshot.modules.flatMap(m =>
    m.files.filter(f => !excludedProjectPath(f.path)).map(f => [f.path, m.directory] as const)));
  const eligible = [...owners.keys()].filter(supportsFile);
  if (!eligible.length) throw new RelationBuildError("INVALID_ARGUMENT", "В снимке нет файлов TypeScript или JavaScript.");
  const tempRoot = await realpath(tmpdir());
  const temp = await mkdtemp(path.join(tempRoot, "archiview-scip-"));
  const output = path.join(temp, "index.scip");
  try {
    const projects = [...owners.keys()].filter(file => /^(?:ts|js)config\.json$/.test(path.posix.basename(file)));
    const worker = typeof ARCHIVIEW_SCIP_WORKER === "undefined"
      ? createRequire(import.meta.url).resolve("@sourcegraph/scip-typescript")
      : fileURLToPath(new URL(ARCHIVIEW_SCIP_WORKER, import.meta.url));
    async function indexProject(cwd: string, configs: string[]) {
      try {
        await run(process.execPath, [worker, "index", "--output", output, "--no-progress-bar", "--", ...configs],
          { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
      } catch (cause) {
        const failure = cause as { stderr?: string; stdout?: string; message?: string };
        if (failure.stdout?.includes("error: no files got indexed.")) return;
        throw new Error("Не удалось построить индекс SCIP. " + (failure.stderr?.trim() || failure.stdout?.trim() || failure.message || "").slice(-1600));
      }
      return fromBinary(IndexSchema, await readFile(output));
    }
    const configured = projects.length ? await indexProject(root, projects) : undefined;
    const configuredDocs = configured ? projectDocuments(configured, owners) : [];
    const covered = new Set(configuredDocs.map(doc => doc.file));
    const missing = eligible.filter(file => !covered.has(file));
    const inferred = missing.length ? await inferredProject(root, temp, owners.keys(), missing, projects) : undefined;
    const supplement = inferred && await indexProject(inferred.root, inferred.configs);
    const looseDocs = supplement ? projectDocuments(supplement, owners).filter(doc => !covered.has(doc.file)) : [];
    for (const { file } of looseDocs) covered.add(file);
    const skipped = missing.filter(file => !covered.has(file));
    if (skipped.length) throw new RelationBuildError("INCOMPLETE_VIEW", "SCIP не проиндексировал файлы: " + skipped.join(", "));
    const docs = [...configuredDocs, ...looseDocs];
    const sources: Record<string,string> = Object.create(null);
    for (const file of new Set(docs.map(d => d.file))) {
      if (!await regularProjectFile(root, file)) throw new RelationBuildError("STALE_VIEW", "Файл изменился: " + file);
      sources[file] = (await readFile(path.join(root, file), "utf8")).replace(/\r\n?/g, "\n");
    }
    const imports = await indexImportSites(root, projects, configuredDocs, sources, docs);
    if (inferred) {
      const looseImports = await indexImportSites(inferred.root, inferred.configs, looseDocs, sources, docs);
      for (const [file, sites] of looseImports) imports.set(file, sites);
    }
    const { edges, indexed } = extractEdges(docs, owners);
    const direct = await directImportEdges(edges, sources, imports);
    const evidence = new Set(direct.flatMap(edge => edge.symbols.flatMap(s => [s.definition.file, ...s.uses.map(u => u.file)])));
    const info = (configured ?? supplement)?.metadata?.toolInfo;
    const graph: RelationGraph = { version: 5, inputs: key, snapshotDigest: snapshot.digest,
      indexer: [info?.name, info?.version].filter(Boolean).join(" "), indexed, eligible: eligible.length,
      edges: direct, sources: Object.fromEntries([...evidence].map(file => [file, sources[file]])) };
    await verifyInputs();
    await assertStateLocation(root, directory, destination);
    await mkdir(path.dirname(destination), { recursive: true });
    const pending = path.join(path.dirname(destination), ".pending-" + randomUUID());
    try {
      await writeFile(pending, JSON.stringify(graph), { flag: "wx" });
      await rename(pending, destination);
    } finally { await rm(pending, {force:true}); }
    return graph;
  } finally {
    if (path.dirname(await realpath(temp)) === tempRoot && path.basename(temp).startsWith("archiview-scip-"))
      await rm(temp, { recursive: true, force: true, maxRetries: 3 });
  }
}
