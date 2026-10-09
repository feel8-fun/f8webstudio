import type { GraphNode } from '../api/contracts';
import { nodePortRows } from './portRows';

export function isNote(node: GraphNode): boolean {
  return node.kind === 'operator' && (node.operatorClass === 'f8.note' || node.spec.rendererClass === 'note_markdown');
}

export function isBackdrop(node: GraphNode): boolean {
  return node.kind === 'operator' && (node.operatorClass === 'f8.backdrop' || node.spec.rendererClass === 'backdrop');
}

export function isResizableOperator(node: GraphNode): boolean {
  return node.kind === 'operator' && node.serviceClass === 'f8.pystudio' &&
    (isNote(node) || isBackdrop(node) || node.operatorClass.startsWith('f8.viz.') ||
      ['viz_text', 'viz_wave', 'viz_video', 'viz_audio', 'viz_track', 'viz_three_d', 'viz_tcode'].includes(node.spec.rendererClass ?? ''));
}

export function operatorMinimumSize(node: GraphNode): { width: number; height: number } {
  const previewHeight = node.kind === 'operator' &&
    (node.operatorClass === 'f8.viz.text' || node.spec.rendererClass === 'viz_text') ? 32 : 80;
  return { width: isBackdrop(node) ? 200 : 180,
    height: isBackdrop(node) || isNote(node) ? 120 : 40 + Math.max(1, nodePortRows(node).length) * 24 + previewHeight };
}
