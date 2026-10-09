import type { XYPosition } from '@xyflow/react';
import type { GraphNode } from '../api/contracts';
import { CONTAINER_INSET_X, constrainOperatorPosition, OPERATOR_GAP_X, OPERATOR_GAP_Y,
  operatorHeight, operatorWidth, serviceChildInsetY, SERVICE_MIN_HEIGHT, SERVICE_WIDTH, type StudioFlowNode } from './projection';

export function variantPositionInHost(host: StudioFlowNode, nodes: readonly StudioFlowNode[], template: GraphNode,
  requested?: XYPosition): XYPosition {
  // A compact, empty service expands to these minimum dimensions once it has children.
  const width = Math.max(Number(host.style?.width ?? SERVICE_WIDTH), SERVICE_WIDTH);
  const top = serviceChildInsetY(host.data.graphNode);
  const childWidth = operatorWidth(template);
  const childHeight = operatorHeight(template);
  const height = Math.max(Number(host.style?.height ?? SERVICE_MIN_HEIGHT), SERVICE_MIN_HEIGHT, top + childHeight + OPERATOR_GAP_Y);
  const constrain = (position: XYPosition) => constrainOperatorPosition(position, width, height, childHeight, top, childWidth);
  const absolute = (position: XYPosition) => ({ x: host.position.x + position.x, y: host.position.y + position.y });
  if (requested) return absolute(constrain({ x: requested.x - host.position.x, y: requested.y - host.position.y }));

  const children = nodes.filter((node) => node.parentId === host.id).map((node) => ({
    ...node.position, width: Number(node.style?.width ?? operatorWidth(node.data.graphNode)),
    height: Number(node.style?.height ?? operatorHeight(node.data.graphNode)),
  }));
  const xs = [...new Set([CONTAINER_INSET_X, 40, ...children.map((child) => child.x + child.width + OPERATOR_GAP_X)])].sort((a, b) => a - b);
  const ys = [...new Set([top, ...children.map((child) => child.y + child.height + OPERATOR_GAP_Y)])].sort((a, b) => a - b);
  for (const y of ys) {
    for (const x of xs) {
      const candidate = constrain({ x, y });
      if (candidate.x !== x || candidate.y !== y) continue;
      if (children.every((child) => x + childWidth + OPERATOR_GAP_X <= child.x || x >= child.x + child.width + OPERATOR_GAP_X ||
        y + childHeight + OPERATOR_GAP_Y <= child.y || y >= child.y + child.height + OPERATOR_GAP_Y)) return absolute(candidate);
    }
  }
  throw new Error('No free space in this service. Enlarge its container or add the Variant at a chosen canvas position.');
}
