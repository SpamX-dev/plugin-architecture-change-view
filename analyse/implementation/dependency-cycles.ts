import type { CycleStep, RelationEdge } from "../../framework/module-relations/types.js";

/** One shortest closed path through each participating outgoing dependency of the selected module. */
export function dependencyCycles(edges: RelationEdge[], owner: string): CycleStep[][] {
  const incoming = new Map<string, RelationEdge[]>();
  const outgoing: RelationEdge[] = [];
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    if (edge.from === owner) outgoing.push(edge);
    const list = incoming.get(edge.to);
    if (list) list.push(edge);
    else incoming.set(edge.to, [edge]);
  }

  // A reverse breadth-first search gives every reachable module one next hop back to the owner.
  const next = new Map<string, RelationEdge>();
  const queue = [owner];
  for (let i = 0; i < queue.length; i++) {
    const predecessors = incoming.get(queue[i]) ?? [];
    predecessors.sort((a, b) => a.from.localeCompare(b.from));
    for (const edge of predecessors) {
      if (edge.from === owner || next.has(edge.from)) continue;
      next.set(edge.from, edge);
      queue.push(edge.from);
    }
  }
  const cycles: CycleStep[][] = [];
  for (const first of outgoing.sort((a, b) => a.to.localeCompare(b.to))) {
    if (!next.has(first.to)) continue;
    const cycle: CycleStep[] = [];
    let edge = first;
    for (;;) {
      const symbol = edge.symbols.find(s => s.id.endsWith("/")) ?? edge.symbols[0];
      cycle.push({ from: edge.from, to: edge.to, use: symbol.uses[0] });
      if (edge.to === owner) break;
      edge = next.get(edge.to)!;
    }
    cycles.push(cycle);
  }
  return cycles;
}
