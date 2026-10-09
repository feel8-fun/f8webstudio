import { useEffect, useRef, useState } from 'react';
import type { AssetRecord, ProjectRecord } from '../api/contracts';
import type { CloudDraftLink } from '../api/contracts.gen';
import { ApiError } from '../api/client';
import { cloudDraftLink, cloudProjectLink, cloudPublish, cloudPublishGraph, cloudMetadata, cloudProjectMetadata } from './cloudApi';
import { useCloud } from './CloudContext';
import { clearPublicationAttempt, publicationAttemptKey, readPublicationAttempt, savePublicationAttempt,
  type PublicationAttempt } from './publicationAttempt';

export function PublishPanel({asset,project}:{readonly asset?:AssetRecord;readonly project?:ProjectRecord}) {
  const {status}=useCloud();
  const [license,setLicense]=useState('MIT');
  const [visibility,setVisibility]=useState<'public'|'private'>('public');
  const [note,setNote]=useState('');
  const [link,setLink]=useState<CloudDraftLink|null>(null);
  const [message,setMessage]=useState<string|null>(null);
  const [busy,setBusy]=useState(false);
  const [pending,setPending]=useState<PublicationAttempt|null>(null);
  const [recoveryError,setRecoveryError]=useState(false);
  const localId=asset?.assetId??(project?'project:'+project.projectId:'');
  const storageKey=status?.user?publicationAttemptKey(status.registryId,status.user.id,localId):null;
  const activeKey=useRef(storageKey);
  activeKey.current=storageKey;
  useEffect(()=>{setMessage(null);setLink(null);setPending(null);setRecoveryError(false);setBusy(false);
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
    const controller=new AbortController();if(status?.user) {
      const load=asset?cloudDraftLink(asset.assetId,controller.signal):cloudProjectLink(project!.projectId,controller.signal);
      void load.then((value)=>{if(!controller.signal.aborted)setLink(value);},(reason:unknown)=>{if(!controller.signal.aborted)setMessage(reason instanceof Error?reason.message:'Cannot load publication source');});
    }
    return()=>controller.abort();},[storageKey]);
  async function publish() {
    if(!storageKey)return;
    setBusy(true);setMessage(null);
    try {
      const options={requestId:crypto.randomUUID(),license,visibility,changeSummary:note};
      const attempt=pending??(asset?
        {kind:'asset' as const,request:{...options,localVersion:asset.currentVersion}}:
        {kind:'graph' as const,request:{...options,expectedGraphRevision:project!.document.graphRevision,expectedLayoutRevision:project!.document.layoutRevision}});
      savePublicationAttempt(storageKey,attempt);
      setPending(attempt);
      const result=attempt.kind==='asset'?await cloudPublish(asset!.assetId,attempt.request):
        await cloudPublishGraph(project!.projectId,attempt.request);
      clearPublicationAttempt(storageKey);
      if(activeKey.current!==storageKey)return;
      setPending(null);
      setMessage(result.changed?`Published v${result.version}`:`Content unchanged · v${result.version}`);
      setLink(asset?await cloudDraftLink(asset.assetId):await cloudProjectLink(project!.projectId));
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
  if(!status?.configured)return null;
  return <details className="cloud-publish"><summary>Publish {asset?'template':'graph'} to Cloud {link?`· ${link.owned?'Published':'Based on'} v${link.reference.version}`:''}</summary>
    {!status.user?<p>Sign in to Cloud to publish.</p>:<>
      <label className="field-stack">License<input className="plain-input" aria-label="Publication license" disabled={busy||pending!==null} value={license} onChange={(e)=>setLicense(e.target.value)}/></label>
      <label className="field-stack">Visibility<select className="plain-input" aria-label="Publication visibility" disabled={busy||pending!==null} value={visibility} onChange={(e)=>setVisibility(e.target.value as typeof visibility)}><option value="public">Public</option><option value="private">Private</option></select></label>
      <label className="field-stack">Version notes<textarea className="plain-input" aria-label="Version notes" disabled={busy||pending!==null} value={note} onChange={(e)=>setNote(e.target.value)}/></label>
      <p>Publish the saved version. Editing and running do not upload changes.</p>
      {pending&&<p>An earlier publication is awaiting confirmation. Retry to finish that saved version.</p>}
      <button className="command-button primary" disabled={busy||recoveryError||!license.trim()} onClick={()=>void publish()}>{busy?'Publishing…':pending?'Retry publication':link?.owned?'Publish update':'Publish'}</button>
      {link?.owned&&<button className="command-button" disabled={busy||pending!==null} onClick={()=>{setBusy(true);setMessage(null);
        const metadata=asset?cloudMetadata(asset.assetId,{name:asset.name,description:asset.description,tags:asset.tags,visibility}):
          cloudProjectMetadata(project!.projectId,{name:project!.name,description:project!.description,tags:[],visibility});
        void metadata
        .then(()=>setMessage('Listing updated; content version unchanged'),(reason:unknown)=>setMessage(reason instanceof Error?reason.message:'Listing update failed')).finally(()=>setBusy(false));}}>Update listing</button>}
    </>}
    {message&&<p role="status">{message}</p>}
  </details>;
}
