import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { StudioDocument } from '../api/contracts';
import type { StudioFlowNode } from './projection';
import { GraphView } from './GraphView';

const flowProps = vi.hoisted(() => vi.fn());
vi.mock('@xyflow/react', () => ({
  MarkerType: { ArrowClosed: 'arrowclosed' },
  Position: { Left: 'left', Right: 'right' },
  BackgroundVariant: { Dots: 'dots' },
  Handle: ({ id }: { id: string }) => <span data-testid={`handle-${id}`} />,
  Background: () => null,
  Controls: () => null,
  ReactFlowProvider: ({ children }: { children: React.ReactNode }) => children,
  ReactFlow: (props: { nodes: StudioFlowNode[]; nodeTypes: { studio: React.ComponentType<{ data: StudioFlowNode['data'] }> } }) => {
    flowProps(props);
    const Node = props.nodeTypes.studio;
    return <>{props.nodes.map((node) => <Node key={node.id} data={node.data} />)}</>;
  },
}));
vi.mock('../api/liveStore', () => ({ useLivePrefix: () => { throw new Error('Preview subscribed to runtime'); } }));
vi.mock('../presentation/PresentationStore', () => ({ usePresentationOutput: () => { throw new Error('Preview subscribed to media'); } }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const document: StudioDocument = {
  schemaVersion: 'f8studio-document/3', graphId: 'preview', projectId: 'preview', graphRevision: 0, layoutRevision: 0,
  edges: [], layout: [], nodes: [{ kind: 'service', nodeId: 'engine', serviceId: 'engine', name: 'Embedded Engine',
    serviceClass: 'missing.engine', enabled: true, ports: [], portIds: {}, stateValues: {},
    spec: { serviceClass: 'missing.engine', label: 'Engine', specKind: 'service' } },
  { kind: 'operator', nodeId: 'script', serviceId: 'engine', serviceClass: 'missing.engine', operatorClass: 'missing.script',
    name: 'Embedded Script', enabled: true, portIds: {}, stateValues: { gain: 0.5, code: 'throw new Error("do not execute")' },
    spec: { specKind: 'operator', serviceClass: 'missing.engine', operatorClass: 'missing.script', label: 'Script', rendererClass: 'viz_video',
      commands: [{ name: 'Execute', params: [] }],
      stateFields: [{ name: 'gain', showOnNode: true, access: 'rw', valueSchema: { type: 'number' } }] },
    ports: [{ portId: 'gain-input', name: 'gain', runtimeName: 'gain', kind: 'state', direction: 'input', dataSpec: null,
      stateSpec: { name: 'gain', showOnNode: true, access: 'rw', valueSchema: { type: 'number' } } },
      { portId: 'execute', name: 'Execute', runtimeName: 'Execute', kind: 'command', direction: 'input', dataSpec: null, stateSpec: null }],
  }],
};

test('renders embedded definitions without runtime, installed catalog or active controls', () => {
  render(<GraphView document={document} readonly />);
  expect(screen.getByText('Embedded Script')).toBeInTheDocument();
  expect(screen.getByText('0.5')).toBeInTheDocument();
  expect(screen.getByTestId('handle-gain-input')).toBeInTheDocument();
  expect(screen.getByText('Execute')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Execute' })).not.toBeInTheDocument();
  expect(screen.queryByRole('spinbutton')).not.toBeInTheDocument();
  expect(screen.getByText('viz_video · Preview only')).toBeInTheDocument();
  expect(flowProps.mock.calls[0]?.[0]).toMatchObject({ nodesDraggable: false, nodesConnectable: false,
    edgesReconnectable: false, elementsSelectable: false, deleteKeyCode: null });
});

test('renders Markdown notes and transparent Backdrop frames in offline previews', () => {
  const host = document.nodes[0]!;
  const base = document.nodes[1]!;
  if (base.kind !== 'operator') throw new Error('Invalid preview fixture');
  const note = { ...base, nodeId: 'note', name: 'Documentation', operatorClass: 'f8.note',
    ports: [], stateValues: { content: '# Embedded documentation\n\n**Offline** preview' },
    spec: { ...base.spec, operatorClass: 'f8.note', rendererClass: 'note_markdown', commands: [], stateFields: [] } };
  const backdrop = { ...note, nodeId: 'frame', name: 'My group', operatorClass: 'f8.backdrop',
    spec: { ...note.spec, operatorClass: 'f8.backdrop', rendererClass: 'backdrop' } };
  const view = render(<GraphView document={{ ...document, nodes: [host, note, backdrop] }} />);
  expect(screen.getByRole('heading', { name: 'Embedded documentation' })).toBeInTheDocument();
  expect(view.container.querySelector('.studio-node-backdrop')).toHaveTextContent('My group');
  expect(view.container.querySelector('.service-resize-handle')).toBeNull();
});
