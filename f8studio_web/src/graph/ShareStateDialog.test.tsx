import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { StudioDocument } from '../api/contracts';
import { ShareStateDialog } from './ShareStateDialog';

afterEach(cleanup);
const document: StudioDocument = {
  schemaVersion: 'f8studio-document/3', projectId: 'project', graphId: 'project', graphRevision: 1, layoutRevision: 0,
  edges: [], layout: [], nodes: [{ kind: 'service', nodeId: 'player', name: 'Player', serviceId: 'player', serviceClass: 'test.player', enabled: true,
    ports: [], portIds: {}, stateValues: { gain: 2, path: 'private.mp4' },
    spec: { specKind: 'service', serviceClass: 'test.player', label: 'Player', stateFields: [
      { name: 'gain', access: 'rw', persistent: true, publishable: true, valueSchema: { type: 'number', default: 1 } },
      { name: 'path', access: 'rw', persistent: true, publishable: false, valueSchema: { type: 'string', default: 'demo.mp4' } },
      { name: 'trigger', access: 'rw', persistent: false, publishable: false, valueSchema: { type: 'integer', default: 0 } },
      { name: 'playing', access: 'ro', valueSchema: { type: 'boolean' } },
    ] },
  }],
};

test('authors can exclude saved parameters while private and runtime values stay excluded', async () => {
  const share = vi.fn().mockResolvedValue(undefined);
  const close = vi.fn();
  render(<ShareStateDialog title="Export shared graph" document={document} onShare={share} onClose={close} />);
  expect(screen.getByRole('checkbox', { name: 'Player.path' })).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: 'Player.path' })).not.toBeChecked();
  expect(screen.getByRole('checkbox', { name: 'Player.trigger' })).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: 'Player.playing' })).toBeDisabled();
  fireEvent.click(screen.getByRole('checkbox', { name: 'Player.gain' }));
  fireEvent.click(screen.getByRole('button', { name: 'Export shared graph' }));
  await waitFor(() => expect(share).toHaveBeenCalledWith([{ nodeId: 'player', field: 'gain' }]));
  expect(close).toHaveBeenCalledOnce();
  expect(document.nodes[0]?.stateValues).toEqual({ gain: 2, path: 'private.mp4' });
});

test('failed sharing leaves the choices available and displays the error', async () => {
  const close = vi.fn();
  render(<ShareStateDialog title="Capture component" document={document} onShare={vi.fn().mockRejectedValue(new Error('Project changed'))} onClose={close} />);
  fireEvent.click(screen.getByRole('button', { name: 'Capture component' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Project changed');
  expect(close).not.toHaveBeenCalled();
});

test('unchanged configuration is included through definition defaults, including false, zero, empty and null', async () => {
  const fields = [
    { name: 'tickMs', label: 'Tick (ms)', access: 'rw' as const, persistent: true, publishable: true, valueSchema: { type: 'integer' as const, default: 100 } },
    { name: 'hiResTimer', access: 'rw' as const, persistent: true, publishable: true, valueSchema: { type: 'boolean' as const, default: false } },
    { name: 'offset', access: 'rw' as const, valueSchema: { type: 'integer' as const, default: 0 } },
    { name: 'prefix', access: 'rw' as const, valueSchema: { type: 'string' as const, default: '' } },
    { name: 'optional', access: 'rw' as const, valueSchema: { type: 'null' as const, default: null } },
    { name: 'unset', access: 'rw' as const, valueSchema: { type: 'string' as const } },
  ];
  const original = document.nodes[0]!;
  if (original.kind !== 'service') throw new Error('Expected service fixture');
  const node = { ...original, stateValues: {}, spec: { ...original.spec, stateFields: fields } };
  const share = vi.fn().mockResolvedValue(undefined);
  render(<ShareStateDialog title="Save as Variant" document={{ ...document, nodes: [node] }} onShare={share} onClose={vi.fn()} />);
  for (const name of ['tickMs', 'hiResTimer', 'offset', 'prefix', 'optional']) {
    expect(screen.getByRole('checkbox', { name: `Player.${name}` })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: `Player.${name}` })).toBeDisabled();
  }
  expect(screen.getByText(/Default: 100 · included in definition/)).toBeVisible();
  expect(screen.getByText(/Default: false · included in definition/)).toBeVisible();
  expect(screen.getByRole('checkbox', { name: 'Player.unset' })).not.toBeChecked();
  expect(screen.getByText(/No configured value or default/)).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Save as Variant' }));
  await waitFor(() => expect(share).toHaveBeenCalledWith([]));
});

test('an explicitly saved value equal to the default can still be excluded', async () => {
  const node = { ...document.nodes[0]!, stateValues: { gain: 1 } };
  const share = vi.fn().mockResolvedValue(undefined);
  render(<ShareStateDialog title="Save as Variant" document={{ ...document, nodes: [node] }} onShare={share} onClose={vi.fn()} />);
  const gain = screen.getByRole('checkbox', { name: 'Player.gain' });
  expect(gain).toBeEnabled();
  expect(gain).toBeChecked();
  fireEvent.click(gain);
  fireEvent.click(screen.getByRole('button', { name: 'Save as Variant' }));
  await waitFor(() => expect(share).toHaveBeenCalledWith([{ nodeId: 'player', field: 'gain' }]));
});

test('selection capture treats a cut upstream edge as an authored fallback and omits unselected nodes', () => {
  const source = { ...document.nodes[0]!, nodeId: 'source', serviceId: 'source', name: 'Source' };
  const target = { ...document.nodes[0]!, ports: [{ portId: 'gain-in', name: 'gain', runtimeName: 'gain',
    kind: 'state' as const, direction: 'input' as const, dataSpec: null, stateSpec: document.nodes[0]!.spec.stateFields![0]! }] };
  const connected = { ...document, nodes: [source, target], edges: [{ edgeId: 'upstream', kind: 'state' as const,
    fromNodeId: 'source', fromPortId: 'gain-out', toNodeId: 'player', toPortId: 'gain-in', strategy: 'latest' as const,
    queueSize: 16, timeoutMs: null }] };
  render(<ShareStateDialog title="Capture selection" document={connected} nodeIds={['player']} onShare={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByRole('checkbox', { name: 'Player.gain' })).toBeEnabled();
  expect(screen.getByRole('checkbox', { name: 'Player.gain' })).toBeChecked();
  expect(screen.queryByRole('checkbox', { name: 'Source.gain' })).not.toBeInTheDocument();
});
