import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGraphIndex,
  normalizeConnection,
  validateConnection,
  getOrGenerateEdgeUuid,
  sanitizeGraphForApi,
  inspectGenerationChain,
} from '../src/lib/graph-processing.ts';
import type { FlowNode, FlowEdge } from '../src/types/flow.ts';

test('normalizeConnection correctly normalizes forward and reverse connections', () => {
  const typeMap = new Map<string, 'prompt' | 'generator' | 'result'>([
    ['p1', 'prompt'],
    ['g1', 'generator'],
    ['r1', 'result'],
  ]);

  // Forward prompt -> generator
  assert.deepEqual(normalizeConnection({ source: 'p1', target: 'g1' }, typeMap), {
    source: 'p1',
    target: 'g1',
  });

  // Reverse generator -> prompt should flip to prompt -> generator
  assert.deepEqual(normalizeConnection({ source: 'g1', target: 'p1' }, typeMap), {
    source: 'p1',
    target: 'g1',
  });

  // Forward generator -> result
  assert.deepEqual(normalizeConnection({ source: 'g1', target: 'r1' }, typeMap), {
    source: 'g1',
    target: 'r1',
  });

  // Reverse result -> generator should flip to generator -> result
  assert.deepEqual(normalizeConnection({ source: 'r1', target: 'g1' }, typeMap), {
    source: 'g1',
    target: 'r1',
  });

  // Invalid connections: prompt -> result, generator -> generator, etc.
  assert.equal(normalizeConnection({ source: 'p1', target: 'r1' }, typeMap), null);
  assert.equal(normalizeConnection({ source: 'g1', target: 'g1' }, typeMap), null);
});

test('validateConnection enforces connection constraints', () => {
  const nodes: FlowNode[] = [
    { id: 'p1', type: 'prompt', position: { x: 0, y: 0 }, data: { text: 'Prompt 1' } },
    { id: 'p2', type: 'prompt', position: { x: 0, y: 100 }, data: { text: 'Prompt 2' } },
    { id: 'g1', type: 'generator', position: { x: 200, y: 0 }, data: { label: 'Gen 1' } },
    { id: 'r1', type: 'result', position: { x: 400, y: 0 }, data: { label: 'Res 1' } },
    { id: 'r2', type: 'result', position: { x: 400, y: 100 }, data: { label: 'Res 2' } },
  ];

  const edges: FlowEdge[] = [
    { id: 'e1', source: 'p1', target: 'g1' },
    { id: 'e2', source: 'g1', target: 'r1' },
  ];

  const index = buildGraphIndex(nodes, edges);

  // Attempting second input to generator g1 should fail
  assert.equal(validateConnection({ source: 'p2', target: 'g1' }, index), false);

  // Attempting second output from generator g1 should fail
  assert.equal(validateConnection({ source: 'g1', target: 'r2' }, index), false);

  // Free prompt p2 connected to another generator g2
  const nodesWithG2 = [
    ...nodes,
    {
      id: 'g2',
      type: 'generator',
      position: { x: 200, y: 100 },
      data: { label: 'Gen 2' },
    } as FlowNode,
  ];
  const indexG2 = buildGraphIndex(nodesWithG2, edges);
  // Prompt 1 can be shared with Gen 2
  assert.equal(validateConnection({ source: 'p1', target: 'g2' }, indexG2), true);
});

test('getOrGenerateEdgeUuid always returns a valid RFC 4122 UUID and is stable', () => {
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  const validUuid = '11111111-2222-4333-8444-555555555555';
  assert.equal(getOrGenerateEdgeUuid(validUuid), validUuid);

  const reactFlowId = 'xy-edge__node1-node2';
  const generated1 = getOrGenerateEdgeUuid(reactFlowId);
  assert.match(generated1, uuidPattern);

  // Repeated call returns cached UUID
  const generated2 = getOrGenerateEdgeUuid(reactFlowId);
  assert.equal(generated2, generated1);
});

test('sanitizeGraphForApi creates valid API GraphData with canonical edges and UUIDs', () => {
  const nodes: FlowNode[] = [
    { id: 'p1', type: 'prompt', position: { x: 10.4, y: 20.6 }, data: { text: 'Hello' } },
    { id: 'g1', type: 'generator', position: { x: 200, y: 100 }, data: { label: 'Gen' } },
    { id: 'r1', type: 'result', position: { x: 400, y: 100 }, data: { label: 'Res' } },
  ];

  // Notice edge is reversed: g1 -> p1 and r1 -> g1
  const edges: FlowEdge[] = [
    { id: 'xy-edge__g1-p1', source: 'g1', target: 'p1' },
    { id: 'xy-edge__r1-g1', source: 'r1', target: 'g1' },
  ];

  const sanitized = sanitizeGraphForApi(nodes, edges, { x: 0, y: 0, zoom: 1.25 });

  // Edges should be normalized to p1 -> g1 and g1 -> r1
  assert.equal(sanitized.edges[0].source, 'p1');
  assert.equal(sanitized.edges[0].target, 'g1');
  assert.match(sanitized.edges[0].id, /^[0-9a-f-]{36}$/);

  assert.equal(sanitized.edges[1].source, 'g1');
  assert.equal(sanitized.edges[1].target, 'r1');
  assert.match(sanitized.edges[1].id, /^[0-9a-f-]{36}$/);

  // Nodes should round coordinates
  assert.equal(sanitized.nodes[0].position.x, 10);
  assert.equal(sanitized.nodes[0].position.y, 21);
});

test('inspectGenerationChain validates prompt and result connections accurately', () => {
  const nodes: FlowNode[] = [
    { id: 'p1', type: 'prompt', position: { x: 0, y: 0 }, data: { text: 'A futuristic city' } },
    { id: 'g1', type: 'generator', position: { x: 200, y: 0 }, data: { label: 'Gen' } },
    { id: 'r1', type: 'result', position: { x: 400, y: 0 }, data: { label: 'Res' } },
  ];

  const edges: FlowEdge[] = [
    { id: 'e1', source: 'p1', target: 'g1' },
    { id: 'e2', source: 'g1', target: 'r1' },
  ];

  // 1. Valid chain
  const chain = inspectGenerationChain('g1', nodes, edges);
  assert.equal(chain.isValid, true);
  assert.equal(chain.promptId, 'p1');
  assert.equal(chain.resultNodeId, 'r1');
  assert.equal(chain.promptText, 'A futuristic city');

  // 2. Empty prompt text
  const emptyPromptNodes: FlowNode[] = [
    { id: 'p1', type: 'prompt', position: { x: 0, y: 0 }, data: { text: '   ' } },
    { id: 'g1', type: 'generator', position: { x: 200, y: 0 }, data: { label: 'Gen' } },
    { id: 'r1', type: 'result', position: { x: 400, y: 0 }, data: { label: 'Res' } },
  ];
  const emptyChain = inspectGenerationChain('g1', emptyPromptNodes, edges);
  assert.equal(emptyChain.isValid, false);
  assert.equal(emptyChain.error, 'Текстовая нода пуста. Введите описание для генерации');

  // 3. Reversed edge direction (e.g. dragging from result to gen, or gen to prompt)
  const reversedEdges: FlowEdge[] = [
    { id: 'e1', source: 'g1', target: 'p1' },
    { id: 'e2', source: 'r1', target: 'g1' },
  ];
  const reversedChain = inspectGenerationChain('g1', nodes, reversedEdges);
  assert.equal(reversedChain.isValid, true);
  assert.equal(reversedChain.promptId, 'p1');
  assert.equal(reversedChain.resultNodeId, 'r1');
  assert.equal(reversedChain.promptText, 'A futuristic city');

  // 4. Incomplete chain (missing result)
  const incompleteEdges: FlowEdge[] = [{ id: 'e1', source: 'p1', target: 'g1' }];
  const incompleteChain = inspectGenerationChain('g1', nodes, incompleteEdges);
  assert.equal(incompleteChain.isValid, false);
  assert.equal(incompleteChain.error, 'Подключите ноду результата к выходу генератора');
});
