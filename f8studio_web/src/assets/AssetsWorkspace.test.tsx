import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { AssetRecord, ProjectRecord } from '../api/contracts';
import type { ComponentPreview, PortableComponent } from '../api/contracts.gen';
import { AssetsWorkspace } from './AssetsWorkspace';

const api = vi.hoisted(() => ({
  fetchAssets: vi.fn(), fetchProjects: vi.fn(), fetchAsset: vi.fn(), fetchAssetVersions: vi.fn(),
  fetchProjectVersions: vi.fn(), fetchProject: vi.fn(), fetchComponentPreview: vi.fn(), insertProjectComponent: vi.fn(),
  captureProjectComponent: vi.fn(), createAsset: vi.fn(), createProjectVersion: vi.fn(), deleteAsset: vi.fn(),
  patchProject: vi.fn(), restoreProjectVersion: vi.fn(), updateAsset: vi.fn(),
}));
vi.mock('../api/client', () => api);
vi.mock('../graph/GraphView', () => ({ GraphView: () => <div data-testid="static-preview">Static preview</div> }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const host = { kind: 'service' as const, nodeId: 'existing', serviceId: 'existing', name: 'Existing Engine', serviceClass: 'test.engine',
  enabled: true, stateValues: {}, portIds: {}, ports: [], spec: { specKind: 'service' as const, serviceClass: 'test.engine', label: 'Engine' } };
const project: ProjectRecord = { projectId: 'target', name: 'Target', description: '', createdAt: '', updatedAt: '',
  document: { schemaVersion: 'f8studio-document/3', projectId: 'target', graphId: 'target', graphRevision: 4, layoutRevision: 1,
    nodes: [host], edges: [], layout: [] } };
const template: PortableComponent = { format: 'f8component', formatVersion: 1,
  definitions: { services: { host: host.spec }, operators: { script: { specKind: 'operator', serviceClass: 'test.engine', operatorClass: 'test.script', label: 'Script' } } },
  services: {}, operators: { script: { nodeId: 'script', name: 'Script', serviceId: 'source_host', definitionRef: 'script',
    enabled: true, portIds: {}, stateValues: { code: 'pass' } } }, connections: [],
  presentation: { nodeOrder: ['script'], layout: [] }, hostBindings: [{ bindingId: 'source_host', serviceClass: 'test.engine', definitionRef: 'host' }], endpoints: [] };
const asset: AssetRecord = { assetId: 'template', kind: 'component', name: 'Smooth script', description: '', tags: [],
  currentVersion: 1, createdAt: '', updatedAt: '', content: template as unknown as AssetRecord['content'] };
const preview: ComponentPreview = { assetId: 'template', version: 1, component: template, document: project.document, issues: [] };

function setup(nextPreview: ComponentPreview = preview): void {
  api.fetchAssets.mockResolvedValue([asset]);
  api.fetchProjects.mockResolvedValue([{ projectId: 'target', name: 'Target' }]);
  api.fetchAsset.mockResolvedValue(asset);
  api.fetchAssetVersions.mockResolvedValue([]);
  api.fetchProjectVersions.mockResolvedValue([]);
  api.fetchProject.mockResolvedValue(project);
  api.fetchComponentPreview.mockResolvedValue(nextPreview);
  api.insertProjectComponent.mockResolvedValue({ patch: { document: { ...project.document, graphRevision: 5 } }, source: { endpoints: [] } });
}

test('selects an existing host and inserts a fixed component version through the server', async () => {
  setup();
  render(<AssetsWorkspace />);
  fireEvent.click(await screen.findByRole('button', { name: /Smooth script/ }));
  expect(await screen.findByTestId('static-preview')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  fireEvent.change(screen.getByRole('combobox', { name: 'Host for source_host' }), { target: { value: 'existing' } });
  expect(screen.getByRole('button', { name: 'Apply' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
  await waitFor(() => expect(api.insertProjectComponent).toHaveBeenCalledWith('target', {
    requestId: expect.stringMatching(/^component:/), expectedGraphRevision: 4, expectedLayoutRevision: 1,
    assetId: 'template', version: 1, hostBindings: { source_host: 'existing' },
  }));
  expect(api.patchProject).not.toHaveBeenCalled();
});

test('keeps missing-extension preview visible and prevents insertion', async () => {
  setup({ ...preview, issues: [{ code: 'missing_definition', nodeId: 'script', message: 'Install test.extension before insertion' }] });
  render(<AssetsWorkspace />);
  fireEvent.click(await screen.findByRole('button', { name: /Smooth script/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Install test.extension');
  expect(screen.getByTestId('static-preview')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Apply' })).toBeDisabled();
  expect(api.insertProjectComponent).not.toHaveBeenCalled();
});
