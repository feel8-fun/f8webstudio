import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { StudioDocument } from '../api/contracts';
import type { ComponentPreview, VariantSummary } from '../api/contracts.gen';
import { TemplateInsertion } from '../library/TemplateInsertion';
import { localTemplate, type LibraryProvider, type LibraryTemplate } from '../library/types';

const api = vi.hoisted(() => ({ fetchAssetVersions: vi.fn(), fetchComponentPreview: vi.fn(), insertProjectComponent: vi.fn() }));
vi.mock('../api/client', () => api);
vi.mock('./GraphView', () => ({ GraphView: () => <div>Graph preview</div> }));

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
  render(<TemplateInsertion document={document} template={localTemplate(variant)} onBack={vi.fn()} onBusy={vi.fn()} onInserted={inserted} />);
  await waitFor(() => expect(api.insertProjectComponent).toHaveBeenCalledWith('p', expect.objectContaining({
    assetId: 'v', version: 2, expectedGraphRevision: 4, expectedLayoutRevision: 3,
    hostBindings: { host: 'engine' }, x: expect.any(Number), y: expect.any(Number),
    hostOffsets: { host: { x: expect.any(Number), y: expect.any(Number) } },
  })));
  const request = api.insertProjectComponent.mock.calls[0]![1] as { hostOffsets: { host: { x: number; y: number } } };
  expect(request.hostOffsets.host.x + 20).toBeGreaterThan(300);
  expect(request.hostOffsets.host.x + 20).toBeLessThan(824);
  expect(request.hostOffsets.host.y + 80).toBeGreaterThan(230);
  await waitFor(() => expect(inserted).toHaveBeenCalledWith('Smoothed signal'));
  expect(api.insertProjectComponent).toHaveBeenCalledTimes(1);
});

test('uses the selected matching host to add directly when multiple hosts exist', async () => {
  const second = { ...host, nodeId: 'other', serviceId: 'other', name: 'Other engine' };
  render(<TemplateInsertion document={{ ...document, nodes: [host, second] }} template={localTemplate(variant)} preferredServiceId="other"
    onBack={vi.fn()} onBusy={vi.fn()} onInserted={vi.fn()} />);
  await waitFor(() => expect(api.insertProjectComponent).toHaveBeenCalledWith('p', expect.objectContaining({ hostBindings: { host: 'other' } })));
  expect(screen.queryByRole('combobox', { name: 'Host for host' })).not.toBeInTheDocument();
});

test('explicit version options do not add until the author confirms', async () => {
  render(<TemplateInsertion document={document} template={localTemplate(variant)} configure onBack={vi.fn()} onBusy={vi.fn()} onInserted={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add node' })).toBeEnabled());
  expect(api.insertProjectComponent).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Add node' }));
  await waitFor(() => expect(api.insertProjectComponent).toHaveBeenCalledTimes(1));
});

test('requires a choice between multiple hosts and supports a fixed older version', async () => {
  const second = { ...host, nodeId: 'other', serviceId: 'other', name: 'Other engine' };
  render(<TemplateInsertion document={{ ...document, nodes: [host, second] }} template={localTemplate(variant)} onBack={vi.fn()} onBusy={vi.fn()} onInserted={vi.fn()} />);
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
  render(<TemplateInsertion document={{ ...document, nodes: [host, existing], layout: [
    { nodeId: 'engine', x: 300, y: 200, width: 780, height: 600, collapsed: false },
    { nodeId: 'existing', x: 350, y: 360, width: null, height: null, collapsed: false },
  ] }} template={localTemplate(variant)} onBack={vi.fn()} onBusy={vi.fn()} onInserted={vi.fn()} />);
  await waitFor(() => expect(api.insertProjectComponent).toHaveBeenCalled());
  const request = api.insertProjectComponent.mock.calls[0]![1] as { hostOffsets: { host: { x: number; y: number } } };
  // Both operators are 240 by 64: their rectangles must be disjoint.
  expect(request.hostOffsets.host.x + 20 + 240 <= 350 || request.hostOffsets.host.x + 20 >= 590 || request.hostOffsets.host.y + 80 + 64 <= 360 || request.hostOffsets.host.y + 80 >= 424).toBe(true);
});

test('allows a tall template in an empty host that expands when children are added', async () => {
  const tall = { ...template, ports: Array.from({ length: 12 }, (_, i) => ({
    portId: `data:input:p${i}`, name: `p${i}`, runtimeName: `p${i}`, kind: 'data' as const,
    direction: 'input' as const, dataSpec: null, stateSpec: null,
  })) };
  api.fetchComponentPreview.mockResolvedValue({ ...preview, document: { ...document, nodes: [host, tall] } });
  render(<TemplateInsertion document={document} template={localTemplate(variant)} onBack={vi.fn()} onBusy={vi.fn()} onInserted={vi.fn()} />);
  await waitFor(() => expect(api.insertProjectComponent).toHaveBeenCalled());
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('shows missing-extension requirements and blocks insertion', async () => {
  api.fetchComponentPreview.mockResolvedValue({ ...preview, issues: [{ code: 'missing_definition', nodeId: 'template', message: 'Install test.engine' }] });
  render(<TemplateInsertion document={document} template={localTemplate(variant)} onBack={vi.fn()} onBusy={vi.fn()} onInserted={vi.fn()} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Install test.engine');
  expect(screen.getByRole('button', { name: 'Add node' })).toBeDisabled();
  expect(api.insertProjectComponent).not.toHaveBeenCalled();
});

test('shows Markdown and graph details for a multi-node component, choosing every required host', async () => {
  const otherHost = { ...host, nodeId: 'otherEngine', serviceId: 'otherEngine', serviceClass: 'test.other', name: 'Other engine' };
  const alternate = { ...host, nodeId: 'alternate', serviceId: 'alternate', name: 'Alternate' };
  const second = { ...template, nodeId: 'second', serviceId: 'otherBinding', serviceClass: 'test.other' };
  const component: LibraryTemplate = { ...localTemplate(variant), kind: 'component', description: '# Smooth pipeline\n\n**Reusable** processing', tags: ['signal'] };
  api.fetchComponentPreview.mockResolvedValue({ ...preview, document: { ...preview.document, nodes: [host, template, second] },
    component: { ...preview.component, presentation: { nodeOrder: ['template', 'second'], layout: [
      { nodeId: 'template', x: 150, y: 250 }, { nodeId: 'second', x: 700, y: 280 },
    ] }, hostBindings: [...preview.component.hostBindings, { bindingId: 'otherBinding', serviceClass: 'test.other', definitionRef: 'other' }] } });
  render(<TemplateInsertion document={{ ...document, nodes: [host, otherHost, alternate], layout: [...document.layout,
    { nodeId: 'otherEngine', x: 1000, y: 200, width: null, height: null, collapsed: false },
    { nodeId: 'alternate', x: 1800, y: 200, width: null, height: null, collapsed: false },
  ] }} template={component} configure onBack={vi.fn()} onBusy={vi.fn()} onInserted={vi.fn()} />);
  expect(await screen.findByRole('heading', { name: 'Smooth pipeline' })).toBeInTheDocument();
  expect(await screen.findByText('Graph preview')).toBeInTheDocument();
  expect(screen.getByRole('combobox', { name: 'Host for host' })).toHaveValue('');
  expect(screen.getByRole('combobox', { name: 'Host for otherBinding' })).toHaveValue('otherEngine');
  expect(screen.getByRole('button', { name: 'Add node' })).toBeDisabled();
  fireEvent.change(screen.getByRole('combobox', { name: 'Host for host' }), { target: { value: 'engine' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add node' }));
  await waitFor(() => expect(api.insertProjectComponent).toHaveBeenCalledWith('p', expect.objectContaining({
    hostBindings: { host: 'engine', otherBinding: 'otherEngine' },
    hostOffsets: { host: { x: expect.any(Number), y: expect.any(Number) }, otherBinding: { x: expect.any(Number), y: expect.any(Number) } },
  })));
});

test('retains fixed online identity and hash and sends insertion to its provider', async () => {
  const cloud: LibraryTemplate = { ...localTemplate(variant), reference: { source: 'cloud', registryId: 'feel8', assetId: 'remote', version: 2, contentHash: 'fixed-hash' } };
  const provider: LibraryProvider = { source: 'cloud', search: vi.fn(), versions: vi.fn().mockResolvedValue([]),
    preview: vi.fn().mockResolvedValue(preview), insert: vi.fn().mockResolvedValue(undefined) };
  render(<TemplateInsertion document={document} template={cloud} provider={provider} onBack={vi.fn()} onBusy={vi.fn()} onInserted={vi.fn()} />);
  await waitFor(() => expect(provider.insert).toHaveBeenCalledWith(cloud.reference, document, expect.objectContaining({ hostBindings: { host: 'engine' } })));
  expect(api.insertProjectComponent).not.toHaveBeenCalled();
});

test('failed insertion stays actionable and retry retains its request ID', async () => {
  api.insertProjectComponent.mockRejectedValueOnce(new Error('Revision changed')).mockResolvedValueOnce({});
  render(<TemplateInsertion document={document} template={localTemplate(variant)} onBack={vi.fn()} onBusy={vi.fn()} onInserted={vi.fn()} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('Revision changed');
  fireEvent.click(screen.getByRole('button', { name: 'Add node' }));
  await waitFor(() => expect(api.insertProjectComponent).toHaveBeenCalledTimes(2));
  expect(api.insertProjectComponent.mock.calls[0]![1].requestId).toBe(api.insertProjectComponent.mock.calls[1]![1].requestId);
});

test('keeps a multi-node group together and reserves room for another alias on the same host', async () => {
  const second = { ...template, nodeId: 'second' };
  const third = { ...template, nodeId: 'third', serviceId: 'alias' };
  api.fetchComponentPreview.mockResolvedValue({ ...preview, document: { ...preview.document, nodes: [host, template, second, third] },
    component: { ...preview.component, presentation: { nodeOrder: ['template', 'second', 'third'], layout: [
      { nodeId: 'template', x: 100, y: 200 }, { nodeId: 'second', x: 360, y: 220 }, { nodeId: 'third', x: 800, y: 200 },
    ] }, hostBindings: [...preview.component.hostBindings, { bindingId: 'alias', serviceClass: 'test.engine', definitionRef: 'engine' }] } });
  render(<TemplateInsertion document={{ ...document, layout: [{ nodeId: 'engine', x: 300, y: 200, width: 1000, height: 900, collapsed: false }] }}
    template={{ ...localTemplate(variant), kind: 'component' }} position={{ x: 350, y: 360 }} onBack={vi.fn()} onBusy={vi.fn()} onInserted={vi.fn()} />);
  await waitFor(() => expect(api.insertProjectComponent).toHaveBeenCalled());
  const request = api.insertProjectComponent.mock.calls[0]![1] as { hostOffsets: Record<string, { x: number; y: number }> };
  const first = request.hostOffsets.host!;
  const alias = request.hostOffsets.alias!;
  expect(first.x + 100).toBe(350);
  expect(first.y + 200).toBe(360);
  const thirdX = alias.x + 800;
  const thirdY = alias.y + 200;
  // First group spans 500 by 84; the other group must remain outside it.
  expect(thirdX >= 850 || thirdX + 240 <= 350 || thirdY >= 444 || thirdY + 64 <= 360).toBe(true);
});
