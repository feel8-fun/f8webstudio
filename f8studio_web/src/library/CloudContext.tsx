import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { CloudStatus } from '../api/contracts.gen';
import { cloudStatus } from './cloudApi';
import { createCloudProvider } from './cloudProvider';
const CloudContext = createContext<{status:CloudStatus|null;error:string|null;reload:()=>Promise<void>}>({status:null,error:null,reload:async()=>{}});
export function CloudProvider({children}:{readonly children:ReactNode}) {
  const [status,setStatus]=useState<CloudStatus|null>(null);
  const [error,setError]=useState<string|null>(null);
  const reload=useCallback(async()=>{
    try {setStatus(await cloudStatus());setError(null);} catch(reason:unknown) {setError(reason instanceof Error?reason.message:'Cloud connection failed');}
  },[]);
  useEffect(()=>{const controller=new AbortController();
    void cloudStatus(controller.signal).then((v)=>{if(!controller.signal.aborted){setStatus(v);setError(null);}},(reason:unknown)=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'Cloud connection failed');});
    return()=>controller.abort();},[]);
  useEffect(()=>{const refresh=()=>void reload(); window.addEventListener('focus',refresh);return()=>window.removeEventListener('focus',refresh);},[reload]);
  return <CloudContext value={{status,error,reload}}>{children}</CloudContext>;
}
export function useCloud() {
  const context=useContext(CloudContext);
  const provider=useMemo(()=>context.status?.configured?createCloudProvider(context.status.registryId):undefined,[context.status?.configured,context.status?.registryId,context.status?.user?.id]);
  return {...context,provider};
}
