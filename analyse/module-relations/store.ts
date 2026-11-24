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
import { assertStateLocation, projectStateDirectory } from "../project/paths.js";
import { regularProjectFile } from "../project/source-files.js";
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
    if ((graph.version !== 1 && graph.version !== 2) || graph.inputs !== key) throw new Error("Некорректный сохранённый граф связей");
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
  const owners = new Map(snapshot.modules.flatMap(m => m.files.map(f => [f.path, m.directory] as const)));
  const eligible = [...owners.keys()].filter(supportsFile);
  if (!eligible.length) throw new RelationBuildError("INVALID_ARGUMENT", "В снимке нет файлов TypeScript или JavaScript.");
  const tempRoot = await realpath(tmpdir());
  const temp = await mkdtemp(path.join(tempRoot, "archiview-scip-"));
  const output = path.join(temp, "index.scip");
  try {
    const projects = [...owners.keys()].filter(file => /^(?:ts|js)config\.json$/.test(path.posix.basename(file)));
    const cwd = projects.length ? root : await inferredProject(root, temp, owners.keys());
    const worker = typeof ARCHIVIEW_SCIP_WORKER === "undefined"
      ? createRequire(import.meta.url).resolve("@sourcegraph/scip-typescript")
      : fileURLToPath(new URL(ARCHIVIEW_SCIP_WORKER, import.meta.url));
    try {
      await run(process.execPath, [worker, "index", "--output", output, "--no-progress-bar", "--", ...projects],
        { cwd, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
    } catch (cause) {
      const failure = cause as { stderr?: string; stdout?: string; message?: string };
      throw new Error("Не удалось построить индекс SCIP. " + (failure.stderr?.trim() || failure.stdout?.trim() || failure.message || "").slice(-1600));
    }
    const index = fromBinary(IndexSchema, await readFile(output));
    const docs = projectDocuments(index, owners);
    const sources: Record<string,string> = Object.create(null);
    for (const file of new Set(docs.map(d => d.file))) {
      if (!await regularProjectFile(root, file)) throw new RelationBuildError("STALE_VIEW", "Файл изменился: " + file);
      sources[file] = (await readFile(path.join(cwd, file), "utf8")).replace(/\r\n?/g, "\n");
    }
    const imports = await indexImportSites(cwd, projects, docs, sources);
    const { edges, indexed } = extractEdges(docs, owners);
    const direct = await directImportEdges(edges, sources, imports);
    const evidence = new Set(direct.flatMap(edge => edge.symbols.flatMap(s => [s.definition.file, ...s.uses.map(u => u.file)])));
    const info = index.metadata?.toolInfo;
    const graph: RelationGraph = { version: 2, inputs: key, snapshotDigest: snapshot.digest,
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
