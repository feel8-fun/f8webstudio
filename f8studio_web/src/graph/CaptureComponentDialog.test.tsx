import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { StudioDocument } from '../api/contracts';
import { CaptureComponentDialog } from './CaptureComponentDialog';

const capture = vi.hoisted(() => vi.fn());
vi.mock('../api/client', () => ({ captureProjectComponent: capture }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

test('captures named selection with authored value exclusions through the server', async () => {
  const document: StudioDocument = { schemaVersion: 'f8studio-document/3', projectId: 'project', graphId: 'project', graphRevision: 9,
    layoutRevision: 3, edges: [], layout: [], nodes: [{ kind: 'service', nodeId: 'engine', name: 'Engine', serviceId: 'engine',
      serviceClass: 'test.engine', enabled: true, ports: [], portIds: {}, stateValues: { gain: 2 },
      spec: { specKind: 'service', serviceClass: 'test.engine', label: 'Engine', stateFields: [{ name: 'gain', access: 'rw',
        persistent: true, publishable: true, valueSchema: { type: 'number' } }] } }] };
  capture.mockResolvedValue({ name: 'Reusable engine' });
  const saved = vi.fn();
  const close = vi.fn();
  render(<CaptureComponentDialog document={document} nodeIds={['engine']} onClose={close} onSaved={saved} />);
  fireEvent.change(screen.getByRole('textbox', { name: 'Component name' }), { target: { value: 'Reusable engine' } });
  fireEvent.click(screen.getByRole('checkbox', { name: 'Engine.gain' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save selection as component' }));
  await waitFor(() => expect(capture).toHaveBeenCalledWith('project', document, 'Reusable engine', [{ nodeId: 'engine', field: 'gain' }], ['engine'], { description: '', tags: [] }));
  expect(saved).toHaveBeenCalledWith('Reusable engine');
  expect(close).toHaveBeenCalledOnce();
});
