import type { ResizeParams } from '@xyflow/react';
import type { GraphOperation, StudioDocument } from '../api/contracts';
import { absoluteFlowPosition, constrainOperatorPosition, operatorHeight, operatorWidth, projectDocument, serviceChildInsetY,
  OPERATOR_WIDTH, OPERATOR_MIN_HEIGHT, SERVICE_WIDTH, SERVICE_MIN_HEIGHT, STUDIO_SERVICE_CLASS, type StudioFlowNode } from './projection';
import { isBackdrop, isResizableOperator } from './nodePresentation';

export function resizeNodeOperations(document: StudioDocument, nodeId: string, bounds: ResizeParams): GraphOperation[] {
  const node = document.nodes.find((node) => node.nodeId === nodeId);
  if (node === undefined) throw new Error(`Node ${nodeId} is no longer available.`);
  if (node.kind === 'service') return resizeServiceOperations(document, nodeId, bounds);
  if (!isResizableOperator(node)) throw new Error(`${node.name} does not support resizing.`);
  const layout = document.layout.find((layout) => layout.nodeId === nodeId);
  return [{ op: 'setNodeLayout', layout: { nodeId, x: bounds.x, y: bounds.y,
    width: bounds.width, height: bounds.height, collapsed: layout?.collapsed ?? false } }];
}

/** Membership is geometric, captured before the drag, and includes each node once. */
export function backdropGroupNodeIds(backdropId: string, nodes: readonly StudioFlowNode[]): ReadonlySet<string> {
  const backdrop = nodes.find((node) => node.id === backdropId && isBackdrop(node.data.graphNode));
  if (backdrop === undefined) throw new Error(`Backdrop ${backdropId} is no longer available.`);
  const position = absoluteFlowPosition(backdrop, nodes);
  const right = position.x + Number(backdrop.style?.width ?? backdrop.measured?.width ?? 0);
  const bottom = position.y + Number(backdrop.style?.height ?? backdrop.measured?.height ?? 0);
  const ids = new Set([backdropId]);
  for (const node of nodes) {
    const point = absoluteFlowPosition(node, nodes);
    const width = Number(node.style?.width ?? node.measured?.width ?? 0);
    const height = Number(node.style?.height ?? node.measured?.height ?? 0);
    if (point.x >= position.x && point.y >= position.y && point.x + width <= right && point.y + height <= bottom) ids.add(node.id);
  }
  // Moving a service always carries its operators, even if one overflows the frame.
  for (const node of nodes) {
    if (node.parentId !== undefined && ids.has(node.parentId)) ids.add(node.id);
  }
  return ids;
}

export function translateGroupNodes(current: StudioFlowNode[], origin: readonly StudioFlowNode[], ids: ReadonlySet<string>, delta: { x: number; y: number }): StudioFlowNode[] {
  const originals = new Map(origin.map((node) => [node.id, node]));
  return current.map((node) => {
    const original = originals.get(node.id);
    if (original === undefined || !ids.has(node.id)) return node;
    const parentMoves = node.parentId !== undefined && ids.has(node.parentId);
    return { ...node, position: { x: original.position.x + (parentMoves ? 0 : delta.x),
      y: original.position.y + (parentMoves ? 0 : delta.y) } };
  });
}

export function translateGroupOperations(document: StudioDocument, origin: readonly StudioFlowNode[], ids: ReadonlySet<string>, delta: { x: number; y: number }): GraphOperation[] {
  if (delta.x === 0 && delta.y === 0) return [];
  return origin.flatMap((node): GraphOperation[] => {
    if (!ids.has(node.id)) return [];
    const position = absoluteFlowPosition(node, origin);
    const layout = document.layout.find((layout) => layout.nodeId === node.id);
    return [{ op: 'setNodeLayout', layout: { nodeId: node.id, x: position.x + delta.x, y: position.y + delta.y,
      width: layout?.width ?? Number(node.style?.width), height: layout?.height ?? Number(node.style?.height),
      collapsed: layout?.collapsed ?? false } }];
  });
}

export function moveNodeOperations(document: StudioDocument, node: StudioFlowNode, nodes: readonly StudioFlowNode[], pointer?: { readonly x: number; readonly y: number }): GraphOperation[] {
  const projected = projectDocument(document);
  const graphNode = document.nodes.find((candidate) => candidate.nodeId === node.id);
  if (graphNode === undefined) {
    throw new Error(`Node ${node.id} is no longer available.`);
  }
  if (graphNode.kind === 'service') {
    const previous = projected.nodes.find((candidate) => candidate.id === node.id);
    if (previous === undefined) return [];
    const delta = { x: node.position.x - previous.position.x, y: node.position.y - previous.position.y };
    const movedNodeIds = new Set(document.nodes.flatMap((candidate) =>
      candidate.nodeId === graphNode.nodeId || (graphNode.serviceClass !== STUDIO_SERVICE_CLASS &&
        candidate.kind === 'operator' && candidate.serviceId === graphNode.serviceId)
        ? [candidate.nodeId]
        : [],
    ));
    const operations = projected.nodes.flatMap((candidate): GraphOperation[] => {
      if (!movedNodeIds.has(candidate.id)) return [];
      const currentLayout = document.layout.find((layout) => layout.nodeId === candidate.id);
      const absolute = candidate.id === node.id
        ? node.position
        : currentLayout === undefined
          ? absoluteFlowPosition(candidate, projected.nodes)
          : { x: currentLayout.x, y: currentLayout.y };
      return [{
        op: 'setNodeLayout',
        layout: {
          nodeId: candidate.id,
          x: absolute.x + (candidate.id === node.id ? 0 : delta.x),
          y: absolute.y + (candidate.id === node.id ? 0 : delta.y),
          width: candidate.id === node.id && typeof candidate.style?.width === 'number'
            ? candidate.style.width
            : currentLayout?.width,
          height: candidate.id === node.id && typeof candidate.style?.height === 'number'
            ? candidate.style.height
            : currentLayout?.height,
          collapsed: currentLayout?.collapsed ?? false,
        },
      }];
    });
    if (graphNode.serviceClass === STUDIO_SERVICE_CLASS) {
      for (const candidate of projected.nodes) {
        if (candidate.data.graphNode.kind !== 'operator' ||
          candidate.data.graphNode.serviceId !== graphNode.serviceId ||
          document.layout.some((layout) => layout.nodeId === candidate.id)) continue;
        const position = absoluteFlowPosition(candidate, projected.nodes);
        operations.push({
          op: 'setNodeLayout',
          layout: { nodeId: candidate.id, x: position.x, y: position.y, collapsed: false },
        });
      }
    }
    return operations;
  }

  const draggedNodes = nodes.map((candidate) => candidate.id === node.id ? node : candidate);
  const absolute = absoluteFlowPosition(node, draggedNodes);
  const center = {
    x: absolute.x + (node.measured?.width ?? operatorWidth(graphNode)) / 2,
    y: absolute.y + (node.measured?.height ?? OPERATOR_MIN_HEIGHT) / 2,
  };
  const dropPosition = pointer ?? center;
  const target = projected.nodes.find((candidate) => {
    if (candidate.data.graphNode.kind !== 'service' ||
      candidate.data.graphNode.serviceClass === STUDIO_SERVICE_CLASS) return false;
    const width = typeof candidate.style?.width === 'number' ? candidate.style.width : SERVICE_WIDTH;
    const height = typeof candidate.style?.height === 'number' ? candidate.style.height : SERVICE_MIN_HEIGHT;
    return dropPosition.x >= candidate.position.x && dropPosition.x <= candidate.position.x + width &&
      dropPosition.y >= candidate.position.y && dropPosition.y <= candidate.position.y + height;
  });
  if (target === undefined) {
    if (graphNode.serviceClass !== STUDIO_SERVICE_CLASS) {
      throw new Error('Operators must remain inside a compatible service container.');
    }
    const currentLayout = document.layout.find((layout) => layout.nodeId === node.id);
    return [{
      op: 'setNodeLayout',
      layout: {
        nodeId: node.id,
        x: absolute.x,
        y: absolute.y,
        width: currentLayout?.width,
        height: currentLayout?.height,
        collapsed: currentLayout?.collapsed ?? false,
      },
    }];
  }
  if (target.data.graphNode.serviceClass !== graphNode.serviceClass) {
    throw new Error(`${graphNode.name} requires ${graphNode.serviceClass}.`);
  }
  const width = typeof target.style?.width === 'number' ? target.style.width : SERVICE_WIDTH;
  const height = typeof target.style?.height === 'number' ? target.style.height : SERVICE_MIN_HEIGHT;
  const relative = constrainOperatorPosition(
    { x: absolute.x - target.position.x, y: absolute.y - target.position.y },
    width,
    height,
    node.measured?.height ?? operatorHeight(graphNode),
    serviceChildInsetY(target.data.graphNode),
    operatorWidth(graphNode),
  );
  const currentLayout = document.layout.find((layout) => layout.nodeId === node.id);
  const operations: GraphOperation[] = [];
  if (graphNode.serviceId !== target.data.graphNode.serviceId) {
    operations.push({ op: 'bindOperatorService', nodeId: node.id, serviceId: target.data.graphNode.serviceId });
  }
  operations.push({
    op: 'setNodeLayout',
    layout: {
      nodeId: node.id,
      x: target.position.x + relative.x,
      y: target.position.y + relative.y,
      width: currentLayout?.width,
      height: currentLayout?.height,
      collapsed: currentLayout?.collapsed ?? false,
    },
  });
  return operations;
}

export function resizeServiceOperations(document: StudioDocument, nodeId: string, bounds: ResizeParams): GraphOperation[] {
  const service = document.nodes.find((candidate) => candidate.nodeId === nodeId && candidate.kind === 'service');
  if (service === undefined) {
    throw new Error(`Service ${nodeId} is no longer available.`);
  }
  const projected = projectDocument(document);
  const serviceNode = projected.nodes.find((candidate) => candidate.id === nodeId);
  if (serviceNode === undefined) {
    throw new Error(`Service ${nodeId} has no projected layout.`);
  }
  const serviceLayout = document.layout.find((layout) => layout.nodeId === nodeId);
  const operations: GraphOperation[] = [{
    op: 'setNodeLayout',
    layout: {
      nodeId,
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      collapsed: serviceLayout?.collapsed ?? false,
    },
  }];
  for (const child of document.nodes) {
    if (child.kind !== 'operator' || child.serviceId !== service.serviceId) continue;
    const childNode = projected.nodes.find((candidate) => candidate.id === child.nodeId);
    if (childNode === undefined) continue;
    const relative = constrainOperatorPosition(
      childNode.position,
      bounds.width,
      bounds.height,
      operatorHeight(child),
      serviceChildInsetY(service),
      operatorWidth(child),
    );
    const childLayout = document.layout.find((layout) => layout.nodeId === child.nodeId);
    operations.push({
      op: 'setNodeLayout',
      layout: {
        nodeId: child.nodeId,
        x: bounds.x + relative.x,
        y: bounds.y + relative.y,
        width: childLayout?.width,
        height: childLayout?.height,
        collapsed: childLayout?.collapsed ?? false,
      },
    });
  }
  return operations;
}
