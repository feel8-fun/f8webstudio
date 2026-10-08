import { Handle, Position } from '@xyflow/react';
import { Box, Boxes } from 'lucide-react';
import type { ReactNode } from 'react';
import type { GraphNode } from '../api/contracts';
import { isPatchHub, nodePortRows } from './portRows';
import { PORT_ROW_HEIGHT } from './projection';

/** Shared node visuals. No runtime, catalog, network, editor or device dependencies. */
export function StudioNodeSurface({ node, selected = false, childCount, children, outputAction,
  stateControls = {}, commandControls = {} }: {
  readonly node: GraphNode;
  readonly selected?: boolean;
  readonly childCount: number;
  readonly children?: ReactNode;
  readonly outputAction?: ReactNode;
  readonly stateControls?: Readonly<Record<string, ReactNode>>;
  readonly commandControls?: Readonly<Record<string, ReactNode>>;
}) {
  const rows = nodePortRows(node);
  if (isPatchHub(node)) return <article className={`studio-node studio-node-operator studio-node-patch-hub ${selected ? 'studio-node-selected' : ''}`} aria-label={node.name}>
    <header className="node-drag-handle" title={node.name}><strong>{node.name}</strong></header>
    <div className="node-ports">{rows.map((row) => <div className="patch-hub-port-row" key={row.key} data-port-node={node.nodeId} data-port-id={row.input?.portId ?? row.output?.portId}>
      <div className={`port-label port-${row.input?.kind ?? 'empty'}`}>{row.input && <Handle id={row.input.portId} type="target" position={Position.Left} className={`port-handle port-handle-${row.input.kind}`} />}</div>
      <span className={`patch-hub-port-name port-${row.input?.kind ?? row.output?.kind ?? 'empty'}`} title={`${row.input?.kind ?? row.output?.kind}: ${row.input?.name ?? row.output?.name}`}>{row.input?.name ?? row.output?.name}</span>
      <div className={`port-label port-output port-${row.output?.kind ?? 'empty'}`}>{row.output && <Handle id={row.output.portId} type="source" position={Position.Right} className={`port-handle port-handle-${row.output.kind}`} />}</div>
    </div>)}</div>
  </article>;
  const execLabel = (name: string, direction: 'input' | 'output'): string | undefined => node.kind === 'operator'
    ? (direction === 'input' ? node.spec.execInPorts : node.spec.execOutPorts)?.find((port) => port.name === name)?.label : undefined;
  const visibleRows = rows.length === 0 ? [{ key: 'empty' }] : rows;
  return <article className={`studio-node studio-node-${node.kind} ${node.kind === 'service' && childCount === 0 ? 'studio-node-service-compact' : ''} ${selected ? 'studio-node-selected' : ''}`}>
    <header className="node-drag-handle">
      {node.kind === 'service' ? <Boxes size={15} /> : <Box size={15} />}
      <div><strong>{node.name}</strong><span>{node.kind === 'service' ? node.serviceClass : node.operatorClass}</span></div>
      {outputAction}
      {node.kind === 'service' && childCount > 0 && <span className="service-child-count">{childCount} ops</span>}
      {!node.enabled && <span className="node-disabled">Off</span>}
    </header>
    {children}
    <div className="node-ports" style={{ gridTemplateRows: `repeat(${visibleRows.length}, ${PORT_ROW_HEIGHT}px)` }}>
      {visibleRows.map((row) => {
        const { input, output } = row;
        const sharedStateLabel = input?.kind === 'state' && output?.kind === 'state' && input.runtimeName === output.runtimeName;
        const stateName = input?.kind === 'state' && (output === undefined || sharedStateLabel) ? input.runtimeName : null;
        const field = stateName === null ? undefined : node.spec.stateFields?.find((item) => item.name === stateName && item.showOnNode === true);
        const inputOnly = field?.access === 'wo' && output === undefined;
        const commandName = input?.kind === 'command' ? input.name : output?.kind === 'command' ? output.name : null;
        return <div className={`port-row ${sharedStateLabel || inputOnly ? 'port-row-shared-state' : ''} ${inputOnly ? 'port-row-input-state-control' : ''} ${commandName !== null ? 'port-row-command' : ''}`} key={row.key}>
          <div className={`port-label port-${input?.kind ?? 'empty'}`}>
            {input !== undefined && <><Handle id={input.portId} type="target" position={Position.Left} className={`port-handle port-handle-${input.kind}`} />
              {commandName === null && <span title={`${input.kind} input`}>{inputOnly ? field.label ?? input.name : input.kind === 'exec' ? execLabel(input.runtimeName, 'input') || input.name : input.name}</span>}</>}
          </div>
          <div className="port-control">
            {commandName !== null && (commandControls[commandName] ?? <span className="port-command-name">{commandName}</span>)}
            {field !== undefined && (stateControls[field.name] ?? <span className="port-static-value" title={JSON.stringify(node.stateValues[field.name])}>{JSON.stringify(node.stateValues[field.name])}</span>)}
          </div>
          <div className={`port-label port-output port-${output?.kind ?? 'empty'}`}>
            {output !== undefined && <>{!sharedStateLabel && commandName === null && <span title={`${output.kind} output`}>{output.kind === 'exec' ? execLabel(output.runtimeName, 'output') || output.name : output.name}</span>}
              <Handle id={output.portId} type="source" position={Position.Right} className={`port-handle port-handle-${output.kind}`} /></>}
          </div>
        </div>;
      })}
    </div>
  </article>;
}
