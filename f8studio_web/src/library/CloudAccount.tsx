import { useEffect, useState } from 'react';
import { useCloud } from './CloudContext';
import { configureCloud, loginCloud, logoutCloud } from './cloudApi';
export function CloudAccount() {
  const {status,error:connectionError,reload}=useCloud();
  const [url,setUrl]=useState(status?.registryId??'');
  const [error,setError]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  useEffect(()=>{setUrl(status?.registryId??'');},[status?.registryId]);
  async function act(action:()=>Promise<void>) {setBusy(true);setError(null);try{await action();await reload();}catch(reason:unknown){setError(reason instanceof Error?reason.message:'Cloud action failed');}finally{setBusy(false);}}
  return <details className="cloud-account"><summary>Feel8 Cloud · {status?.user?.name??(status?.configured?'Not signed in':'Not configured')}</summary>
    <label className="field-stack">Cloud URL<input className="plain-input" aria-label="Cloud URL" placeholder="https://assetcloud.feel8.fun" value={url} onChange={(e)=>setUrl(e.target.value)}/></label>
    <button className="command-button" disabled={busy} onClick={()=>void act(async()=>{await configureCloud(url);})}>Save connection</button>
    {status?.configured && (status.user?<button className="command-button" disabled={busy} onClick={()=>void act(async()=>{await logoutCloud();})}>Sign out</button>:
      <button className="command-button" disabled={busy} onClick={()=>void act(async()=>{const login=await loginCloud();window.location.assign(login.authorizationUrl);})}>Sign in to Cloud</button>)}
    {(error??connectionError)&&<p role="alert">{error??connectionError}</p>}
  </details>;
}
