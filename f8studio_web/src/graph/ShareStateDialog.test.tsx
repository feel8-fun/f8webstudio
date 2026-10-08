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
