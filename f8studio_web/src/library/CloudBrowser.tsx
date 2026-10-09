import { useCallback, useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { CloudAsset, CloudGraphPreview, CloudRelations, CloudReference, ComponentPreview } from '../api/contracts.gen';
import type { ProjectRecord } from '../api/contracts';
import { GraphView } from '../graph/GraphView';
import { cloudSearch,cloudRelations,cloudRelate,cloudDraft,cloudPreview,cloudGraphPreview,cloudOpenGraph } from './cloudApi';
import { useCloud } from './CloudContext';
import { cloudTemplate } from './cloudProvider';
import { TemplateInsertion } from './TemplateInsertion';

export function CloudBrowser({project,onDraft,onInserted}:{readonly project:ProjectRecord|null;readonly onDraft:(assetId:string)=>Promise<void>;readonly onInserted:()=>Promise<void>}) {
  const {status,provider}=useCloud();
  const [query,setQuery]=useState(''); const [view,setView]=useState('all');
  const [items,setItems]=useState<readonly CloudAsset[]>([]);const [cursor,setCursor]=useState<string|null>(null);
  const [selected,setSelected]=useState<CloudAsset|null>(null);const [relations,setRelations]=useState<CloudRelations|null>(null);
  const [graph,setGraph]=useState<CloudGraphPreview|null>(null);const [busy,setBusy]=useState(false);const [loading,setLoading]=useState(false);
  const [component,setComponent]=useState<ComponentPreview|null>(null);
  const [error,setError]=useState<string|null>(null);
  const reference:CloudReference|null=selected&&status?{registryId:status.registryId,assetId:selected.assetId,version:selected.version,contentHash:selected.contentHash}:null;
  useEffect(()=>{const controller=new AbortController();setItems([]);setCursor(null);setSelected(null);setError(null);
    if(!status?.configured)return;setLoading(true);
    const timeout=setTimeout(()=>{void cloudSearch(query,null,controller.signal,view).then((page)=>{if(!controller.signal.aborted){setItems(page.items);setCursor(page.nextCursor);setLoading(false);}},(reason:unknown)=>{if(!controller.signal.aborted){setError(reason instanceof Error?reason.message:'Online search failed');setLoading(false);}});},250);
    return()=>{clearTimeout(timeout);controller.abort();};},[query,view,status?.configured,status?.registryId,status?.user?.id]);
  useEffect(()=>{setRelations(null);setGraph(null);setComponent(null);const controller=new AbortController();if(!selected||!reference)return;
    void cloudRelations(selected.assetId,controller.signal).then((value)=>{if(!controller.signal.aborted)setRelations(value);},(reason:unknown)=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'Cannot load community actions');});
    if(selected.kind==='graph')void cloudGraphPreview(reference,controller.signal).then((value)=>{if(!controller.signal.aborted)setGraph(value);},(reason:unknown)=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'Cannot preview graph');});
    else if(!project)void cloudPreview(reference,controller.signal).then((value)=>{if(!controller.signal.aborted)setComponent(value);},(reason:unknown)=>{if(!controller.signal.aborted)setError(reason instanceof Error?reason.message:'Cannot preview component');});
    return()=>controller.abort();},[selected,status?.registryId,status?.user?.id,project?.projectId]);
  async function act(action:()=>Promise<void>){setBusy(true);setError(null);try{await action();}catch(reason:unknown){console.error('Cloud Library action failed',reason);setError(reason instanceof Error?reason.message:'Cloud action failed');}finally{setBusy(false);}}
  const onBusy=useCallback((value:boolean)=>setBusy(value),[]);
  if(!status?.configured)return null;
  return <section className="cloud-browser" aria-label="Online Library"><h3>Online Library</h3>
    <div className="asset-actions"><input className="plain-input" aria-label="Search online Library" placeholder="Search names, tags, authors…" value={query} disabled={busy} onChange={(e)=>setQuery(e.target.value)}/>
      <select className="plain-input" aria-label="Online Library view" value={view} disabled={busy} onChange={(e)=>setView(e.target.value)}><option value="all">All</option>{status.user&&<><option value="mine">My publications</option><option value="following">Following</option></>}</select></div>
    {loading&&<p role="status">Searching Cloud…</p>}{error&&<p role="alert">{error}</p>}
    <div className="cloud-browser-columns"><div className="asset-list">{items.map((asset)=><button key={asset.assetId} disabled={busy} className={selected?.assetId===asset.assetId?'selected':''} onClick={()=>setSelected(asset)}><span><strong>{asset.name}</strong><small>{asset.kind} · {asset.author.name} · v{asset.version}</small></span></button>)}
      {!loading&&items.length===0&&<p>No online results</p>}{cursor&&<button disabled={busy||loading} onClick={()=>void act(async()=>{const page=await cloudSearch(query,cursor,new AbortController().signal,view);setItems((previous)=>[...previous,...page.items.filter((item)=>!previous.some((p)=>p.assetId===item.assetId))]);setCursor(page.nextCursor);})}>More results</button>}</div>
      {selected&&reference&&<div className="cloud-details"><h3>{selected.name}</h3><p>{selected.author.name} · v{selected.version} · {selected.license}</p><p>{selected.tags.join(' · ')}</p>
        {relations&&<div className="asset-actions">
          <button className="command-button" disabled={busy||!status.user} onClick={()=>void act(async()=>{setRelations(await cloudRelate(selected.assetId,'like',!relations.liked));})}>{relations.liked?'Unlike':'Like'} · {relations.likes}</button>
          <button className="command-button" disabled={busy||!status.user} onClick={()=>void act(async()=>{setRelations(await cloudRelate(selected.assetId,'follow',!relations.following));})}>{relations.following?'Unfollow asset':'Follow updates'}</button>
          <button className="command-button" disabled={busy||!status.user} onClick={()=>void act(async()=>{setRelations(await cloudRelate(selected.assetId,'follow-author',!relations.followingAuthor));})}>{relations.followingAuthor?'Unfollow author':'Follow author'}</button>
        </div>}
        {relations?.hasUpdate&&<p role="status">New release available · v{relations.latestVersion}. Existing project nodes keep their selected version.</p>}
        {selected.kind==='graph'?<><ReactMarkdown remarkPlugins={[remarkGfm]}>{selected.description}</ReactMarkdown>{graph&&<><GraphView document={graph.document}/>{graph.issues.map((issue,i)=><p role="alert" key={i}>{issue.message}</p>)}</>}
          <button className="command-button" disabled={busy||!graph||graph.issues.length>0} onClick={()=>void act(async()=>{const record=await cloudOpenGraph(reference,selected.name);localStorage.setItem('f8studio.selectedProjectId',record.projectId);window.location.assign('/?view=graph');})}>Open as project</button></>:
          <><button className="command-button" disabled={busy} onClick={()=>void act(async()=>{const draft=await cloudDraft(reference);await onDraft(draft.assetId);})}>Create local draft</button>
          {project&&provider?<TemplateInsertion key={`${selected.assetId}:${selected.version}:${status.registryId}:${status.user?.id??''}`} document={project.document} template={cloudTemplate(selected,status.registryId)} provider={provider} configure onBusy={onBusy} onBack={()=>setSelected(null)} onInserted={async()=>{await onInserted();setSelected(null);}}/>:<><ReactMarkdown remarkPlugins={[remarkGfm]}>{selected.description}</ReactMarkdown>{component&&<><GraphView document={component.document}/>{component.issues.map((issue,i)=><p role="alert" key={i}>{issue.message}</p>)}</>}<p>Choose a local project to insert this template.</p></>}</>}
      </div>}
    </div>
  </section>;
}
