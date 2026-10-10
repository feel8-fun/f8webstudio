import { afterEach, expect, test, vi } from 'vitest';
import { createCloudProvider } from './cloudProvider';
import { cloudSearch } from './cloudApi';
import type { StudioDocument } from '../api/contracts';
afterEach(()=>vi.unstubAllGlobals());
test('Cloud source filters graph actions and fixes registry, version and content hash',async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({items:[
    {assetId:'template',kind:'component',name:'Script',description:'',tags:[],version:3,contentHash:'hash3',author:{id:'author',name:'Author'},license:'MIT'},
    {assetId:'graph',kind:'graph'},
  ],nextCursor:'next'})));
  vi.stubGlobal('fetch',fetch);
  const provider=createCloudProvider('https://cloud.test');
  const page=await provider.search('script',null,new AbortController().signal);
  expect(page.items).toHaveLength(1);expect(page.nextCursor).toBe('next');
  expect(page.items[0]!.reference).toEqual({source:'cloud',registryId:'https://cloud.test',assetId:'template',version:3,contentHash:'hash3'});
  fetch.mockResolvedValue(new Response('{}'));
  await provider.preview(page.items[0]!.reference,new AbortController().signal);
  const payload=JSON.parse(fetch.mock.calls[1]![1]!.body as string);
  expect(payload).toEqual({registryId:'https://cloud.test',assetId:'template',version:3,contentHash:'hash3'});
  expect(fetch.mock.calls[1]![0]).toBe('/api/cloud/templates:preview');
});
test('online insert uses the remote insertion route and rejects local references',async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response('{}'));vi.stubGlobal('fetch',fetch);
  const provider=createCloudProvider('https://cloud.test');
  const reference={source:'cloud' as const,registryId:'https://cloud.test',assetId:'asset',version:2,contentHash:'hash2'};
  await provider.insert(reference,{projectId:'project'} as StudioDocument,{requestId:'request',expectedGraphRevision:1,expectedLayoutRevision:2});
  expect(fetch.mock.calls[0]![0]).toBe('/api/projects/project/cloud:insert');
  expect(JSON.parse(fetch.mock.calls[0]![1]!.body as string).reference.version).toBe(2);
  await expect(provider.preview({source:'local',assetId:'asset',version:1},new AbortController().signal)).rejects.toThrow('local provider');
});

test('online search sends the kind with its keyword, view and pagination cursor',async()=>{
  const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({items:[],nextCursor:null})));
  vi.stubGlobal('fetch',fetch);
  await cloudSearch('same name','second-page',new AbortController().signal,'following','variant');
  const url=new URL(fetch.mock.calls[0]![0] as string,'http://studio.test');
  expect(url.pathname).toBe('/api/cloud/library');
  expect(Object.fromEntries(url.searchParams)).toEqual({q:'same name',cursor:'second-page',view:'following',kind:'variant'});
});
