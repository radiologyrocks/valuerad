import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HyperGraph } from '../domain/hypergraph.js';

test('hyperedge joins many nodes; incident + neighbors work', () => {
  const g = new HyperGraph();
  g.addNode({ id: 'exam:CT', type: 'examType' });
  g.addNode({ id: 'payer:Aetna', type: 'payer' });
  g.addNode({ id: 'ref:drA', type: 'referrer' });
  g.addEdge({ id: 'v1', type: 'volume', nodes: ['exam:CT', 'payer:Aetna', 'ref:drA'], attrs: { monthlyVolume: 100 } });

  assert.equal(g.edgesOfType('volume').length, 1);
  assert.equal(g.incidentEdges('payer:Aetna').length, 1);
  assert.deepEqual(g.neighbors('exam:CT').map((n) => n.id).sort(), ['payer:Aetna', 'ref:drA']);
});

test('edge to unknown node throws; ensureNode is idempotent', () => {
  const g = new HyperGraph();
  assert.throws(() => g.addEdge({ type: 'x', nodes: ['missing'] }));
  g.ensureNode('a', 'site');
  g.ensureNode('a', 'site');
  assert.equal(g.nodesOfType('site').length, 1);
});

test('clone is deep — mutating the clone does not touch the original', () => {
  const g = new HyperGraph();
  g.addNode({ id: 'n', type: 't', attrs: { x: 1 } });
  g.addEdge({ id: 'e', type: 'v', nodes: ['n'], attrs: { vol: 10 } });
  const c = g.clone();
  c.getEdge('e').attrs.vol = 999;
  c.getNode('n').attrs.x = 999;
  assert.equal(g.getEdge('e').attrs.vol, 10);
  assert.equal(g.getNode('n').attrs.x, 1);
});

test('removeNode cascades to its edges; toJSON/fromJSON round-trip', () => {
  const g = new HyperGraph();
  g.addNode({ id: 'a', type: 't' });
  g.addNode({ id: 'b', type: 't' });
  g.addEdge({ id: 'e', type: 'v', nodes: ['a', 'b'] });
  g.removeNode('a');
  assert.equal(g.edges.size, 0);

  const g2 = HyperGraph.fromJSON(g.toJSON());
  assert.equal(g2.nodes.size, g.nodes.size);
});
