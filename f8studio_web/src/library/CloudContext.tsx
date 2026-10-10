import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CloudStatus } from '../api/contracts.gen';
import { cloudStatus } from './cloudApi';
import { createCloudProvider } from './cloudProvider';
const CloudContext = createContext<{status:CloudStatus|null;error:string|null;reload:()=>Promise<void>;libraryRevision:number;refreshLibrary:()=>void}>({status:null,error:null,reload:async()=>{},libraryRevision:0,refreshLibrary:()=>{}});
export function CloudProvider({children}:{readonly children:ReactNode}) {
  const [status,setStatus]=useState<CloudStatus|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [libraryRevision,setLibraryRevision]=useState(0);
  const statusRequest=useRef<AbortController|null>(null);
  const refreshLibrary=useCallback(()=>setLibraryRevision((previous)=>previous+1),[]);
  const reload=useCallback(async()=>{
    statusRequest.current?.abort();
    const controller=new AbortController();statusRequest.current=controller;
    try {const value=await cloudStatus(controller.signal);if(!controller.signal.aborted){setStatus(value);setError(null);}}
    catch(reason:unknown) {if(!controller.signal.aborted){console.error('Cannot load Cloud account status',reason);setError(reason instanceof Error?reason.message:'Cloud connection failed');}}
  },[]);
  useEffect(()=>{void reload();return()=>statusRequest.current?.abort();},[reload]);
  useEffect(()=>{const refresh=()=>void reload(); window.addEventListener('focus',refresh);return()=>window.removeEventListener('focus',refresh);},[reload]);
  return <CloudContext value={{status,error,reload,libraryRevision,refreshLibrary}}>{children}</CloudContext>;
}
export function useCloud() {
  const context=useContext(CloudContext);
  const provider=useMemo(()=>context.status?.configured?createCloudProvider(context.status.registryId):undefined,[context.status?.configured,context.status?.registryId,context.status?.user?.id]);
  return {...context,provider};
}
