/** Repository-relative source positions use one-based lines and columns. */
export interface Site { file: string; line: number; column: number }
export interface SymbolReferences { id: string; name: string; definition: Site; uses: Site[] }
export interface RelationEdge { from: string; to: string; symbols: SymbolReferences[] }
export interface RelationGraph {
  version: 1 | 2 | 3 | 4 | 5;
  inputs: string;
  snapshotDigest: string;
  indexer: string;
  indexed: number;
  eligible: number;
  edges: RelationEdge[];
  sources: Record<string, string>;
}
export interface RelationPeer {
  directory: string; name: string; count: number;
  symbols: (Omit<SymbolReferences, "uses"> & { uses: (Site & { text: string })[] })[];
}
export type ModuleRelations = { ready: false } | {
  ready: true; indexer: string; indexed: number; eligible: number; outgoing: RelationPeer[]; incoming: RelationPeer[];
};
