import type { Index, Occurrence } from "@scip-code/scip";
import { create } from "@bufbuild/protobuf";
import { OccurrenceSchema, SymbolInformation_Kind, SymbolRole } from "@scip-code/scip";
import path from "node:path";
import type { Snapshot } from "../../framework/snapshots/types.js";

import type { ModuleRelations, RelationEdge, RelationGraph, RelationPeer, Site, SymbolReferences } from "../../framework/module-relations/types.js";
import { loadImportSites } from "./import-sites.mjs";

export function supportsFile(file: string) {
  return /\.(?:[mc]?[jt]s|[jt]sx)$/i.test(file);
}

function position(o: Occurrence) {
  const typed = o.typedRange;
  if (typed.case === "singleLineRange") return [typed.value.line, typed.value.startCharacter, typed.value.endCharacter];
  if (typed.case === "multiLineRange") return [typed.value.startLine, typed.value.startCharacter, typed.value.endLine, typed.value.endCharacter];
  return o.range;
}

export function projectDocuments(index: Index, owners: Map<string, string>) {
  return index.documents.map(doc => ({ doc, file: doc.relativePath.replaceAll("\\", "/") }))
    .filter(({file}) => owners.has(file) && supportsFile(file));
}

type ProjectDocuments = ReturnType<typeof projectDocuments>;

export async function indexImportSites(root: string, projects: string[], docs: ProjectDocuments, sources: Record<string, string>, definitions = docs) {
  const locate = await loadImportSites(root, projects);
  const fileSymbols = new Map(definitions.map(({ doc, file }) => [file, doc.symbols.find(s => s.kind === SymbolInformation_Kind.File)?.symbol]));
  const positions = new Map<string, Set<string>>();
  for (const { doc, file } of docs) {
    const existing = new Map(doc.occurrences.filter(o => o.symbol.endsWith("/") && !(o.symbolRoles & SymbolRole.Definition))
      .map(o => [position(o).join(":"), o]));
    positions.set(file, locate(file, sources[file], (range, target) => {
      const occurrence = existing.get(range.join(":"));
      if (target && !fileSymbols.has(target)) return false;
      const symbol = target && fileSymbols.get(target);
      if (!symbol) return;
      // Join the exact TypeScript target to its SCIP definition, including conditional package imports.
      if (occurrence) occurrence.symbol = symbol;
      else doc.occurrences.push(create(OccurrenceSchema, { range, symbol, symbolRoles: SymbolRole.Import }));
    }));
  }
  return positions;
}

/** Only join occurrences to unambiguous project definitions across owners. */
export function extractEdges(docs: ProjectDocuments, owners: Map<string, string>) {
  const definitions = new Map<string, { site: Site; name: string } | null>();
  for (const { doc, file } of docs) {
    const names = new Map(doc.symbols.map(s => [s.symbol, s.displayName]));
    for (const o of doc.occurrences) {
      if (!(o.symbolRoles & SymbolRole.Definition) || !o.symbol || o.symbol.startsWith("local ")) continue;
      const [line, column] = position(o);
      if (column === undefined) continue;
      const site = { file, line: line + 1, column: column + 1 };
      const old = definitions.get(o.symbol);
      if (old === null || old && (old.site.file !== file || old.site.line !== site.line || old.site.column !== site.column)) {
        definitions.set(o.symbol, null);
        continue;
      }
      const descriptor = o.symbol.split("/").at(-1)?.replace(/[.#]$/, "").replaceAll("#", ".");
      definitions.set(o.symbol, { site, name: names.get(o.symbol) || descriptor || path.posix.basename(file) });
    }
  }
  const grouped = new Map<string, { from: string; to: string; symbols: Map<string, SymbolReferences> }>();
  const seen = new Set<string>();
  for (const {doc, file} of docs) {
    const from = owners.get(file)!;
    for (const o of doc.occurrences) {
      if (o.symbolRoles & SymbolRole.Definition) continue;
      const definition = definitions.get(o.symbol);
      if (!definition) continue;
      const to = owners.get(definition.site.file)!;
      const range = position(o);
      if (from === to || range.length < 3) continue;
      const key = JSON.stringify([file, range, o.symbol]);
      if (seen.has(key)) continue;
      seen.add(key);
      const pair = JSON.stringify([from, to]);
      let edge = grouped.get(pair);
      if (!edge) grouped.set(pair, edge = { from, to, symbols: new Map() });
      let symbol = edge.symbols.get(o.symbol);
      if (!symbol) edge.symbols.set(o.symbol, symbol = { id: o.symbol, name: definition.name, definition: definition.site, uses: [] });
      symbol.uses.push({ file, line: range[0] + 1, column: range[1] + 1 });
    }
  }
  const edges = Array.from(grouped.values(), ({from, to, symbols}) => {
    for (const s of symbols.values()) s.uses.sort((a,b) => a.file.localeCompare(b.file) || a.line-b.line || a.column-b.column);
    return { from, to, symbols: [...symbols.values()].sort((a,b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)) };
  });
  return { edges, indexed: new Set(docs.map(d => d.file)).size };
}

/** A literal imports the file named at that boundary, even when its exports come from elsewhere. */
export async function directImportEdges(edges: RelationEdge[], sources: Record<string, string>, positions = new Map<string, Set<string>>()): Promise<RelationEdge[]> {
  const locate = await loadImportSites();
  function atImport(site: Site) {
    let sites = positions.get(site.file);
    if (!sites) {
      sites = locate(site.file, sources[site.file]);
      positions.set(site.file, sites);
    }
    return sites.has(site.line + ":" + site.column);
  }

  const result: RelationEdge[] = [];
  for (const edge of edges) {
    // SCIP TypeScript represents a source file with a trailing package descriptor (/).
    const imports = new Map<string, Set<string>>();
    for (const symbol of edge.symbols) {
      if (!symbol.id.endsWith("/")) continue;
      const consumers = new Set(symbol.uses.filter(atImport).map(use => use.file));
      if (consumers.size) imports.set(symbol.definition.file, consumers);
    }
    const symbols: SymbolReferences[] = [];
    for (const symbol of edge.symbols) {
      const consumers = imports.get(symbol.definition.file);
      if (!consumers) continue;
      const uses = symbol.uses.filter(use => consumers.has(use.file) && (!symbol.id.endsWith("/") || atImport(use)));
      if (uses.length) symbols.push({ ...symbol, uses });
    }
    if (symbols.length) result.push({ ...edge, symbols });
  }
  return result;
}

export function moduleRelations(graph: RelationGraph | null, snapshot: Snapshot, directory: string | null): ModuleRelations {
  if (!graph) return { ready: false };
  const titles = new Map(snapshot.modules.map(m => [m.directory, m.document.contract?.title || m.directory]));
  const outgoing: RelationPeer[] = [], incoming: RelationPeer[] = [];
  const texts = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.from !== directory && edge.to !== directory) continue;
    const other = edge.from === directory ? edge.to : edge.from;
    const symbols = edge.symbols.map(s => ({ ...s, uses: s.uses.map(site => {
      let lines = texts.get(site.file);
      if (!lines) texts.set(site.file, lines = graph.sources[site.file].split("\n"));
      return { ...site, text: (lines[site.line-1] ?? "").trim().slice(0, 240) };
    }) }));
    (edge.from === directory ? outgoing : incoming).push({ directory: other, name: titles.get(other) ?? other,
      count: symbols.reduce((total, s) => total + s.uses.length, 0), symbols });
  }
  const byName = (a: RelationPeer, b: RelationPeer) => a.name.localeCompare(b.name) || a.directory.localeCompare(b.directory);
  return { ready: true, indexed: graph.indexed, eligible: graph.eligible, indexer: graph.indexer,
    outgoing: outgoing.sort(byName), incoming: incoming.sort(byName) };
}
