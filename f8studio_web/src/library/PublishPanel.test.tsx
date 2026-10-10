import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { CloudProvider } from './CloudContext';
import { PublishPanel } from './PublishPanel';
import type { AssetRecord, ProjectRecord } from '../api/contracts';
afterEach(()=>{cleanup();vi.unstubAllGlobals();localStorage.clear();});
const asset={assetId:'local',kind:'component',name:'Draft',description:'',tags:[],currentVersion:1,createdAt:'now',updatedAt:'now',content:{}} as AssetRecord;
test('editing does not publish, explicit retry preserves the request ID, same content reports unchanged',async()=>{
  const publications:Record<string,unknown>[]=[];
  const fetch=vi.fn(async(path:string,init?:RequestInit)=>{
    if(path==='/api/cloud/status')return new Response(JSON.stringify({configured:true,registryId:'https://cloud.test',user:{id:'user',name:'User'}}));
    if(path.endsWith('/cloud'))return new Response('null');
    publications.push(JSON.parse(init!.body as string));
    return publications.length===1?new Response('{"message":"Cloud is offline"}',{status:503}):new Response('{"assetId":"cloud","version":1,"contentHash":"hash","changed":false}');
  });vi.stubGlobal('fetch',fetch);
  render(<CloudProvider><PublishPanel asset={asset}/></CloudProvider>);
  expect(await screen.findByRole('button',{name:'Publish Component to Cloud'})).toBeInTheDocument();
  expect(publications).toHaveLength(0);
  fireEvent.click(screen.getByRole('button',{name:'Publish Component to Cloud'}));
  fireEvent.change(screen.getByLabelText('Version notes'),{target:{value:'First'}});
  expect(publications).toHaveLength(0);
  fireEvent.click(screen.getByRole('button',{name:'Publish'}));
  expect(await screen.findByText('Cloud is offline')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Retry publication'}));
  await waitFor(()=>expect(screen.getByText('Content unchanged · v1')).toBeInTheDocument());
  expect(publications[0]!.requestId).toBe(publications[1]!.requestId);
  expect(publications[1]!.localVersion).toBe(1);
});

test('reload and local edits recover the original publication; a later publish uses the new saved version',async()=>{
  const publications:Record<string,unknown>[]=[];
  vi.stubGlobal('fetch',vi.fn(async(path:string,init?:RequestInit)=>{
    if(path==='/api/cloud/status')return new Response(JSON.stringify({configured:true,registryId:'https://cloud.test',user:{id:'user',name:'User'}}));
    if(path.endsWith('/cloud'))return new Response('null');
    publications.push(JSON.parse(init!.body as string));
    return publications.length===1?new Response('{"message":"Response lost"}',{status:503}):new Response('{"assetId":"cloud","version":1,"contentHash":"hash","changed":true}');
  }));
  const first=render(<CloudProvider><PublishPanel asset={asset}/></CloudProvider>);
  fireEvent.click(await screen.findByRole('button',{name:/^(Publish Component to Cloud|Resume publication)$/}));
  fireEvent.click(await screen.findByRole('button',{name:'Publish'}));
  expect(await screen.findByText('Response lost')).toBeInTheDocument();
  first.unmount();
  render(<CloudProvider><PublishPanel asset={{...asset,currentVersion:2}}/></CloudProvider>);
  fireEvent.click(await screen.findByRole('button',{name:/^(Publish Component to Cloud|Resume publication)$/}));
  fireEvent.click(await screen.findByRole('button',{name:'Retry publication'}));
  expect(await screen.findByText('Published v1')).toBeInTheDocument();
  expect(publications[1]).toEqual(publications[0]);
  fireEvent.click(screen.getByRole('button',{name:'Publish'}));
  await waitFor(()=>expect(publications).toHaveLength(3));
  expect(publications[2]!.localVersion).toBe(2);
  expect(publications[2]!.requestId).not.toBe(publications[0]!.requestId);
});

test('a definitive publication rejection allows corrected options and a fresh request',async()=>{
  const publications:Record<string,unknown>[]=[];
  vi.stubGlobal('fetch',vi.fn(async(path:string,init?:RequestInit)=>{
    if(path==='/api/cloud/status')return new Response(JSON.stringify({configured:true,registryId:'https://cloud.test',user:{id:'user',name:'User'}}));
    if(path.endsWith('/cloud'))return new Response('null');
    publications.push(JSON.parse(init!.body as string));
    return publications.length===1?new Response('{"code":"license_restriction","message":"Choose a supported license"}',{status:403}):new Response('{"assetId":"cloud","version":1,"contentHash":"hash","changed":true}');
  }));
  render(<CloudProvider><PublishPanel asset={asset}/></CloudProvider>);
  fireEvent.click(await screen.findByRole('button',{name:/^(Publish Component to Cloud|Resume publication)$/}));
  fireEvent.click(await screen.findByRole('button',{name:'Publish'}));
  expect(await screen.findByText('Choose a supported license')).toBeInTheDocument();
  expect(screen.getByLabelText('Publication license')).toBeEnabled();
  fireEvent.change(screen.getByLabelText('Publication license'),{target:{value:'CC-BY-SA-4.0'}});
  fireEvent.click(screen.getByRole('button',{name:'Publish'}));
  expect(await screen.findByText('Published v1')).toBeInTheDocument();
  expect(publications[1]!.license).toBe('CC-BY-SA-4.0');
  expect(publications[1]!.requestId).not.toBe(publications[0]!.requestId);
});

test('unsaved local edits must be saved before a new Cloud publication',async()=>{
  const publications:Record<string,unknown>[]=[];
  vi.stubGlobal('fetch',vi.fn(async(path:string,init?:RequestInit)=>{
    if(path==='/api/cloud/status')return new Response(JSON.stringify({configured:true,registryId:'https://cloud.test',user:{id:'user',name:'User'}}));
    if(path.endsWith('/cloud'))return new Response('null');
    publications.push(JSON.parse(init!.body as string));
    return new Response('{"assetId":"cloud","version":1,"contentHash":"hash","changed":true}');
  }));
  const rendered=render(<CloudProvider><PublishPanel asset={asset} saved={false}/></CloudProvider>);
  fireEvent.click(await screen.findByRole('button',{name:/^(Publish Component to Cloud|Resume publication)$/}));
  expect(await screen.findByRole('button',{name:'Publish'})).toBeDisabled();
  expect(screen.getByText('Save your local changes before publishing.')).toBeInTheDocument();
  expect(publications).toHaveLength(0);
  rendered.rerender(<CloudProvider><PublishPanel asset={asset} saved/></CloudProvider>);
  expect(screen.getByRole('button',{name:'Publish'})).toBeEnabled();
});

test('graph configuration choices survive a lost response and page reload without resending private values',async()=>{
  const project:ProjectRecord={projectId:'project',name:'Test',description:'',createdAt:'',updatedAt:'',
    document:{schemaVersion:'f8studio-document/3',projectId:'project',graphId:'project',graphRevision:1,layoutRevision:0,edges:[],layout:[],
      nodes:[{kind:'service',nodeId:'player',serviceId:'player',serviceClass:'test.player',name:'Player',enabled:true,ports:[],portIds:{},
        stateValues:{gain:2,path:'/private/file'},spec:{specKind:'service',serviceClass:'test.player',label:'Player',stateFields:[
          {name:'gain',access:'rw',persistent:true,publishable:true,valueSchema:{type:'number',default:1}},
          {name:'path',access:'rw',persistent:true,publishable:false,valueSchema:{type:'string'}},
        ]}}]}};
  const publications:Record<string,unknown>[]=[];
  vi.stubGlobal('fetch',vi.fn(async(path:string,init?:RequestInit)=>{
    if(path==='/api/cloud/status')return new Response(JSON.stringify({configured:true,registryId:'https://cloud.test',user:{id:'user',name:'User'}}));
    if(path.endsWith('/cloud'))return new Response('null');
    publications.push(JSON.parse(init!.body as string));
    return publications.length===1?new Response('{"message":"Response lost"}',{status:503}):new Response('{"assetId":"cloud","version":1,"contentHash":"hash","changed":true}');
  }));
  const first=render(<CloudProvider><PublishPanel project={project}/></CloudProvider>);
  fireEvent.click(await screen.findByRole('button',{name:/^(Publish Project to Cloud|Resume publication)$/}));
  fireEvent.click(await screen.findByRole('button',{name:'Publish'}));
  expect(screen.getByRole('checkbox',{name:'Player.path'})).toBeDisabled();
  expect(screen.getByRole('checkbox',{name:'Player.path'})).not.toBeChecked();
  fireEvent.click(screen.getByRole('checkbox',{name:'Player.gain'}));
  fireEvent.click(screen.getByRole('button',{name:'Publish graph to Cloud'}));
  expect(await screen.findByText('Response lost')).toBeInTheDocument();
  expect(publications[0]!.excludedStates).toEqual([{nodeId:'player',field:'gain'}]);
  expect(JSON.stringify(publications[0])).not.toContain('/private/file');
  first.unmount();
  render(<CloudProvider><PublishPanel project={project}/></CloudProvider>);
  fireEvent.click(await screen.findByRole('button',{name:/^(Publish Project to Cloud|Resume publication)$/}));
  fireEvent.click(await screen.findByRole('button',{name:'Retry publication'}));
  expect(await screen.findByText('Published v1')).toBeInTheDocument();
  expect(publications[1]).toEqual(publications[0]);
  expect(screen.queryByRole('dialog',{name:'Publish graph to Cloud'})).not.toBeInTheDocument();
});
