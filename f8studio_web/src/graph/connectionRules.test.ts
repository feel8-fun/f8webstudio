import { expect, test } from 'vitest';

import type { GraphNode, GraphPort, StudioDocument } from '../api/contracts';
import { connectionError, inputConnectionOperations } from './connectionRules';

function port(
  portId: string,
  kind: GraphPort['kind'],
  direction: GraphPort['direction'],
  access: 'rw' | 'ro' | 'wo' = 'rw',
): GraphPort {
  return {
    portId,
    name: portId,
    runtimeName: portId,
    kind,
    direction,
    dataSpec: kind === 'data' ? { name: portId, payload: { kind: 'json', valueSchema: { type: 'number' } } } : null,
    stateSpec: kind === 'state' ? { name: portId, valueSchema: { type: 'number' }, access } : null,
  };
}

function operator(nodeId: string, serviceId: string, ports: readonly GraphPort[]): GraphNode {
  return {
    kind: 'operator',
    nodeId,
    name: nodeId,
    serviceId,
    serviceClass: 'f8.pyengine',
    operatorClass: `test.${nodeId}`,
    spec: {
      serviceClass: 'f8.pyengine', operatorClass: `test.${nodeId}`, label: nodeId, specKind: 'operator',
    },
    ports,
    portIds: {}, stateValues: {},
    enabled: true,
  };
}

function document(nodes: readonly GraphNode[]): StudioDocument {
  return {
    schemaVersion: 'f8studio-document/3', projectId: 'project', graphId: 'graph',
    graphRevision: 0, layoutRevision: 0, nodes, edges: [], layout: [],
  };
}

test('accepts compatible data connections and rejects duplicate connections', () => {
  const source = operator('source', 'service', [port('out', 'data', 'output')]);
  const sink = operator('sink', 'service', [port('in', 'data', 'input')]);
  const base = document([source, sink]);
  const connection = { source: 'source', sourceHandle: 'out', target: 'sink', targetHandle: 'in' };

  expect(connectionError(base, connection)).toBeNull();
  expect(connectionError({
    ...base,
    edges: [{
      edgeId: 'edge', fromNodeId: 'source', fromPortId: 'out', toNodeId: 'sink', toPortId: 'in',
      kind: 'data', strategy: 'latest', queueSize: 16, timeoutMs: null,
    }],
  }, connection)).toContain('already connected');
});

test.each(['data', 'state', 'exec'] as const)('replaces an occupied %s input in one transaction', (kind) => {
  const source = operator('source', 'service', [port('out', kind, 'output')]);
  const oldSource = operator('old-source', 'service', [port('out', kind, 'output')]);
  const sink = operator('sink', 'service', [port('in', kind, 'input')]);
  const edge = { edgeId: 'old', fromNodeId: 'old-source', fromPortId: 'out', toNodeId: 'sink', toPortId: 'in', kind, strategy: 'latest' as const, queueSize: 16, timeoutMs: null };
  const base = { ...document([source, oldSource, sink]), edges: [edge] };
  const connection = { source: 'source', sourceHandle: 'out', target: 'sink', targetHandle: 'in' };
  expect(connectionError(base, connection)).toBeNull();
  const replacement = { ...edge, edgeId: 'new', fromNodeId: 'source' };
  expect(inputConnectionOperations(base, replacement)).toEqual([
    { op: 'disconnectEdge', edgeId: 'old' }, { op: 'connectEdge', edge: replacement },
  ]);
  expect(base.edges).toEqual([edge]);
});

test('rejects an incompatible replacement without changing the occupied input', () => {
  const dataSource = operator('data', 'service', [port('out', 'data', 'output')]);
  const stateSource = operator('state', 'service', [port('out', 'state', 'output')]);
  const sink = operator('sink', 'service', [port('in', 'state', 'input')]);
  const edge = { edgeId: 'old', fromNodeId: 'state', fromPortId: 'out', toNodeId: 'sink', toPortId: 'in', kind: 'state' as const, strategy: 'latest' as const, queueSize: 16, timeoutMs: null };
  const base = { ...document([dataSource, stateSource, sink]), edges: [edge] };
  expect(connectionError(base, { source: 'data', sourceHandle: 'out', target: 'sink', targetHandle: 'in' })).toContain('compatible port types');
  expect(base.edges).toEqual([edge]);
});

test('still rejects cycles when replacing an occupied state input', () => {
  const ports = () => [
    { ...port('out', 'state', 'output'), runtimeName: 'value' },
    { ...port('in', 'state', 'input'), runtimeName: 'value' },
  ];
  const base: StudioDocument = { ...document(['first', 'second', 'third'].map((id) => operator(id, 'service', ports()))), edges: [
    { edgeId: 'old', fromNodeId: 'first', fromPortId: 'out', toNodeId: 'second', toPortId: 'in', kind: 'state', strategy: 'latest', queueSize: 16, timeoutMs: null },
    { edgeId: 'downstream', fromNodeId: 'second', fromPortId: 'out', toNodeId: 'third', toPortId: 'in', kind: 'state', strategy: 'latest', queueSize: 16, timeoutMs: null },
  ] };
  expect(connectionError(base, { source: 'third', sourceHandle: 'out', target: 'second', targetHandle: 'in' })).toContain('create a cycle');
});

test('enforces exec service ownership and state access/cycle rules', () => {
  const first = operator('first', 'service-a', [
    port('exec-out', 'exec', 'output'),
    { ...port('state-out', 'state', 'output'), runtimeName: 'value' },
    { ...port('state-in', 'state', 'input'), runtimeName: 'value' },
  ]);
  const second = operator('second', 'service-b', [
    port('exec-in', 'exec', 'input'),
    { ...port('state-out', 'state', 'output'), runtimeName: 'value' },
    { ...port('state-in', 'state', 'input'), runtimeName: 'value' },
  ]);
  const base = document([first, second]);

  expect(connectionError(base, {
    source: 'first', sourceHandle: 'exec-out', target: 'second', targetHandle: 'exec-in',
  })).toContain('cannot cross service');
  const withStateEdge: StudioDocument = {
    ...base,
    edges: [{
      edgeId: 'state-edge', fromNodeId: 'first', fromPortId: 'state-out',
      toNodeId: 'second', toPortId: 'state-in', kind: 'state', strategy: 'latest', queueSize: 16, timeoutMs: null,
    }],
  };
  expect(connectionError(withStateEdge, {
    source: 'second', sourceHandle: 'state-out', target: 'first', targetHandle: 'state-in',
  })).toContain('create a cycle');
});
