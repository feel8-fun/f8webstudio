import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { StudioDocument } from '../api/contracts';
import type { ComponentPreview, VariantSummary } from '../api/contracts.gen';
import { VariantInsertion } from './VariantInsertion';

const api = vi.hoisted(() => ({ fetchAssetVersions: vi.fn(), fetchComponentPreview: vi.fn(), insertProjectComponent: vi.fn() }));
vi.mock('../api/client', () => api);

const host = { kind: 'service' as const, nodeId: 'engine', serviceId: 'engine', serviceClass: 'test.engine', name: 'Engine',
  enabled: true, ports: [], portIds: {}, stateValues: {}, spec: { specKind: 'service' as const, serviceClass: 'test.engine', label: 'Engine' } };
const document: StudioDocument = { schemaVersion: 'f8studio-document/3', graphId: 'p', projectId: 'p', graphRevision: 4, layoutRevision: 3,
  nodes: [host], edges: [], layout: [{ nodeId: 'engine', x: 300, y: 200, width: 524, height: 300, collapsed: false }] };
const variant: VariantSummary = { assetId: 'v', name: 'Smoothed signal', description: '', tags: [], currentVersion: 2,
  nodeKind: 'operator', serviceClass: 'test.engine', operatorClass: 'test.script' };
const template = { kind: 'operator' as const, nodeId: 'template', serviceId: 'host', serviceClass: 'test.engine', operatorClass: 'test.script',
  name: 'Script', enabled: true, ports: [], portIds: {}, stateValues: {},
  spec: { specKind: 'operator' as const, serviceClass: 'test.engine', operatorClass: 'test.script', label: 'Script' } };
const preview: ComponentPreview = { assetId: 'v', version: 2, issues: [], document: { ...document, nodes: [host, template] },
  component: { format: 'f8component', formatVersion: 1, definitions: { services: {}, operators: {} }, services: {}, operators: {}, connections: [],
    presentation: { layout: [], nodeOrder: ['template'] }, endpoints: [], hostBindings: [{ bindingId: 'host', serviceClass: 'test.engine', definitionRef: 'engine' }] } };

beforeEach(() => {
  api.fetchAssetVersions.mockResolvedValue([{ version: 2 }, { version: 1 }]);
  api.fetchComponentPreview.mockResolvedValue(preview);
  api.insertProjectComponent.mockResolvedValue({});
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

test('selects a unique host and places the template inside its container', async () => {
  const inserted = vi.fn().mockResolvedValue(undefined);
  render(<VariantInsertion document={document} variant={variant} onBack={vi.fn()} onBusy={vi.fn()} onInserted={inserted} />);
  await waitFor(() => expect(api.insertProjectComponent).toHaveBeenCalledWith('p', expect.objectContaining({
    assetId: 'v', version: 2, expectedGraphRevision: 4, expectedLayoutRevision: 3,
    hostBindings: { host: 'engine' }, x: expect.any(Number), y: expect.any(Number),
  })));
  const request = api.insertProjectComponent.mock.calls[0]![1] as { x: number; y: number };
  expect(request.x).toBeGreaterThan(300);
  expect(request.x).toBeLessThan(824);
  expect(request.y).toBeGreaterThan(230);
  await waitFor(() => expect(inserted).toHaveBeenCalledWith('Smoothed signal'));
  expect(api.insertProjectComponent).toHaveBeenCalledTimes(1);
});

test('uses the selected matching host to add directly when multiple hosts exist', async () => {
  const second = { ...host, nodeId: 'other', serviceId: 'other', name: 'Other engine' };
  render(<VariantInsertion document={{ ...document, nodes: [host, second] }} variant={variant} preferredServiceId="other"
    onBack={vi.fn()} onBusy={vi.fn()} onInserted={vi.fn()} />);
  await waitFor(() => expect(api.insertProjectComponent).toHaveBeenCalledWith('p', expect.objectContaining({ hostBindings: { host: 'other' } })));
  expect(screen.queryByRole('combobox', { name: 'Host for host' })).not.toBeInTheDocument();
});

test('explicit version options do not add until the author confirms', async () => {
  render(<VariantInsertion document={document} variant={variant} configure onBack={vi.fn()} onBusy={vi.fn()} onInserted={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add node' })).toBeEnabled());
  expect(api.insertProjectComponent).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Add node' }));
  await waitFor(() => expect(api.insertProjectComponent).toHaveBeenCalledTimes(1));
});

test('requires a choice between multiple hosts and supports a fixed older version', async () => {
  const second = { ...host, nodeId: 'other', serviceId: 'other', name: 'Other engine' };
  render(<VariantInsertion document={{ ...document, nodes: [host, second] }} variant={variant} onBack={vi.fn()} onBusy={vi.fn()} onInserted={vi.fn()} />);
  const select = await screen.findByRole('combobox', { name: 'Host for host' });
  expect(select).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Add node' })).toBeDisabled();
  await screen.findByRole('option', { name: 'v1' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Variant version' }), { target: { value: '1' } });
  await waitFor(() => expect(api.fetchComponentPreview).toHaveBeenCalledWith('v', 1, expect.any(AbortSignal)));
  await screen.findByRole('combobox', { name: 'Host for host' });
  fireEvent.change(screen.getByRole('combobox', { name: 'Host for host' }), { target: { value: 'other' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add node' }));
  await waitFor(() => expect(api.insertProjectComponent).toHaveBeenCalledWith('p', expect.objectContaining({ version: 1, hostBindings: { host: 'other' } })));
});

test('finds free space rather than covering an existing operator', async () => {
  const existing = { ...template, nodeId: 'existing', serviceId: 'engine' };
  render(<VariantInsertion document={{ ...document, nodes: [host, existing], layout: [
    { nodeId: 'engine', x: 300, y: 200, width: 780, height: 600, collapsed: false },
    { nodeId: 'existing', x: 350, y: 360, width: null, height: null, collapsed: false },
  ] }} variant={variant} onBack={vi.fn()} onBusy={vi.fn()} onInserted={vi.fn()} />);
  await waitFor(() => expect(api.insertProjectComponent).toHaveBeenCalled());
  const request = api.insertProjectComponent.mock.calls[0]![1] as { x: number; y: number };
  // Both operators are 240 by 64: their rectangles must be disjoint.
  expect(request.x + 240 <= 350 || request.x >= 590 || request.y + 64 <= 360 || request.y >= 424).toBe(true);
});

test('allows a tall template in an empty host that expands when children are added', async () => {
  const tall = { ...template, ports: Array.from({ length: 12 }, (_, i) => ({
    portId: `data:input:p${i}`, name: `p${i}`, runtimeName: `p${i}`, kind: 'data' as const,
    direction: 'input' as const, dataSpec: null, stateSpec: null,
  })) };
  api.fetchComponentPreview.mockResolvedValue({ ...preview, document: { ...document, nodes: [host, tall] } });
  render(<VariantInsertion document={document} variant={variant} onBack={vi.fn()} onBusy={vi.fn()} onInserted={vi.fn()} />);
  await waitFor(() => expect(api.insertProjectComponent).toHaveBeenCalled());
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('shows missing-extension requirements and blocks insertion', async () => {
  api.fetchComponentPreview.mockResolvedValue({ ...preview, issues: [{ code: 'missing_definition', nodeId: 'template', message: 'Install test.engine' }] });
  render(<VariantInsertion document={document} variant={variant} onBack={vi.fn()} onBusy={vi.fn()} onInserted={vi.fn()} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Install test.engine');
  expect(screen.getByRole('button', { name: 'Add node' })).toBeDisabled();
  expect(api.insertProjectComponent).not.toHaveBeenCalled();
});
