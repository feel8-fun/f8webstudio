import type { GraphNode, StudioDocument } from '../api/contracts';
import type { ComponentPreview } from '../api/contracts.gen';
import { operatorHeight, operatorWidth, projectDocument, SERVICE_MIN_HEIGHT, SERVICE_WIDTH } from '../graph/projection';
import { isResizableOperator, operatorMinimumSize } from '../graph/nodePresentation';
import { variantPositionInHost } from '../graph/variantPlacement';

type Point = { readonly x: number; readonly y: number };

/** The insertion API takes translations, not the absolute position of one node. */
export function templatePlacement(document: StudioDocument, preview: ComponentPreview, bindings: Readonly<Record<string, string>>, requested?: Point) {
  const ids = preview.component.presentation.nodeOrder;
  const templates = preview.document.nodes.filter((node) => ids.includes(node.nodeId));
  const positions = new Map(preview.component.presentation.layout.map((item) => [item.nodeId, item]));
  const bounds = (nodes: readonly GraphNode[]) => {
    const rectangles = nodes.map((node) => {
      const layout = positions.get(node.nodeId);
      const index = templates.indexOf(node);
      const resizable = node.serviceClass === 'f8.pystudio' && isResizableOperator(node);
      const minimum = operatorMinimumSize(node);
      return { x: layout?.x ?? 20 + index * 20, y: layout?.y ?? 80 + index * 20,
        width: resizable ? Math.max(minimum.width, layout?.width ?? operatorWidth(node)) : operatorWidth(node),
        height: resizable ? Math.max(minimum.height, layout?.height ?? operatorHeight(node)) : operatorHeight(node) };
    });
    const x = Math.min(...rectangles.map((item) => item.x));
    const y = Math.min(...rectangles.map((item) => item.y));
    return { x, y, width: Math.max(...rectangles.map((item) => item.x + item.width)) - x,
      height: Math.max(...rectangles.map((item) => item.y + item.height)) - y };
  };
  const origin = templates.length ? bounds(templates) : { x: 0, y: 0 };
  const target = requested ?? { x: 40, y: 40 };
  const persisted = new Map(document.layout.map((item) => [item.nodeId, item]));
  // Empty hosts currently display compactly; adding children restores saved size.
  const hosts = projectDocument(document).nodes.map((node) => node.data.graphNode.kind === 'service' ? {
    ...node, style: { ...node.style,
      width: Math.max(SERVICE_WIDTH, Number(node.style?.width ?? 0), persisted.get(node.id)?.width ?? 0),
      height: Math.max(SERVICE_MIN_HEIGHT, Number(node.style?.height ?? 0), persisted.get(node.id)?.height ?? 0) },
  } : node);
  const hostOffsets: Record<string, Point> = {};
  // Reserve earlier groups too when multiple aliases bind to the same host.
  const reserved = [...hosts];
  const placedHosts = new Set<string>();
  for (const binding of preview.component.hostBindings) {
    if (binding.serviceClass === 'f8.pystudio') continue;
    const children = templates.filter((node) => node.kind === 'operator' && node.serviceId === binding.bindingId);
    const host = hosts.find((node) => node.data.graphNode.kind === 'service' && node.data.graphNode.serviceId === bindings[binding.bindingId]);
    if (!host || !children.length) continue;
    const group = bounds(children);
    const at = variantPositionInHost(host, reserved, children[0]!, placedHosts.has(host.id) ? undefined : requested, group);
    placedHosts.add(host.id);
    hostOffsets[binding.bindingId] = { x: at.x - group.x, y: at.y - group.y };
    reserved.push({ id: `reserved:${binding.bindingId}`, type: 'studio', parentId: host.id,
      position: { x: at.x - host.position.x, y: at.y - host.position.y },
      style: { width: group.width, height: group.height }, data: { graphNode: children[0]!, childCount: 0 } });
  }
  return { x: target.x - origin.x, y: target.y - origin.y, hostOffsets };
}
