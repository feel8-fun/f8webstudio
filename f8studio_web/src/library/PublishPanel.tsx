import { useCallback, useEffect, useRef, useState } from 'react';
import { CloudUpload } from 'lucide-react';
import { Modal } from '../app/Modal';
import { useSettings } from '../app/SettingsContext';
import type { AssetRecord, ProjectRecord } from '../api/contracts';
import type { CloudDraftLink, ExcludedState } from '../api/contracts.gen';
import { ShareStateDialog } from '../graph/ShareStateDialog';
import { ApiError } from '../api/client';
import { cloudDraftLink, cloudProjectLink, cloudPublish, cloudPublishGraph } from './cloudApi';
import { useCloud } from './CloudContext';
import { clearPublicationAttempt, publicationAttemptKey, readPublicationAttempt, savePublicationAttempt,
  type PublicationAttempt } from './publicationAttempt';

export function PublishPanel({asset,project,saved=true,onManage}:{readonly asset?:AssetRecord;readonly project?:ProjectRecord;readonly saved?:boolean;readonly onManage?:()=>void}) {
  const {status,refreshLibrary,libraryRevision}=useCloud();
  const openSettings=useSettings();
  const [open,setOpen]=useState(false);
  const close=useCallback(()=>setOpen(false),[]);
  const kind=asset?.kind==='variant'?'Variant':asset?'Component':'Project';
  const [license,setLicense]=useState('MIT');
  const [visibility,setVisibility]=useState<'public'|'private'>('public');
  const [note,setNote]=useState('');
  const [link,setLink]=useState<CloudDraftLink|null>(null);
  const [message,setMessage]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [pending,setPending]=useState<PublicationAttempt|null>(null);
  const [recoveryError,setRecoveryError]=useState(false);
  const [sharing,setSharing]=useState(false);
  const localId=asset?.assetId??(project?'project:'+project.projectId:'');
  const storageKey=status?.user?publicationAttemptKey(status.registryId,status.user.id,localId):null;
  const activeKey=useRef(storageKey);
  activeKey.current=storageKey;
  useEffect(()=>{setMessage(null);setLink(null);setPending(null);setRecoveryError(false);setBusy(false);setSharing(false);
    if(storageKey) {
      try {
        const attempt=readPublicationAttempt(storageKey);
        if(attempt&&attempt.kind!==(asset?'asset':'graph'))throw new Error('Saved publication retry does not match this draft');
        setPending(attempt);
        setLicense(attempt?.request.license??'MIT');
        setVisibility(attempt?.request.visibility??'public');
        setNote(attempt?.request.changeSummary??'');
      } catch(reason:unknown) {
        console.error('Cannot restore Cloud publication retry',reason);
        setRecoveryError(true);
        setMessage(reason instanceof Error?reason.message:'Cannot restore publication retry');
      }
    }
  },[storageKey]);
  useEffect(()=>{
    const controller=new AbortController();if(status?.user) {
      const load=asset?cloudDraftLink(asset.assetId,controller.signal):cloudProjectLink(project!.projectId,controller.signal);
      void load.then((value)=>{if(!controller.signal.aborted)setLink(value);},(reason:unknown)=>{if(!controller.signal.aborted)setMessage(reason instanceof Error?reason.message:'Cannot load publication source');});
    }
    return()=>controller.abort();},[storageKey,libraryRevision]);
  async function publish(excludedStates:readonly ExcludedState[]=[]) {
    if(!storageKey)return;
    setBusy(true);setMessage(null);
    try {
      const options={requestId:crypto.randomUUID(),license,visibility,changeSummary:note};
      const attempt=pending??(asset?
        {kind:'asset' as const,request:{...options,localVersion:asset.currentVersion}}:
        {kind:'graph' as const,request:{...options,expectedGraphRevision:project!.document.graphRevision,expectedLayoutRevision:project!.document.layoutRevision,excludedStates}});
      savePublicationAttempt(storageKey,attempt);
      setPending(attempt);
      const result=attempt.kind==='asset'?await cloudPublish(asset!.assetId,attempt.request):
        await cloudPublishGraph(project!.projectId,attempt.request);
      clearPublicationAttempt(storageKey);
      if(activeKey.current!==storageKey)return;
      setPending(null);
      setMessage(result.changed?`Published v${result.version}`:`Content unchanged · v${result.version}`);
      const nextLink=asset?await cloudDraftLink(asset.assetId):await cloudProjectLink(project!.projectId);
      if(activeKey.current===storageKey){setLink(nextLink);refreshLibrary();}
    } catch(reason:unknown){
      console.error('Cloud publication failed',reason);
      // A valid 4xx rejection confirms no publication was accepted. Connection,
      // malformed-response and server failures retain the exact request.
      if(reason instanceof ApiError&&reason.status>=400&&reason.status<500&&reason.status!==408&&reason.code!=='invalid_response') {
        clearPublicationAttempt(storageKey);
        if(activeKey.current===storageKey)setPending(null);
      }
      if(activeKey.current===storageKey)setMessage(reason instanceof Error?reason.message:'Publication failed');
    }finally{if(activeKey.current===storageKey)setBusy(false);}
  }
  const title=`Publish ${kind} to Cloud`;
  const source=link?.owned?`Your Cloud publication · v${link.reference.version}`:
    link?`Based on another author’s work · v${link.reference.version}`:'Not published to this account';
  return <section className="cloud-publish" aria-label="Publish to Cloud">
    <div><strong>{status?.configured?source:'Share on Cloud'}</strong><p>{project?'Share the complete saved graph. Local snapshots stay on this device.':`Publish a saved ${kind.toLowerCase()} version when it is ready to share.`}</p></div>
    <button className="command-button" disabled={busy} onClick={()=>{
      if(!status?.configured||!status.user)openSettings('cloud');else setOpen(true);
    }}><CloudUpload size={15}/>{!status?.configured?'Connect Cloud':!status.user?'Sign in to Cloud':pending?'Resume publication':link?.owned?`Publish ${kind} update`:title}</button>
    {open&&!sharing&&<Modal title={title} onClose={close} className="publication-dialog">
      <p><strong>{asset?.name??project?.name}</strong> · {asset?`Local v${asset.currentVersion}`:'Complete project graph'}</p>
      <p>{link?.owned?`Your Cloud publication · v${link.reference.version}. Publishing creates a new Cloud version.`:
        link?'Publishing this independent draft creates your own Cloud work and preserves its source.':'Publishing creates a new Cloud work for your account.'}</p>
      <label className="field-stack">License<input className="plain-input" aria-label="Publication license" disabled={busy||pending!==null} value={license} onChange={(e)=>setLicense(e.target.value)}/></label>
      <label className="field-stack">Visibility<select className="plain-input" aria-label="Publication visibility" disabled={busy||pending!==null} value={visibility} onChange={(e)=>setVisibility(e.target.value as typeof visibility)}><option value="public">Public</option><option value="private">Private</option></select></label>
      <label className="field-stack">Version notes<textarea className="plain-input" aria-label="Version notes" disabled={busy||pending!==null} value={note} onChange={(e)=>setNote(e.target.value)}/></label>
      <p>Editing and running do not upload changes.</p>
      {!saved&&!pending&&<p>Save your local changes before publishing.</p>}
      {pending&&<p>An earlier publication is awaiting confirmation. Retry to finish that saved version.</p>}
      {message&&<p role="status">{message}</p>}
      <div className="dialog-actions"><button className="command-button" onClick={close}>Close</button>
        <button className="command-button primary" disabled={busy||recoveryError||(!saved&&!pending)||!license.trim()} onClick={()=>{if(project&&!pending)setSharing(true);else void publish();}}>{busy?'Publishing…':pending?'Retry publication':link?.owned?'Publish update':'Publish'}</button>
      </div>
    </Modal>}
    {sharing&&project&&<ShareStateDialog title="Publish graph to Cloud" document={project.document} onClose={()=>setSharing(false)} onShare={publish}/>}
    {link?.owned&&onManage&&<button className="command-button" disabled={busy||pending!==null} onClick={onManage}>Manage Cloud listing</button>}
    {!open&&message&&<p role="status">{message}</p>}
  </section>;
}
