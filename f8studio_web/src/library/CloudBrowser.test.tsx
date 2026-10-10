import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { CloudAsset } from '../api/contracts.gen';
import { CloudProvider } from './CloudContext';
import { CloudBrowser } from './CloudBrowser';

const api = vi.hoisted(() => ({ cloudStatus: vi.fn(), cloudSearch: vi.fn(), cloudRelations: vi.fn(),
  cloudPreview: vi.fn(), cloudRelate: vi.fn(), cloudUpdateListing: vi.fn(), cloudDraft: vi.fn(),
  cloudGraphPreview: vi.fn(), cloudOpenGraph: vi.fn(), cloudVersions: vi.fn(), cloudInsert: vi.fn(), cloudDeletePublication: vi.fn() }));
vi.mock('./cloudApi', () => api);
vi.mock('../graph/GraphView', () => ({ GraphView: ({document}:{document:{projectId?:string}}) => <div>Cloud preview {document.projectId}</div> }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const asset: CloudAsset = { assetId: 'remote', kind: 'component', name: 'Shared script', description: 'A template', tags: ['script'],
  visibility: 'public', version: 3, contentHash: 'hash', license: 'MIT', author: { id: 'author', name: 'Alice' }, updatedAt: 'now' };
const relations = { likes: 2, liked: false, following: false, followingAuthor: false, hasUpdate: false, latestVersion: 3 };
function setup(userId: string) {
  api.cloudStatus.mockResolvedValue({ configured: true, registryId: 'https://cloud.test', user: { id: userId, name: userId } });
  api.cloudSearch.mockResolvedValue({ items: [asset], nextCursor: null });
  api.cloudRelations.mockResolvedValue(relations);
  api.cloudPreview.mockResolvedValue({ document: {}, issues: [] });
  api.cloudVersions.mockResolvedValue([]);
}

test('a chosen earlier component release is used for both preview and creating a local draft', async () => {
  setup('reader');
  api.cloudVersions.mockResolvedValue([{ version: 3, contentHash: 'hash', note: 'Latest', createdAt: 'now' },
    { version: 1, contentHash: 'old-hash', note: 'Original release', createdAt: 'before',license:'CC-BY-4.0' }]);
  api.cloudDraft.mockResolvedValue({ assetId: 'older-draft' });
  const onDraft=vi.fn().mockResolvedValue(undefined);
  render(<CloudProvider><CloudBrowser view="all" project={null} onDraft={onDraft} onInserted={vi.fn()}/></CloudProvider>);
  fireEvent.click(await screen.findByRole('button', { name: /Shared script/ }));
  await screen.findByRole('option', { name: 'v1' });
  fireEvent.change(screen.getByLabelText('Cloud content version'), { target: { value: '1' } });
  expect(await screen.findByText('Original release')).toBeInTheDocument();
  expect(screen.getByText('Alice · cloud v1 · CC-BY-4.0')).toBeInTheDocument();
  await waitFor(()=>expect(api.cloudPreview).toHaveBeenLastCalledWith({registryId:'https://cloud.test',assetId:'remote',version:1,contentHash:'old-hash'},expect.any(AbortSignal)));
  fireEvent.click(screen.getByRole('button', { name: 'Create local draft' }));
  await waitFor(()=>expect(onDraft).toHaveBeenCalledWith('older-draft'));
  expect(api.cloudDraft).toHaveBeenCalledWith({registryId:'https://cloud.test',assetId:'remote',version:1,contentHash:'old-hash'});
});

test('an earlier complete graph release can be previewed without downloading the latest content', async () => {
  setup('reader');
  api.cloudSearch.mockResolvedValue({items:[{...asset,kind:'graph'}],nextCursor:null});
  api.cloudVersions.mockResolvedValue([{version:1,contentHash:'old-graph',note:'First graph',createdAt:'before'}]);
  api.cloudGraphPreview.mockResolvedValue({document:{},issues:[]});
  render(<CloudProvider><CloudBrowser view="all" project={null} onDraft={vi.fn()} onInserted={vi.fn()}/></CloudProvider>);
  fireEvent.click(await screen.findByRole('button',{name:/Shared script/}));
  await screen.findByRole('option',{name:'v1'});
  fireEvent.change(screen.getByLabelText('Cloud content version'),{target:{value:'1'}});
  await waitFor(()=>expect(api.cloudGraphPreview).toHaveBeenLastCalledWith({registryId:'https://cloud.test',assetId:'remote',version:1,contentHash:'old-graph'},expect.any(AbortSignal)));
  expect(await screen.findByRole('button',{name:'Open as local project'})).toBeEnabled();
  expect(api.cloudPreview).not.toHaveBeenCalled();
});

test('offline search can be retried without changing the search query',async()=>{
  setup('reader');
  api.cloudSearch.mockRejectedValueOnce(new Error('Cloud is offline'));
  render(<CloudProvider><CloudBrowser view="all" project={null} onDraft={vi.fn()} onInserted={vi.fn()}/></CloudProvider>);
  expect(await screen.findByRole('alert')).toHaveTextContent('Cloud is offline');
  fireEvent.click(screen.getByRole('button',{name:'Retry search'}));
  expect(await screen.findByRole('button',{name:/Shared script/})).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('a late preview from the previous selection cannot replace the currently selected work',async()=>{
  setup('reader');
  api.cloudSearch.mockResolvedValue({items:[asset,{...asset,assetId:'next',name:'Next template'}],nextCursor:null});
  let finishOld!:(value:{document:{projectId:string};issues:[]})=>void;
  api.cloudPreview.mockImplementation((reference:{assetId:string})=>reference.assetId==='remote'?
    new Promise((resolve)=>{finishOld=resolve;}):Promise.resolve({document:{projectId:'next-preview'},issues:[]}));
  render(<CloudProvider><CloudBrowser view="all" project={null} onDraft={vi.fn()} onInserted={vi.fn()}/></CloudProvider>);
  fireEvent.click(await screen.findByRole('button',{name:/Shared script/}));
  fireEvent.click(screen.getByRole('button',{name:/Next template/}));
  expect(await screen.findByText('Cloud preview next-preview')).toBeInTheDocument();
  await act(async()=>{finishOld({document:{projectId:'old-preview'},issues:[]});});
  expect(screen.queryByText('Cloud preview old-preview')).not.toBeInTheDocument();
  expect(screen.getByText('Cloud preview next-preview')).toBeInTheDocument();
});

test('finishing a draft request after switching accounts does not navigate away from the new account',async()=>{
  setup('reader');
  let finishDraft!:(value:{assetId:string})=>void;
  api.cloudDraft.mockImplementation(()=>new Promise((resolve)=>{finishDraft=resolve;}));
  const onDraft=vi.fn();
  render(<CloudProvider><CloudBrowser view="all" project={null} onDraft={onDraft} onInserted={vi.fn()}/></CloudProvider>);
  fireEvent.click(await screen.findByRole('button',{name:/Shared script/}));
  fireEvent.click(screen.getByRole('button',{name:'Create local draft'}));
  api.cloudStatus.mockResolvedValue({configured:true,registryId:'https://cloud.test',user:{id:'another-reader',name:'New account'}});
  fireEvent.focus(window);
  await waitFor(()=>expect(screen.queryByRole('button',{name:'Create local draft'})).not.toBeInTheDocument());
  await act(async()=>{finishDraft({assetId:'old-account-draft'});});
  expect(onDraft).not.toHaveBeenCalled();
});

test('another author’s publication exposes community and draft actions without editable metadata', async () => {
  setup('reader');
  api.cloudRelate.mockResolvedValue({ ...relations, liked: true, likes: 3 });
  render(<CloudProvider><CloudBrowser view="all" project={null} onDraft={vi.fn()} onInserted={vi.fn()}/></CloudProvider>);
  fireEvent.click(await screen.findByRole('button', { name: /Shared script/ }));
  expect(screen.getByText('Another author’s Cloud work')).toBeInTheDocument();
  expect(screen.queryByText('Manage your Cloud listing')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('Cloud name')).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Delete|Publish update|Save Cloud/ })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Create local draft' })).toBeInTheDocument();
  fireEvent.click(await screen.findByRole('button', { name: 'Like · 2' }));
  expect(await screen.findByRole('button', { name: 'Unlike · 3' })).toBeInTheDocument();
  expect(api.cloudRelate).toHaveBeenCalledWith('remote', 'like', true);
  expect(api.cloudUpdateListing).not.toHaveBeenCalled();
});

test('the owner manages Cloud metadata and opens an existing local draft without cloning', async () => {
  setup('author');
  const onDraft = vi.fn();
  api.cloudUpdateListing.mockResolvedValue({ ...asset, name: 'Renamed', visibility: 'private' });
  render(<CloudProvider><CloudBrowser view="mine" project={null} onDraft={onDraft} onInserted={vi.fn()}
    draftLinks={[{ localAssetId: 'local', owned: true, authorId: 'author', source: {repositoryUrl:null,assetId:null,assetVersion:null}, authorSource: {repositoryUrl:null,assetId:null,assetVersion:null},
      reference: { registryId: 'https://cloud.test', assetId: 'remote', version: 3, contentHash: 'hash' } }]}/></CloudProvider>);
  fireEvent.click(await screen.findByRole('button', { name: /Shared script/ }));
  expect(api.cloudSearch).toHaveBeenCalledWith('', null, expect.any(AbortSignal), 'mine', 'all');
  fireEvent.click(screen.getByText('Manage your Cloud listing'));
  fireEvent.change(screen.getByLabelText('Cloud name'), { target: { value: 'Renamed' } });
  fireEvent.change(screen.getByLabelText('Cloud visibility'), { target: { value: 'private' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save Cloud listing' }));
  expect(await screen.findByText('Cloud listing saved. Content version unchanged.')).toBeInTheDocument();
  expect(api.cloudUpdateListing).toHaveBeenCalledWith('remote', { name: 'Renamed', description: 'A template', tags: ['script'], visibility: 'private' });
  fireEvent.click(screen.getByRole('button', { name: 'Edit local draft' }));
  await waitFor(() => expect(onDraft).toHaveBeenCalledWith('local'));
  expect(api.cloudDraft).not.toHaveBeenCalled();
});

test('owner deletion requires confirmation, reports failure, and refreshes the sidebar after success', async () => {
  setup('author');
  api.cloudDeletePublication.mockRejectedValueOnce(new Error('Cloud is offline')).mockResolvedValue({assetId:'remote'});
  const onDraft = vi.fn();
  render(<CloudProvider><CloudBrowser view="mine" project={null} onDraft={onDraft} onInserted={vi.fn()}/></CloudProvider>);
  fireEvent.click(await screen.findByRole('button', {name:/Shared script/}));
  fireEvent.click(screen.getByRole('button', {name:'More publication actions'}));
  fireEvent.click(screen.getByRole('menuitem', {name:'Delete Cloud publication'}));
  let dialog = screen.getByRole('dialog', {name:'Delete Cloud publication'});
  expect(dialog).toHaveTextContent('all published versions');
  expect(api.cloudDeletePublication).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', {name:'Cancel'}));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', {name:'More publication actions'}));
  fireEvent.click(screen.getByRole('menuitem', {name:'Delete Cloud publication'}));
  dialog = screen.getByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', {name:'Delete Cloud publication'}));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Cloud is offline');
  expect(screen.getByRole('heading', {name:'Shared script'})).toBeInTheDocument();
  api.cloudSearch.mockResolvedValue({items:[],nextCursor:null});
  fireEvent.click(within(dialog).getByRole('button', {name:'Delete Cloud publication'}));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(await screen.findByText(/No Cloud publications yet/)).toBeInTheDocument();
  expect(screen.getByText('Cloud publication deleted. Local drafts and projects are preserved.')).toBeInTheDocument();
  expect(api.cloudDeletePublication).toHaveBeenCalledWith('remote');
  expect(onDraft).not.toHaveBeenCalled();
});

test('switching account dismisses the owner delete confirmation', async () => {
  setup('author');
  render(<CloudProvider><CloudBrowser view="all" project={null} onDraft={vi.fn()} onInserted={vi.fn()}/></CloudProvider>);
  fireEvent.click(await screen.findByRole('button', {name:/Shared script/}));
  fireEvent.click(screen.getByRole('button', {name:'More publication actions'}));
  fireEvent.click(screen.getByRole('menuitem', {name:'Delete Cloud publication'}));
  api.cloudStatus.mockResolvedValue({configured:true,registryId:'https://cloud.test',user:{id:'reader',name:'Reader'}});
  fireEvent.focus(window);
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  fireEvent.click(await screen.findByRole('button', {name:/Shared script/}));
  expect(screen.queryByRole('button', {name:'More publication actions'})).not.toBeInTheDocument();
  expect(api.cloudDeletePublication).not.toHaveBeenCalled();
});

test.each(['all','mine','following'] as const)('%s distinguishes same-name kinds and filters in the main sidebar',async(view)=>{
  setup('author');
  const works: CloudAsset[] = (['graph','component','variant'] as const).map((kind)=>({...asset,
    assetId:`same-${kind}`,kind,name:'Same name'}));
  api.cloudSearch.mockImplementation((_query,_cursor,_signal,_view,kind)=>Promise.resolve({
    items:kind==='all'?works:works.filter((item)=>item.kind===kind),nextCursor:null,
  }));
  api.cloudGraphPreview.mockResolvedValue({document:{},issues:[]});
  render(<CloudProvider><CloudBrowser view={view} project={null} onDraft={vi.fn()} onInserted={vi.fn()}/></CloudProvider>);
  const sidebar=screen.getByRole('complementary',{name:'Cloud library sidebar'});
  const filters=await within(sidebar).findByRole('group',{name:'Cloud asset type'});
  const results=within(sidebar).getByLabelText('Cloud results');
  await waitFor(()=>expect(within(results).getAllByRole('button')).toHaveLength(3));
  expect(within(results).getByText('Project graph · Cloud v3')).toBeInTheDocument();
  expect(within(results).getByText('Component · Cloud v3')).toBeInTheDocument();
  expect(within(results).getByText('Variant · Cloud v3')).toBeInTheDocument();
  fireEvent.click(within(results).getByRole('button',{name:/Same name.*Component/}));
  expect(screen.getByRole('heading',{name:'Same name'})).toBeInTheDocument();
  for(const [kind,label] of [['graph','Graphs'],['component','Components'],['variant','Variants']] as const) {
    fireEvent.click(within(filters).getByRole('button',{name:label}));
    await waitFor(()=>expect(api.cloudSearch).toHaveBeenLastCalledWith('',null,expect.any(AbortSignal),view,kind));
    await waitFor(()=>expect(within(results).getAllByRole('button')).toHaveLength(1));
    expect(within(filters).getByRole('button',{name:label})).toHaveAttribute('aria-pressed','true');
    expect(screen.queryByRole('heading',{name:'Same name'})).not.toBeInTheDocument();
  }
  fireEvent.click(within(filters).getByRole('button',{name:'All'}));
  await waitFor(()=>expect(within(results).getAllByRole('button')).toHaveLength(3));
});

test('a late unfiltered result cannot overwrite the chosen kind',async()=>{
  setup('reader');
  let finishOld!:(value:{items:CloudAsset[];nextCursor:null})=>void;
  api.cloudSearch.mockImplementation((_query,_cursor,_signal,_view,kind)=>kind==='all'?
    new Promise((resolve)=>{finishOld=resolve;}):Promise.resolve({items:[{...asset,kind:'graph',name:'Only graph'}],nextCursor:null}));
  render(<CloudProvider><CloudBrowser view="all" project={null} onDraft={vi.fn()} onInserted={vi.fn()}/></CloudProvider>);
  await waitFor(()=>expect(api.cloudSearch).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button',{name:'Graphs'}));
  expect(await screen.findByRole('button',{name:/Only graph/})).toBeInTheDocument();
  await act(async()=>{finishOld({items:[asset],nextCursor:null});});
  expect(screen.queryByRole('button',{name:/Shared script/})).not.toBeInTheDocument();
  expect(screen.getByRole('button',{name:/Only graph/})).toBeInTheDocument();
});

test('pagination retains the type and keyword, and empty filtered results explain the filter',async()=>{
  setup('author');
  api.cloudSearch.mockImplementation((_query,cursor,_signal,_view,kind)=>Promise.resolve(kind==='variant'?{
    items:[{...asset,assetId:cursor?'second-variant':'first-variant',kind:'variant',name:cursor?'Second variant':'First variant'}],
    nextCursor:cursor?null:'variant-page-2',
  }:{items:[],nextCursor:null}));
  render(<CloudProvider><CloudBrowser view="mine" project={null} onDraft={vi.fn()} onInserted={vi.fn()}/></CloudProvider>);
  fireEvent.change(await screen.findByLabelText('Search online Library'),{target:{value:'timing'}});
  fireEvent.click(screen.getByRole('button',{name:'Variants'}));
  fireEvent.click(await screen.findByRole('button',{name:'More results'}));
  expect(await screen.findByRole('button',{name:/Second variant/})).toBeInTheDocument();
  expect(api.cloudSearch).toHaveBeenLastCalledWith('timing','variant-page-2',expect.any(AbortSignal),'mine','variant');
  fireEvent.click(screen.getByRole('button',{name:'Graphs'}));
  expect(await screen.findByText('No Cloud works match your search and type filter.')).toBeInTheDocument();
  expect(screen.queryByText(/No Cloud publications yet/)).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'More results'})).not.toBeInTheDocument();
});
