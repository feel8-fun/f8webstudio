import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { AssetRecord, ProjectRecord, ProjectSummary } from '../api/contracts';
import type { ComponentPreview, PortableComponent } from '../api/contracts.gen';
import { AssetsWorkspace } from './AssetsWorkspace';
import { CloudProvider } from '../library/CloudContext';

const api = vi.hoisted(() => ({
  fetchAssets: vi.fn(), fetchProjects: vi.fn(), fetchAsset: vi.fn(), fetchAssetVersions: vi.fn(),
  fetchProjectVersions: vi.fn(), fetchProject: vi.fn(), fetchComponentPreview: vi.fn(), insertProjectComponent: vi.fn(),
  captureProjectComponent: vi.fn(), createAsset: vi.fn(), createProjectVersion: vi.fn(), deleteAsset: vi.fn(),
  patchProject: vi.fn(), restoreProjectVersion: vi.fn(), updateAsset: vi.fn(),
}));
vi.mock('../api/client', () => api);
const cloudApi = vi.hoisted(() => ({cloudStatus:vi.fn(),cloudSearch:vi.fn(),cloudDraftLinks:vi.fn(),cloudRelations:vi.fn(),cloudVersions:vi.fn(),cloudGraphPreview:vi.fn()}));
vi.mock('../library/cloudApi', () => cloudApi);
vi.mock('../graph/GraphView', () => ({ GraphView: () => <div data-testid="static-preview">Static preview</div> }));
afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); window.history.replaceState(null, '', '/'); });

const host = { kind: 'service' as const, nodeId: 'existing', serviceId: 'existing', name: 'Existing Engine', serviceClass: 'test.engine',
  enabled: true, stateValues: {}, portIds: {}, ports: [], spec: { specKind: 'service' as const, serviceClass: 'test.engine', label: 'Engine' } };
const project: ProjectRecord = { projectId: 'target', name: 'Target', description: '', createdAt: '', updatedAt: '',
  document: { schemaVersion: 'f8studio-document/3', projectId: 'target', graphId: 'target', graphRevision: 4, layoutRevision: 1,
    nodes: [host], edges: [], layout: [] } };
function projectSummary(record: ProjectRecord): ProjectSummary {
  return { projectId: record.projectId, name: record.name, description: record.description,
    createdAt: record.createdAt, updatedAt: record.updatedAt,
    graphRevision: record.document.graphRevision, layoutRevision: record.document.layoutRevision };
}
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
  api.fetchProjects.mockResolvedValue([projectSummary(project)]);
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
  expect(screen.getByRole('button', { name: 'Add to project' })).toBeDisabled();
  fireEvent.change(screen.getByRole('combobox', { name: 'Host for source_host' }), { target: { value: 'existing' } });
  expect(screen.getByRole('button', { name: 'Add to project' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Add to project' }));
  await waitFor(() => expect(api.insertProjectComponent).toHaveBeenCalledWith('target', {
    requestId: expect.stringMatching(/^component:/), expectedGraphRevision: 4, expectedLayoutRevision: 1,
    assetId: 'template', version: 1, hostBindings: { source_host: 'existing' },
  }));
  expect(api.patchProject).not.toHaveBeenCalled();
});

test('My Local lists same-name graphs, components and variants with independent selection and filters', async () => {
  setup();
  const graph = { ...project, projectId: asset.assetId, name: asset.name, description: 'Complete timing graph' };
  const variant = { ...asset, assetId: 'variant', kind: 'variant' as const, description: 'Single timing operator' };
  api.fetchProjects.mockResolvedValue([projectSummary(graph)]);
  api.fetchProject.mockResolvedValue(graph);
  api.fetchAssets.mockResolvedValue([asset, variant]);
  api.fetchAsset.mockImplementation((id: string) => Promise.resolve(id === variant.assetId ? variant : asset));
  render(<AssetsWorkspace/>);
  const results = await screen.findByLabelText('Local results');
  await waitFor(() => expect(within(results).getAllByRole('button')).toHaveLength(3));
  fireEvent.click(within(results).getByRole('button', { name: /Project graph/ }));
  expect(await screen.findByRole('button', { name: 'Open in Graph' })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Local snapshots' })).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Publish to Cloud' })).toHaveTextContent('Share the complete saved graph');
  expect(screen.queryByLabelText('Asset name')).not.toBeInTheDocument();
  fireEvent.click(within(results).getByRole('button', { name: /Component/ }));
  expect(await screen.findByLabelText('Asset name')).toHaveValue(asset.name);
  expect(screen.queryByRole('region', { name: 'Local snapshots' })).not.toBeInTheDocument();
  expect(results.querySelectorAll('.selected')).toHaveLength(1);
  const types = screen.getByRole('group', { name: 'Local asset type' });
  for (const label of ['Graphs', 'Components', 'Variants']) {
    fireEvent.click(within(types).getByRole('button', { name: label }));
    expect(within(results).getAllByRole('button')).toHaveLength(1);
    expect(within(results).getByRole('button')).toHaveTextContent(label === 'Graphs' ? 'Project graph' : label.slice(0, -1));
  }
  fireEvent.click(within(results).getByRole('button'));
  await waitFor(() => expect(screen.getByText('Variant · v1')).toBeInTheDocument());
  fireEvent.click(within(types).getByRole('button', { name: 'All' }));
  fireEvent.change(screen.getByLabelText('Search My Local'), { target: { value: 'complete timing' } });
  expect(within(results).getByRole('button')).toHaveTextContent('Project graph');
  expect(within(results).getAllByRole('button')).toHaveLength(1);
  fireEvent.change(screen.getByLabelText('Search My Local'), { target: { value: 'not here' } });
  expect(within(results).queryByRole('button')).not.toBeInTheDocument();
  expect(screen.getByText('No local works match your search and type filter.')).toBeInTheDocument();
});

test('a pending draft cannot replace graph details after selecting a graph', async () => {
  setup();
  let finishDraft!: (value: AssetRecord) => void;
  api.fetchAsset.mockImplementation(() => new Promise((resolve) => { finishDraft = resolve; }));
  render(<AssetsWorkspace/>);
  fireEvent.click(await screen.findByRole('button', { name: /Smooth script/ }));
  fireEvent.click(screen.getByRole('button', { name: /Target.*Project graph/ }));
  expect(await screen.findByRole('button', { name: 'Open in Graph' })).toBeInTheDocument();
  await act(async () => { finishDraft(asset); });
  expect(screen.queryByLabelText('Asset name')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open in Graph' })).toBeInTheDocument();
});

test('switching graphs hides old graph actions while the newly selected graph loads', async () => {
  setup();
  const next = { ...project, projectId: 'next', name: 'Next graph' };
  api.fetchProjects.mockResolvedValue([projectSummary(project), projectSummary(next)]);
  let finishNext!: (value: ProjectRecord) => void;
  api.fetchProject.mockImplementation((id: string) => id === next.projectId
    ? new Promise((resolve) => { finishNext = resolve; }) : Promise.resolve(project));
  render(<AssetsWorkspace/>);
  fireEvent.click(await screen.findByRole('button', { name: /Target.*Project graph/ }));
  expect(await screen.findByRole('button', { name: 'Open in Graph' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /Next graph.*Project graph/ }));
  expect(screen.queryByRole('button', { name: 'Open in Graph' })).not.toBeInTheDocument();
  await act(async () => { finishNext(next); });
  expect(screen.getByRole('heading', { name: next.name })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open in Graph' })).toBeInTheDocument();
});

test.each(['projects', 'history'])('legacy %s URLs open My Local with the remembered graph and Graphs filter', async (view) => {
  setup();
  const other = { ...project, projectId: 'other', name: 'Other graph' };
  api.fetchProjects.mockResolvedValue([projectSummary(other), projectSummary(project)]);
  localStorage.setItem('f8studio.selectedProjectId', project.projectId);
  window.history.replaceState(null, '', `/?view=assets&library=${view}`);
  render(<AssetsWorkspace/>);
  expect(await screen.findByRole('button', { name: 'Open in Graph' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'My Local' })).toBeInTheDocument();
  expect(within(screen.getByRole('group', { name: 'Local asset type' })).getByRole('button', { name: 'Graphs' })).toHaveAttribute('aria-pressed', 'true');
  expect(within(screen.getByLabelText('Local results')).queryByRole('button', { name: /Component/ })).not.toBeInTheDocument();
  expect(new URLSearchParams(window.location.search).get('library')).toBe('local');
});

test('saving a graph as a component reveals the new draft despite the Graphs filter and search', async () => {
  setup();
  api.fetchAssets.mockResolvedValue([]);
  api.captureProjectComponent.mockImplementation(async () => {
    api.fetchAssets.mockResolvedValue([asset]);
    return asset;
  });
  render(<AssetsWorkspace/>);
  fireEvent.click(await screen.findByRole('button', { name: /Target.*Project graph/ }));
  fireEvent.click(within(screen.getByRole('group', { name: 'Local asset type' })).getByRole('button', { name: 'Graphs' }));
  fireEvent.change(screen.getByLabelText('Search My Local'), { target: { value: project.name } });
  fireEvent.click(await screen.findByRole('button', { name: 'Save as Component' }));
  fireEvent.click(within(screen.getByRole('dialog', { name: 'Save as Component' })).getByRole('button', { name: 'Save as Component' }));
  expect(await screen.findByLabelText('Asset name')).toHaveValue(asset.name);
  expect(screen.getByLabelText('Search My Local')).toHaveValue('');
  expect(within(screen.getByLabelText('Local results')).getByRole('button', { name: /Smooth script/ })).toHaveClass('selected');
  expect(api.captureProjectComponent).toHaveBeenCalledWith(project.projectId, project.document, 'Target component', []);
});

test('keeps missing-extension preview visible and prevents insertion', async () => {
  setup({ ...preview, issues: [{ code: 'missing_definition', nodeId: 'script', message: 'Install test.extension before insertion' }] });
  render(<AssetsWorkspace />);
  fireEvent.click(await screen.findByRole('button', { name: /Smooth script/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Install test.extension');
  expect(screen.getByTestId('static-preview')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Add to project' })).toBeDisabled();
  expect(api.insertProjectComponent).not.toHaveBeenCalled();
});

test('local and online management stay visibly separate even before Cloud is configured', async () => {
  setup();
  render(<AssetsWorkspace />);
  fireEvent.click(await screen.findByRole('button', { name: /Smooth script/ }));
  expect(await screen.findByText('Local draft')).toBeInTheDocument();
  expect(screen.queryByText('Content JSON')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'More draft actions'}));
  expect(screen.getByRole('menuitem', { name: 'Delete local draft' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save draft' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Connect Cloud' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'My Cloud' }));
  expect(screen.getByRole('heading', { name: 'My Cloud' })).toBeInTheDocument();
  expect(screen.getByText('Connect Feel8 Cloud')).toBeInTheDocument();
  expect(screen.queryByRole('textbox', { name: 'Asset name' })).not.toBeInTheDocument();
  expect(screen.queryByRole('menuitem', { name: 'Delete local draft' })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'My Local' }));
  expect(screen.getByRole('textbox', { name: 'Asset name' })).toHaveValue('Smooth script');
  expect(api.deleteAsset).not.toHaveBeenCalled();
});

test('a slow previous draft response does not overwrite edits in the new selection',async()=>{
  setup();
  const next={...asset,assetId:'next',name:'Next draft'};
  api.fetchAssets.mockResolvedValue([asset,next]);
  let finishOld!:(value:AssetRecord)=>void;
  api.fetchAsset.mockImplementation((assetId:string)=>assetId==='template'?new Promise((resolve)=>{finishOld=resolve;}):Promise.resolve(next));
  render(<AssetsWorkspace/>);
  fireEvent.click(await screen.findByRole('button',{name:/Smooth script/}));
  fireEvent.click(screen.getByRole('button',{name:/Next draft/}));
  await waitFor(()=>expect(screen.getByLabelText('Asset name')).toHaveValue('Next draft'));
  fireEvent.change(screen.getByLabelText('Asset name'),{target:{value:'Local unsaved edit'}});
  await act(async()=>{finishOld(asset);});
  expect(screen.getByLabelText('Asset name')).toHaveValue('Local unsaved edit');
});

test.each(['My Cloud','Discover','Following'])('%s uses the main sidebar for both navigation and Cloud results', async (view) => {
  setup();
  cloudApi.cloudStatus.mockResolvedValue({configured:true,registryId:'https://cloud.test',user:{id:'owner',name:'Owner'}});
  cloudApi.cloudDraftLinks.mockResolvedValue([]);
  cloudApi.cloudSearch.mockResolvedValue({items:[{assetId:'cloud-graph',kind:'graph',name:'Cloud graph',description:'Shared graph',tags:[],visibility:'public',version:1,contentHash:'hash',license:'MIT',author:{id:'owner',name:'Owner'}}],nextCursor:null});
  cloudApi.cloudRelations.mockResolvedValue({likes:0,liked:false,following:false,followingAuthor:false,latestVersion:1});
  cloudApi.cloudVersions.mockResolvedValue([]);
  cloudApi.cloudGraphPreview.mockResolvedValue({document:project.document,issues:[]});
  render(<CloudProvider><AssetsWorkspace/></CloudProvider>);
  fireEvent.click(screen.getByRole('button', {name:view}));
  const sidebar = screen.getByRole('complementary', {name:'Cloud library sidebar'});
  const result = await within(sidebar).findByRole('button', {name:/Cloud graph/});
  expect(within(sidebar).getByRole('navigation', {name:'Asset library'})).toBeInTheDocument();
  expect(within(sidebar).getByRole('textbox', {name:'Search online Library'})).toBeInTheDocument();
  fireEvent.click(result);
  const details = screen.getByRole('region', {name:'Online Library'});
  expect(within(details).getByRole('heading', {name:'Cloud graph'})).toBeInTheDocument();
  expect(within(details).queryByLabelText('Cloud results')).not.toBeInTheDocument();
  expect(within(details).queryByRole('textbox', {name:'Search online Library'})).not.toBeInTheDocument();
  expect(document.querySelectorAll('.assets-workspace > .asset-browser')).toHaveLength(1);
});
