import { expect, test } from 'vitest';
import type { GraphNode, NodeLayout, GraphOperation, StudioDocument } from '../api/contracts';
import { backdropGroupNodeIds, resizeNodeOperations, translateGroupNodes, translateGroupOperations } from './layoutEdits';
import { absoluteFlowPosition, projectDocument } from './projection';

function savedLayout(layout: Extract<GraphOperation, { op: 'setNodeLayout' }>['layout']): NodeLayout {
  return { ...layout, width: layout.width ?? null, height: layout.height ?? null, collapsed: layout.collapsed ?? false };
}

function fixture(): StudioDocument {
  const service = (id: string, serviceClass: string): GraphNode => ({
    kind: 'service', nodeId: id, serviceId: id, serviceClass, name: id, enabled: true, portIds: {}, stateValues: {}, ports: [],
    spec: { specKind: 'service', serviceClass, label: id },
  });
  const operator = (id: string, serviceId: string, serviceClass: string, operatorClass: string): GraphNode => ({
    kind: 'operator', nodeId: id, serviceId, serviceClass, operatorClass, name: id, enabled: true, portIds: {}, stateValues: {}, ports: [],
    spec: { specKind: 'operator', serviceClass, operatorClass, label: id },
  });
  return { schemaVersion: 'f8studio-document/3', projectId: 'layout', graphId: 'layout', graphRevision: 2, layoutRevision: 3,
    nodes: [service('studio', 'f8.pystudio'), service('engine', 'f8.pyengine'),
      operator('tick', 'engine', 'f8.pyengine', 'test.tick'),
      operator('backdrop', 'studio', 'f8.pystudio', 'f8.backdrop'),
      operator('inner', 'studio', 'f8.pystudio', 'f8.backdrop'),
      operator('note', 'studio', 'f8.pystudio', 'f8.note'),
      operator('viz', 'studio', 'f8.pystudio', 'f8.viz.text'),
      operator('partial', 'studio', 'f8.pystudio', 'f8.note')],
    layout: [
      { nodeId: 'studio', x: -500, y: 0 }, { nodeId: 'engine', x: 50, y: 70, width: 524, height: 300 },
      { nodeId: 'tick', x: 80, y: 180 },
      { nodeId: 'backdrop', x: 0, y: 0, width: 1200, height: 900 },
      { nodeId: 'inner', x: 600, y: 400, width: 400, height: 400 },
      { nodeId: 'note', x: 640, y: 460, width: 200, height: 140 },
      { nodeId: 'viz', x: 50, y: 440, width: 340, height: 300 },
      { nodeId: 'partial', x: 1100, y: 100, width: 200, height: 140 },
    ].map(savedLayout), edges: [] };
}

test('operator resizing persists corner position and size, including shrinking below the initial size', () => {
  const document = fixture();
  const operation = resizeNodeOperations(document, 'viz', { x: 60, y: 450, width: 190, height: 150 })[0];
  expect(operation).toMatchObject({ op: 'setNodeLayout', layout: { nodeId: 'viz', x: 60, y: 450, width: 190, height: 150 } });
  if (operation?.op !== 'setNodeLayout') throw new Error('Missing layout edit');
  const resized = { ...document, layout: document.layout.map((item) => item.nodeId === 'viz' ? savedLayout(operation.layout) : item) };
  expect(projectDocument(resized).nodes.find((node) => node.id === 'viz')?.style).toEqual({ width: 190, height: 150 });
  expect(resizeNodeOperations(document, 'backdrop', { x: -50, y: -60, width: 1400, height: 1000 })).toHaveLength(1);
});

test('backdrop containment moves complete nodes and nested frames, leaving partial overlaps alone', () => {
  const document = fixture();
  const projected = projectDocument(document).nodes;
  const ids = backdropGroupNodeIds('backdrop', projected);
  expect([...ids].sort()).toEqual(['backdrop', 'engine', 'inner', 'note', 'tick', 'viz']);
  const delta = { x: 120, y: 90 };
  const moved = translateGroupNodes(projected, projected, ids, delta);
  const tick = moved.find((node) => node.id === 'tick')!;
  expect(tick.position).toEqual(projected.find((node) => node.id === 'tick')?.position);
  expect(absoluteFlowPosition(tick, moved)).toEqual({ x: 200, y: 270 });
  expect(moved.find((node) => node.id === 'partial')).toBe(projected.find((node) => node.id === 'partial'));
  const edits = translateGroupOperations(document, projected, ids, delta);
  expect(edits).toHaveLength(ids.size);
  expect(new Set(edits.map((edit) => edit.op === 'setNodeLayout' ? edit.layout.nodeId : '')).size).toBe(ids.size);
  expect(edits).toContainEqual(expect.objectContaining({ op: 'setNodeLayout', layout: expect.objectContaining({ nodeId: 'tick', x: 200, y: 270 }) }));
  const layouts = new Map(document.layout.map((item) => [item.nodeId, item]));
  for (const edit of edits) if (edit.op === 'setNodeLayout') layouts.set(edit.layout.nodeId, savedLayout(edit.layout));
  const reloaded = projectDocument({ ...document, layout: [...layouts.values()] }).nodes;
  expect(absoluteFlowPosition(reloaded.find((node) => node.id === 'tick')!, reloaded)).toEqual({ x: 200, y: 270 });
  expect(backdropGroupNodeIds('inner', reloaded)).toEqual(new Set(['inner', 'note']));
});

test('moving a contained operator without its service preserves its binding and layout after reload', () => {
  const document = fixture();
  const projected = projectDocument(document).nodes;
  const edits = translateGroupOperations(document, projected, new Set(['tick']), { x: 800, y: -200 });
  const edit = edits[0];
  if (edit?.op !== 'setNodeLayout') throw new Error('Missing edit');
  const reloaded = projectDocument({ ...document, layout: document.layout.map((item) => item.nodeId === 'tick' ? savedLayout(edit.layout) : item) }).nodes;
  const tick = reloaded.find((node) => node.id === 'tick')!;
  expect(absoluteFlowPosition(tick, reloaded)).toEqual({ x: 880, y: -20 });
  expect(tick.data.graphNode.serviceId).toBe('engine');
});
