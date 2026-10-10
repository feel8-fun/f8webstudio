import { useEffect, useRef, useState } from 'react';
import { useCloud } from './CloudContext';
import { configureCloud, loginCloud, logoutCloud } from './cloudApi';
export function CloudAccount() {
  const {status,error:connectionError,reload}=useCloud();
  const [url,setUrl]=useState(status?.registryId??'');
  const [error,setError]=useState<string|null>(null);
  const [message,setMessage]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const editingUrl=useRef(false);
  useEffect(()=>{if(!editingUrl.current)setUrl(status?.registryId??'');},[status?.registryId]);
  async function act(action:()=>Promise<void>) {
    setBusy(true);setError(null);setMessage(null);
    try{await action();await reload();}
    catch(reason:unknown){console.error('Cloud account action failed',reason);setError(reason instanceof Error?reason.message:'Cloud action failed');}
    finally{setBusy(false);}
  }
  return <section className="cloud-account" aria-label="Cloud connection and account">
    <p>{status?.configured?'Connect your account to publish and manage your Cloud works.':'Connect Cloud to browse shared works and publish your local drafts.'}</p>
    {status?.configured&&<p className="cloud-connection-address">Connected to {status.registryId}</p>}
    <form onSubmit={(event)=>{event.preventDefault();void act(async()=>{const connection=await configureCloud(url);editingUrl.current=false;setUrl(connection.registryId);setMessage('Cloud connection saved.');});}}>
      <label className="field-stack">Cloud URL<input className="plain-input" type="url" required disabled={busy} aria-label="Cloud URL" placeholder="https://assetcloud.feel8.fun" value={url} onChange={(e)=>{editingUrl.current=true;setUrl(e.target.value);setError(null);setMessage(null);}}/></label>
      <button className="command-button" disabled={busy||!status||!url.trim()} type="submit">{busy?'Working…':'Save connection'}</button>
    </form>
    {status?.user&&<p>Signed in as <strong>{status.user.name}</strong></p>}
    {status?.configured && (status.user?<button className="command-button" disabled={busy} onClick={()=>void act(async()=>{await logoutCloud();})}>Sign out</button>:
      <button className="command-button" disabled={busy} onClick={()=>void act(async()=>{const login=await loginCloud();window.location.assign(login.authorizationUrl);})}>Sign in to Cloud</button>)}
    {status?.configured&&<button className="command-button" disabled={busy} onClick={()=>void act(async()=>{await configureCloud('');editingUrl.current=false;setUrl('');setMessage('Cloud disconnected. Your local drafts remain available.');})}>Disconnect Cloud</button>}
    {!status&&!connectionError&&<p role="status">Loading Cloud settings…</p>}
    {connectionError&&<button className="command-button" disabled={busy} onClick={()=>void reload()}>Retry Cloud settings</button>}
    {(error??connectionError)&&<p role="alert">{error??connectionError}</p>}
    {message&&<p role="status">{message}</p>}
  </section>;
}
