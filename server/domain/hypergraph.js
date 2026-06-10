/**
 * Hypergraph core — the practice "digital twin" substrate.
 *
 * A plain graph edge joins two nodes; a HYPEREDGE joins any number of nodes.
 * That's the right shape for a radiology practice, where a single economic
 * event ties together many entities at once — e.g. one "volume" hyperedge links
 * an exam type + a payer + a referrer + a site, and one "contract" hyperedge
 * links a payer to a set of exam types and a rate rule.
 *
 * This module is pure structure (no domain knowledge, no money). domain/practice.js
 * builds a typed practice graph on top of it and runs the economics.
 */

export class HyperGraph {
  constructor() {
    this.nodes = new Map(); // id -> { id, type, attrs }
    this.edges = new Map(); // id -> { id, type, nodes: [ids], attrs }
    this._seq = 0;
  }

  addNode(node) {
    if (!node?.id) throw new Error('node requires an id');
    this.nodes.set(node.id, { attrs: {}, ...node });
    return node.id;
  }

  /** Idempotent helper: add a node only if absent. */
  ensureNode(id, type, attrs = {}) {
    if (!this.nodes.has(id)) this.addNode({ id, type, attrs });
    return id;
  }

  addEdge(edge) {
    const id = edge.id ?? `e${++this._seq}`;
    const nodes = edge.nodes ?? [];
    for (const n of nodes) {
      if (!this.nodes.has(n)) throw new Error(`edge ${id} references unknown node ${n}`);
    }
    this.edges.set(id, { attrs: {}, ...edge, id, nodes });
    return id;
  }

  getNode(id) { return this.nodes.get(id) ?? null; }
  getEdge(id) { return this.edges.get(id) ?? null; }

  nodesOfType(type) { return [...this.nodes.values()].filter((n) => n.type === type); }
  edgesOfType(type) { return [...this.edges.values()].filter((e) => e.type === type); }

  /** Edges incident to a node (the node participates in them). */
  incidentEdges(nodeId) { return [...this.edges.values()].filter((e) => e.nodes.includes(nodeId)); }

  /** Distinct nodes that share at least one hyperedge with nodeId. */
  neighbors(nodeId) {
    const out = new Set();
    for (const e of this.incidentEdges(nodeId)) for (const n of e.nodes) if (n !== nodeId) out.add(n);
    return [...out].map((id) => this.nodes.get(id));
  }

  removeNode(nodeId) {
    this.nodes.delete(nodeId);
    for (const [id, e] of this.edges) if (e.nodes.includes(nodeId)) this.edges.delete(id);
  }

  removeEdge(edgeId) { this.edges.delete(edgeId); }

  /** Deep copy — scenarios mutate a clone, never the baseline. */
  clone() {
    const g = new HyperGraph();
    g._seq = this._seq;
    for (const n of this.nodes.values()) g.nodes.set(n.id, structuredClone(n));
    for (const e of this.edges.values()) g.edges.set(e.id, structuredClone(e));
    return g;
  }

  toJSON() {
    return { nodes: [...this.nodes.values()], edges: [...this.edges.values()] };
  }

  static fromJSON(json) {
    const g = new HyperGraph();
    for (const n of json.nodes ?? []) g.addNode(n);
    for (const e of json.edges ?? []) g.edges.set(e.id, e);
    return g;
  }
}
