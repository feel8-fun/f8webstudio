import { Background, BackgroundVariant, Controls, ReactFlow, ReactFlowProvider, type NodeProps } from '@xyflow/react';
import { useMemo } from 'react';
import type { StudioDocument } from '../api/contracts';
import { projectDocument, type StudioFlowNode } from './projection';
import { StudioNodeSurface } from './StudioNodeSurface';

const PREVIEW_RENDERERS = new Set(['viz_video', 'viz_audio', 'viz_wave', 'viz_text', 'viz_track', 'viz_tcode', 'viz_three_d']);

function PreviewNode({ data }: NodeProps<StudioFlowNode>) {
  const node = data.graphNode;
  const renderer = node.spec.rendererClass;
  return <StudioNodeSurface node={node} childCount={data.childCount}>
    {typeof renderer === 'string' && PREVIEW_RENDERERS.has(renderer) && <div className="studio-node-inline-data">
      <span className="inline-video-placeholder">{renderer} · Preview only</span>
    </div>}
  </StudioNodeSurface>;
}

const nodeTypes = { studio: PreviewNode };

/** Render a validated snapshot without installed extensions or runtime stores. */
export function GraphView({ document, readonly = true }: {
  readonly document: StudioDocument;
  readonly readonly?: true;
}) {
  const projected = useMemo(() => projectDocument(document), [document]);
  return <div className="graph-view" style={{ height: 320, minHeight: 240 }} aria-label="Graph preview" data-readonly={readonly}>
    <ReactFlowProvider><ReactFlow nodes={projected.nodes} edges={projected.edges} nodeTypes={nodeTypes}
      nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false}
      elementsSelectable={false} nodesFocusable={false} edgesFocusable={false} deleteKeyCode={null}
      fitView fitViewOptions={{ maxZoom: 1 }} minZoom={0.15} maxZoom={2}>
      <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
      <Controls showInteractive={false} />
    </ReactFlow></ReactFlowProvider>
  </div>;
}
