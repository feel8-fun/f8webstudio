import { NodeResizer, type NodeProps, type ResizeParams } from '@xyflow/react';
import { ExternalLink } from 'lucide-react';
import { createContext, lazy, Suspense, useContext, useEffect, useState, type ReactNode } from 'react';

import type { CommandSpec, GraphNode, JsonValue } from '../api/contracts';
import { type PresentationOutput, usePresentationOutput } from '../presentation/PresentationStore';
import { PresentationAudio } from '../presentation/PresentationAudio';
import { PresentationVideo } from '../presentation/PresentationVideo';
import { PresentationWave } from '../presentation/PresentationWave';
import { PresentationTrack } from '../presentation/PresentationTrack';
import { hasExtensionNodeRendererClass } from '../extensions/registry';
import { SkeletonOutputPreview } from '../three/SkeletonOutputPreview';
import { isPatchHub } from './portRows';
import { SERVICE_MIN_HEIGHT, SERVICE_WIDTH, type StudioFlowNode } from './projection';
import { StateFieldControl, stateOptionPoolField } from './StateFieldControl';
import { useRuntimeNodeState } from './useRuntimeNodeState';
import { StudioNodeSurface } from './StudioNodeSurface';

export interface GraphNodeInteraction {
  readonly busy: boolean;
  readonly pendingCommands: ReadonlySet<string>;
  readonly connectedStateInputs: ReadonlySet<string>;
  readonly resizeService: (nodeId: string, bounds: ResizeParams) => void;
  readonly setState: (nodeId: string, field: string, value: JsonValue) => void;
  readonly openCommand: (node: GraphNode, command: CommandSpec) => void;
  readonly showOutput: (nodeId: string) => void;
}

export const GraphNodeInteractionContext = createContext<GraphNodeInteraction | null>(null);

const BUILTIN_OUTPUT_CLASSES = new Set(['f8.viz.text', 'f8.viz.wave', 'f8.viz.track', 'f8.viz.video', 'f8.viz.audio', 'f8.viz.three_d']);
const BUILTIN_RENDERER_CLASSES = new Set(['viz_text', 'viz_wave', 'viz_track', 'viz_video', 'viz_audio', 'viz_three_d']);
const TCodeView = lazy(() => import('../extensions/tcode/TCodeView').then((module) => ({ default: module.TCodeView })));

function InlineTCodePreview({ nodeId, enabled, model }: { readonly nodeId: string; readonly enabled: boolean; readonly model: JsonValue | undefined }) {
  const output = usePresentationOutput(nodeId);
  return <div className="studio-node-inline-data studio-node-inline-tcode nodrag nowheel" data-testid={`tcode-preview-${nodeId}`}>
    {!enabled ? <span className="inline-video-placeholder">Node disabled</span> :
      <Suspense fallback={<span className="inline-video-placeholder">Loading TCode</span>}>
        <TCodeView nodeId={nodeId} payload={output?.renderer === 'tcode' ? output.payload : { model: typeof model === 'string' ? model : 'SR6' }} compact />
      </Suspense>}
  </div>;
}

function InlineVideoPreview({ nodeId, enabled }: { readonly nodeId: string; readonly enabled: boolean }) {
  const output = usePresentationOutput(nodeId);
  const videoOutput = output?.renderer === 'video' ? output : null;
  return <div className="studio-node-inline-video nodrag nowheel" data-testid={`video-preview-${nodeId}`}>
    {!enabled && <span className="inline-video-placeholder">Node disabled</span>}
    {enabled && videoOutput === null && <span className="inline-video-placeholder">Waiting for stream</span>}
    {enabled && videoOutput !== null && <PresentationVideo payload={videoOutput.payload} compact />}
  </div>;
}

function InlineAudioPreview({ nodeId, enabled }: { readonly nodeId: string; readonly enabled: boolean }) {
  const output = usePresentationOutput(nodeId);
  const audioOutput = output?.renderer === 'audio' ? output : null;
  return <div className="studio-node-inline-audio nodrag nowheel" data-testid={`audio-preview-${nodeId}`}>
    {!enabled && <span className="inline-video-placeholder">Node disabled</span>}
    {enabled && audioOutput === null && <span className="inline-video-placeholder">Waiting for stream</span>}
    {enabled && audioOutput !== null && <PresentationAudio payload={audioOutput.payload} compact />}
  </div>;
}

function InlineDataPreview({ nodeId, enabled, updating, renderer }: {
  readonly nodeId: string;
  readonly enabled: boolean;
  readonly updating: boolean;
  readonly renderer: 'wave' | 'text' | 'track';
}) {
  const output = usePresentationOutput(nodeId);
  const [displayed, setDisplayed] = useState<PresentationOutput | null>(null);
  useEffect(() => {
    if (enabled && updating && output?.renderer === renderer) setDisplayed(output);
  }, [enabled, updating, output, renderer]);
  return <div className={`studio-node-inline-data studio-node-inline-${renderer} nodrag nowheel`} data-testid={`${renderer}-preview-${nodeId}`}>
    {!enabled && <span className="inline-video-placeholder">Node disabled</span>}
    {enabled && displayed === null && <span className="inline-video-placeholder">{updating ? 'Waiting for data' : 'Updates paused'}</span>}
    {enabled && displayed !== null && renderer === 'wave' && <PresentationWave payload={displayed.payload} compact />}
    {enabled && displayed !== null && renderer === 'text' && <pre>{JSON.stringify(displayed.payload.value, null, 2)}</pre>}
    {enabled && displayed !== null && renderer === 'track' && <PresentationTrack payload={displayed.payload} compact />}
  </div>;
}

export function StudioNodeView({ data, selected }: NodeProps<StudioFlowNode>) {
  const node = data.graphNode;
  const showsVideoPreview = node.kind === 'operator' &&
    (node.operatorClass === 'f8.viz.video' || node.spec.rendererClass === 'viz_video');
  const showsAudioPreview = node.kind === 'operator' &&
    (node.operatorClass === 'f8.viz.audio' || node.spec.rendererClass === 'viz_audio');
  const showsWavePreview = node.kind === 'operator' &&
    (node.operatorClass === 'f8.viz.wave' || node.spec.rendererClass === 'viz_wave');
  const showsTextPreview = node.kind === 'operator' &&
    (node.operatorClass === 'f8.viz.text' || node.spec.rendererClass === 'viz_text');
  const showsTrackPreview = node.kind === 'operator' &&
    (node.operatorClass === 'f8.viz.track' || node.spec.rendererClass === 'viz_track');
  const showsTCodePreview = node.kind === 'operator' &&
    (node.operatorClass === 'f8.viz.tcode' || node.spec.rendererClass === 'viz_tcode');
  const rendererClass = typeof node.spec.rendererClass === 'string' ? node.spec.rendererClass : '';
  const hasOutputView = node.kind === 'operator' &&
    (BUILTIN_OUTPUT_CLASSES.has(node.operatorClass) || BUILTIN_RENDERER_CLASSES.has(rendererClass) || hasExtensionNodeRendererClass(rendererClass));
  const isThreeD = node.kind === 'operator' && (node.operatorClass === 'f8.viz.three_d' || node.spec.rendererClass === 'viz_three_d');
  const interaction = useContext(GraphNodeInteractionContext);
  const inlineNames = (isPatchHub(node) ? [] : node.spec.stateFields ?? []).filter((field) => field.showOnNode === true ||
    ((showsWavePreview || showsTextPreview) && field.name === 'uiUpdate'))
    .flatMap((field) => [field.name, stateOptionPoolField(field)].filter((name): name is string => name !== null));
  const runtimeValues = useRuntimeNodeState(node, inlineNames);
  if (isPatchHub(node)) return <StudioNodeSurface node={node} selected={selected} childCount={data.childCount} />;
  const updatesEnabled = runtimeValues.uiUpdate?.found === true
    ? runtimeValues.uiUpdate.value !== false : node.stateValues.uiUpdate !== false;
  const stateControls: Record<string, ReactNode> = {};
  const commandControls: Record<string, ReactNode> = {};
  if (interaction !== null) {
    for (const field of node.spec.stateFields ?? []) {
      if (field.showOnNode !== true) continue;
      stateControls[field.name] = <StateFieldControl key={field.name} node={node} field={field} compact
        connected={interaction.connectedStateInputs.has(`${node.nodeId}:${field.name}`)} disabled={interaction.busy}
        runtimeValue={runtimeValues[field.name]} runtimeValues={runtimeValues}
        onCommit={(value) => interaction.setState(node.nodeId, field.name, value)} />;
    }
    for (const command of node.spec.commands ?? []) {
      commandControls[command.name] = <button type="button" className="port-command-button nodrag nowheel"
        title={command.description ?? `Run ${command.name}`}
        disabled={!node.enabled || interaction.busy || interaction.pendingCommands.has(`${node.nodeId}:${command.name}`)}
        onClick={() => interaction.openCommand(node, command)}>{command.name}</button>;
    }
  }

  return <>
    {node.kind === 'service' && data.childCount > 0 && <NodeResizer
      isVisible={selected && interaction?.busy !== true}
      minWidth={SERVICE_WIDTH}
      minHeight={SERVICE_MIN_HEIGHT}
      handleClassName="service-resize-handle"
      lineClassName="service-resize-line"
      onResizeEnd={(_event, bounds) => interaction?.resizeService(node.nodeId, bounds)}
    />}
    <StudioNodeSurface node={node} selected={selected} childCount={data.childCount}
      stateControls={stateControls} commandControls={commandControls}
      outputAction={hasOutputView && <button type="button" className="node-view-button nodrag" title="Open output view" aria-label={`Open ${node.name} output view`}
        onClick={() => interaction?.showOutput(node.nodeId)}><ExternalLink size={13} /></button>}>
      {showsVideoPreview && <InlineVideoPreview nodeId={node.nodeId} enabled={node.enabled} />}
      {showsAudioPreview && <InlineAudioPreview nodeId={node.nodeId} enabled={node.enabled} />}
      {showsWavePreview && <InlineDataPreview nodeId={node.nodeId} enabled={node.enabled} updating={updatesEnabled} renderer="wave" />}
      {showsTextPreview && <InlineDataPreview nodeId={node.nodeId} enabled={node.enabled} updating={updatesEnabled} renderer="text" />}
      {showsTrackPreview && <InlineDataPreview nodeId={node.nodeId} enabled={node.enabled} updating renderer="track" />}
      {showsTCodePreview && <InlineTCodePreview nodeId={node.nodeId} enabled={node.enabled} model={node.stateValues.model} />}
      {isThreeD && <SkeletonOutputPreview nodeId={node.nodeId} enabled={node.enabled} className="studio-node-inline-three nodrag nowheel" />}
    </StudioNodeSurface>
  </>;
}
