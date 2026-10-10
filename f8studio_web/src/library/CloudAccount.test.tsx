import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { CloudAccount } from './CloudAccount';
import { CloudProvider, useCloud } from './CloudContext';
import type { CloudStatus } from '../api/contracts.gen';

afterEach(()=>{cleanup();vi.unstubAllGlobals();});
const disconnected:CloudStatus={configured:false,registryId:'',user:null};

test('a failed connection remains editable, a retry connects, and disconnect explicitly clears it',async()=>{
  let status=disconnected;
  let attempts=0;
  const fetch=vi.fn(async(path:string,init?:RequestInit)=>{
    if(path==='/api/cloud/status')return new Response(JSON.stringify(status));
    const input=JSON.parse(init!.body as string) as {baseUrl:string};
    if(input.baseUrl&&attempts++===0)return new Response(JSON.stringify({code:'unsupported_cloud_api',message:'Cloud backend needs the Library v2 migration and deployment'}),{status:422});
    status={configured:Boolean(input.baseUrl),registryId:input.baseUrl,user:null};
    return new Response(JSON.stringify(status));
  });vi.stubGlobal('fetch',fetch);
  render(<CloudProvider><CloudAccount/></CloudProvider>);
  expect(screen.getByRole('button',{name:'Save connection'})).toBeDisabled();
  fireEvent.change(screen.getByLabelText('Cloud URL'),{target:{value:'http://127.0.0.1:8787'}});
  await waitFor(()=>expect(screen.getByRole('button',{name:'Save connection'})).toBeEnabled());
  fireEvent.click(screen.getByRole('button',{name:'Save connection'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('migration and deployment');
  expect(screen.queryByRole('button',{name:'Sign in to Cloud'})).not.toBeInTheDocument();
  expect(screen.getByLabelText('Cloud URL')).toHaveValue('http://127.0.0.1:8787');
  fireEvent.click(screen.getByRole('button',{name:'Save connection'}));
  expect(await screen.findByRole('button',{name:'Sign in to Cloud'})).toBeEnabled();
  expect(screen.getByText('Connected to http://127.0.0.1:8787')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Disconnect Cloud'}));
  expect(await screen.findByText('Cloud disconnected. Your local drafts remain available.')).toBeInTheDocument();
  await waitFor(()=>expect(screen.getByLabelText('Cloud URL')).toHaveValue(''));
});

test('a slow initial account response cannot overwrite the newer account after a refresh',async()=>{
  const responses:((response:Response)=>void)[]=[];
  vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>((resolve)=>responses.push(resolve))));
  function Account(){const {status}=useCloud();return <span>{status?.user?.name??'Loading'}</span>;}
  render(<CloudProvider><Account/></CloudProvider>);
  expect(responses).toHaveLength(1);
  fireEvent.focus(window);
  expect(responses).toHaveLength(2);
  await act(async()=>{responses[1]!(new Response(JSON.stringify({configured:true,registryId:'https://cloud.test',user:{id:'reader',name:'New account'}})));});
  expect(await screen.findByText('New account')).toBeInTheDocument();
  await act(async()=>{responses[0]!(new Response(JSON.stringify({configured:true,registryId:'https://cloud.test',user:{id:'author',name:'Old account'}})));});
  expect(screen.queryByText('Old account')).not.toBeInTheDocument();
  expect(screen.getByText('New account')).toBeInTheDocument();
});
