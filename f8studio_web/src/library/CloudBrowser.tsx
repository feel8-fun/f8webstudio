import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Box, Boxes, MoreHorizontal, RefreshCw, Trash2, Workflow } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { CloudAsset, CloudDraftLink, CloudGraphPreview, CloudRelations, CloudReference, CloudVersion, ComponentPreview } from '../api/contracts.gen';
import type { ProjectRecord } from '../api/contracts';
import { GraphView } from '../graph/GraphView';
import { cloudSearch, cloudRelations, cloudRelate, cloudDraft, cloudPreview, cloudGraphPreview, cloudOpenGraph, cloudVersions, cloudDeletePublication, type CloudKindFilter } from './cloudApi';
import { useCloud } from './CloudContext';
import { cloudTemplate } from './cloudProvider';
import { TemplateInsertion } from './TemplateInsertion';
import { CloudListingEditor } from './CloudListingEditor';
import { useSettings } from '../app/SettingsContext';
import { Modal } from '../app/Modal';
import { LibraryKindFilters } from './LibraryKindFilters';

type CloudView = 'all' | 'mine' | 'following';
const kindLabels: Record<CloudAsset['kind'], string> = {graph:'Project graph',component:'Component',variant:'Variant'};
const kindIcons = {graph:Workflow,component:Boxes,variant:Box};
const titles: Record<CloudView, string> = { all: 'Discover', mine: 'My Cloud', following: 'Following' };
const introductions: Record<CloudView, string> = {
  all: 'Browse shared Cloud works. Add a fixed version to your project or create your own local draft.',
  mine: 'Works published by your signed-in account. Manage the listing here; publish content updates from a local draft.',
  following: 'Works and authors you follow. Existing project nodes keep the version you added.',
};

export function CloudBrowser({ view, project, draftLinks = [], navigation, targetProject, onDraft, onInserted }: {
  readonly view: CloudView;
  readonly project: ProjectRecord | null;
  readonly draftLinks?: readonly CloudDraftLink[];
  readonly navigation?: ReactNode;
  readonly targetProject?: ReactNode;
  readonly onDraft: (assetId: string) => Promise<void>;
  readonly onInserted: () => Promise<void>;
}) {
  const { status, provider, libraryRevision, refreshLibrary } = useCloud();
  const openSettings = useSettings();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<CloudKindFilter>('all');
  const [items, setItems] = useState<readonly CloudAsset[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<CloudAsset | null>(null);
  const [relations, setRelations] = useState<CloudRelations | null>(null);
  const [graph, setGraph] = useState<CloudGraphPreview | null>(null);
  const [component, setComponent] = useState<ComponentPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [searchRevision, setSearchRevision] = useState(0);
  const [detailsRevision, setDetailsRevision] = useState(0);
  const [versions, setVersions] = useState<readonly CloudVersion[]>([]);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [fixedVersion, setFixedVersion] = useState<CloudVersion | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [moreActions, setMoreActions] = useState(false);
  const [deleting, setDeleting] = useState<CloudAsset | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const closeDelete = useCallback(() => { if (!busy) setDeleting(null); }, [busy]);
  const reference: CloudReference | null = selected && status ? {
    registryId: status.registryId, assetId: selected.assetId, version: fixedVersion?.version ?? selected.version,
    contentHash: fixedVersion?.contentHash ?? selected.contentHash,
  } : null;
  const scope = JSON.stringify([status?.registryId, status?.user?.id, view, query, kind, selected?.assetId, reference?.version]);
  const activeScope = useRef<string | null>(scope);
  activeScope.current = scope;
  useEffect(() => () => { activeScope.current = null; }, []);
  useEffect(() => { setBusy(false); }, [status?.registryId, status?.user?.id]);
  useEffect(() => { setMoreActions(false); setDeleting(null); setDeleteError(null); }, [selected?.assetId, status?.registryId, status?.user?.id]);
  const owned = selected !== null && status?.user?.id === selected.author.id;
  const existingDraft = owned && selected ? draftLinks.find((link) => link.owned && link.reference.assetId === selected.assetId) : undefined;
  const versionLicense=versions.find((version)=>version.version===reference?.version)?.license||selected?.license;
  const template = useMemo(() => selected && selected.kind !== 'graph' && reference ?
    cloudTemplate({ ...selected, version: reference.version, contentHash: reference.contentHash,license:versionLicense??selected.license }, reference.registryId) : null,
    [selected, reference?.registryId, reference?.version, reference?.contentHash,versionLicense]);

  useEffect(() => {
    const controller = new AbortController();
    setItems([]); setCursor(null); setSelected(null); setFixedVersion(null); setError(null); setSearchError(null); setLoading(false);
    if (!status?.configured || (view !== 'all' && !status.user)) return;
    setLoading(true);
    const timeout = setTimeout(() => {
      void cloudSearch(query, null, controller.signal, view, kind).then((page) => {
        if (!controller.signal.aborted) { setItems(page.items); setCursor(page.nextCursor); setLoading(false); }
      }, (reason: unknown) => {
        if (!controller.signal.aborted) { console.error('Cloud Library search failed', reason); setSearchError(reason instanceof Error ? reason.message : 'Online search failed'); setLoading(false); }
      });
    }, 250);
    return () => { clearTimeout(timeout); controller.abort(); };
  }, [query, view, kind, status?.configured, status?.registryId, status?.user?.id, libraryRevision, searchRevision]);

  useEffect(() => {
    setVersions([]); setVersionError(null);
    if (!selected) return;
    const controller = new AbortController();
    void cloudVersions(selected.assetId, controller.signal).then((value) => {
      if (!controller.signal.aborted) setVersions(value);
    }, (reason: unknown) => {
      if (!controller.signal.aborted) { console.error('Cloud version history failed', reason); setVersionError(reason instanceof Error ? reason.message : 'Cannot load Cloud versions'); }
    });
    return () => controller.abort();
  }, [selected?.assetId, status?.registryId, status?.user?.id, detailsRevision]);

  useEffect(() => {
    setRelations(null); setGraph(null); setComponent(null); setError(null); setPreviewLoading(false);
    const controller = new AbortController();
    if (!selected || !reference) return;
    function failed(reason: unknown) {
      if (!controller.signal.aborted) { console.error('Cloud details failed', reason); setError(reason instanceof Error ? reason.message : 'Cannot load Cloud details'); }
    }
    void cloudRelations(selected.assetId, controller.signal).then((value) => {
      if (!controller.signal.aborted) setRelations(value);
    }, failed);
    if (selected.kind === 'graph') {
      setPreviewLoading(true);
      void cloudGraphPreview(reference, controller.signal).then((value) => {
        if (!controller.signal.aborted) { setGraph(value); setPreviewLoading(false); }
      }, (reason: unknown) => { if (!controller.signal.aborted) setPreviewLoading(false); failed(reason); });
    } else if (!project) {
      setPreviewLoading(true);
      void cloudPreview(reference, controller.signal).then((value) => {
        if (!controller.signal.aborted) { setComponent(value); setPreviewLoading(false); }
      }, (reason: unknown) => { if (!controller.signal.aborted) setPreviewLoading(false); failed(reason); });
    }
    return () => controller.abort();
  }, [selected?.assetId, selected?.kind, reference?.version, reference?.contentHash, status?.registryId, status?.user?.id, project?.projectId, detailsRevision]);

  async function act<T>(action: () => Promise<T>, apply: (value: T) => void | Promise<void>, errorTarget:'search'|'details'='details') {
    setBusy(true); if(errorTarget==='search')setSearchError(null);else setError(null);
    const operationScope = scope;
    try { const value = await action(); if (activeScope.current === operationScope) await apply(value); }
    catch (reason: unknown) {
      console.error('Cloud Library action failed', reason);
      if (activeScope.current === operationScope) {
        const message=reason instanceof Error ? reason.message : 'Cloud action failed';
        if(errorTarget==='search')setSearchError(message);else setError(message);
      }
    } finally { if (activeScope.current === operationScope) setBusy(false); }
  }
  const onBusy = useCallback((value: boolean) => { if (activeScope.current === scope) setBusy(value); }, [scope]);
  const listingSaved = useCallback((updated: CloudAsset) => {
    if (activeScope.current !== scope) return;
    setSelected(updated);
    setItems((previous) => previous.map((asset) => asset.assetId === updated.assetId ? updated : asset));
  }, [scope]);

  async function removePublication() {
    if (!deleting || busy || !owned || deleting.assetId !== selected?.assetId) return;
    const operationScope = scope;
    setBusy(true); setDeleteError(null);
    try {
      await cloudDeletePublication(deleting.assetId);
      if (activeScope.current !== operationScope) return;
      setDeleting(null); setSelected(null);
      setNotice('Cloud publication deleted. Local drafts and projects are preserved.');
      setBusy(false);
      refreshLibrary();
    } catch (reason: unknown) {
      console.error('Cloud publication deletion failed', reason);
      if (activeScope.current === operationScope) setDeleteError(reason instanceof Error ? reason.message : 'Cannot delete Cloud publication');
    } finally { if (activeScope.current === operationScope) setBusy(false); }
  }

  const canBrowse = status?.configured && (view === 'all' || status.user);
  return <>
    <aside className="asset-browser" aria-label="Cloud library sidebar">
      {navigation}
      {canBrowse && <>
        <div className="cloud-sidebar-search"><input className="plain-input" aria-label="Search online Library" placeholder="Search names, tags, authors…" value={query} disabled={busy} onChange={(event) => setQuery(event.target.value)}/>
          <button className="icon-button bordered" aria-label="Refresh Cloud" title="Refresh Cloud" disabled={busy || loading} onClick={() => setSearchRevision((value) => value + 1)}><RefreshCw size={16}/></button></div>
        <LibraryKindFilters value={kind} onChange={setKind} label="Cloud asset type" disabled={busy}/>
        {loading && <p role="status">Searching Cloud…</p>}
        {searchError && <div><p role="alert">{searchError}</p><button className="command-button" disabled={busy} onClick={() => setSearchRevision((value) => value + 1)}>Retry search</button></div>}
        <div className="asset-list" aria-label="Cloud results">
          {items.map((asset) => {
            const Icon = kindIcons[asset.kind];
            return <button key={asset.assetId} disabled={busy} className={selected?.assetId === asset.assetId ? 'selected' : ''} onClick={() => { setNotice(null); setError(null); setFixedVersion(null); setSelected(asset); }}>
              <Icon size={15}/><span><strong>{asset.name}</strong><small>{kindLabels[asset.kind]} · Cloud v{asset.version}</small><small>{asset.author.id === status.user?.id ? 'Your publication' : `By ${asset.author.name}`} · {asset.visibility}</small></span>
            </button>;
          })}
        </div>
        {cursor && <button className="command-button cloud-more-results" disabled={busy || loading} onClick={() => void act(() => cloudSearch(query, cursor, new AbortController().signal, view, kind), (page) => {
            setItems((previous) => [...previous, ...page.items.filter((item) => !previous.some((asset) => asset.assetId === item.assetId))]); setCursor(page.nextCursor);
        }, 'search')}>More results</button>}
        {!loading && !searchError && items.length === 0 && <p className="library-empty-state">{query.trim() || kind !== 'all' ? 'No Cloud works match your search and type filter.' : view === 'mine' ? 'No Cloud publications yet. Publish a local draft or project to get started.' : 'No online results'}</p>}
      </>}
    </aside>
    <div className="asset-editor"><section className="cloud-browser" aria-label="Online Library">
    <header className="library-workspace-heading"><h2>{titles[view]}</h2><p>{introductions[view]}</p></header>
    {notice && <p className="asset-workspace-status" role="status">{notice}</p>}
    {!status?.configured ? <div className="library-empty-state"><h3>Connect Feel8 Cloud</h3>
      <p>Set your Cloud URL in Settings → Cloud to browse shared works.</p>
      <button className="command-button primary" onClick={() => openSettings('cloud')}>Set up Cloud connection</button>
    </div> : view !== 'all' && !status.user ? <div className="library-empty-state"><h3>Sign in to Cloud</h3><p>Sign in to access {view === 'mine' ? 'your published works' : 'your following list'}.</p><button className="command-button primary" onClick={() => openSettings('cloud')}>Sign in to Cloud</button></div> : <>
      {error && <div><p role="alert">{error}</p><button className="command-button" disabled={busy} onClick={()=>setDetailsRevision((value)=>value+1)}>Retry details</button></div>}
      {selected && reference ? <div className="cloud-details">
        <header className="asset-section-heading"><div className="asset-origin"><span className="source-badge">{owned ? 'Your Cloud publication' : 'Another author’s Cloud work'}</span><span className="source-badge">{kindLabels[selected.kind]}</span><span>{selected.visibility}</span></div>
          {owned && <div className="draft-more"><button className="icon-button bordered" aria-label="More publication actions" aria-expanded={moreActions} disabled={busy} onClick={() => setMoreActions((value) => !value)}><MoreHorizontal size={17}/></button>
            {moreActions && <div className="draft-more-menu" role="menu"><button role="menuitem" className="danger" onClick={() => { setDeleteError(null); setDeleting(selected); setMoreActions(false); }}><Trash2 size={14}/>Delete Cloud publication</button></div>}
          </div>}
        </header>
        <h3>{selected.name}</h3><p>{selected.author.name} · cloud v{reference.version} · {versionLicense}</p><p>{selected.tags.join(' · ')}</p>
        <div className="markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{selected.description}</ReactMarkdown></div>
        <label className="field-stack">Version to use<select className="plain-input" aria-label="Cloud content version" value={reference.version} disabled={busy} onChange={(event)=>{
          const version=versions.find((item)=>item.version===Number(event.target.value));
          if(version){setGraph(null);setComponent(null);setFixedVersion(version);}
        }}>
          {!versions.some((item)=>item.version===reference.version)&&<option value={reference.version}>v{reference.version}</option>}
          {versions.map((version)=><option value={version.version} key={version.version}>v{version.version}{version.version===selected.version?' · latest':''}</option>)}
        </select></label>
        {versions.find((version)=>version.version===reference.version)?.note&&<p>{versions.find((version)=>version.version===reference.version)?.note}</p>}
        {reference.version<selected.version&&<p>Using an earlier release. Adding or creating a draft uses v{reference.version}.</p>}
        {reference.version>selected.version&&<p>Using a newer release. Refresh Cloud to update the listing.</p>}
        {versionError&&<div><p role="alert">{versionError}</p><button className="command-button" disabled={busy} onClick={()=>setDetailsRevision((value)=>value+1)}>Retry versions</button></div>}
        {owned ? <CloudListingEditor key={selected.assetId} asset={selected} onSaved={listingSaved} onBusy={onBusy}/> :
          <p className="cloud-ownership-note">Published by {selected.author.name}. Create a local draft to make your own changes; their Cloud work stays under their control.</p>}
        {relations && <div className="asset-actions">
          <button className="command-button" disabled={busy || !status.user} onClick={() => void act(() => cloudRelate(selected.assetId, 'like', !relations.liked), setRelations)}>{relations.liked ? 'Unlike' : 'Like'} · {relations.likes}</button>
          <button className="command-button" disabled={busy || !status.user} onClick={() => void act(() => cloudRelate(selected.assetId, 'follow', !relations.following), setRelations)}>{relations.following ? 'Unfollow asset' : 'Follow updates'}</button>
          {!owned && <button className="command-button" disabled={busy || !status.user} onClick={() => void act(() => cloudRelate(selected.assetId, 'follow-author', !relations.followingAuthor), setRelations)}>{relations.followingAuthor ? 'Unfollow author' : 'Follow author'}</button>}
        </div>}
        {relations?.hasUpdate && <p role="status">New release available · v{relations.latestVersion}. Existing project nodes keep their selected version.</p>}
        {selected.kind === 'graph' ? <>
          {previewLoading&&<p role="status">Loading graph preview…</p>}
          {graph && <><GraphView document={graph.document}/>{graph.issues.map((issue, index) => <p role="alert" key={index}>{issue.message}</p>)}</>}
          <button className="command-button" disabled={busy || !graph || graph.issues.length > 0} onClick={() => void act(() => cloudOpenGraph(reference, selected.name), (record) => {
            localStorage.setItem('f8studio.selectedProjectId', record.projectId); window.location.assign('/?view=graph');
          })}>{owned ? 'Edit as local project' : 'Open as local project'}</button>
        </> : <>
          <button className="command-button" disabled={busy} onClick={() => {
            if(existingDraft)void act(()=>onDraft(existingDraft.localAssetId),()=>{});
            else void act(()=>cloudDraft(reference),(draft)=>onDraft(draft.assetId));
          }}>{existingDraft ? 'Edit local draft' : 'Create local draft'}</button>
          {existingDraft&&existingDraft.reference.version!==reference.version&&<p>Your existing local draft is based on cloud v{existingDraft.reference.version}. Opening it preserves your local edits.</p>}
          {targetProject}
          {project && provider && template ? <TemplateInsertion key={`${selected.assetId}:${reference.version}:${status.registryId}:${status.user?.id ?? ''}:${detailsRevision}`}
            document={project.document} template={template} provider={provider} configure embedded showVersions={false} onBusy={onBusy}
            onBack={() => setSelected(null)} onInserted={async () => { await onInserted(); setNotice('Added to project.'); }}/>
            : <>
              {component && <><GraphView document={component.document}/>{component.issues.map((issue, index) => <p role="alert" key={index}>{issue.message}</p>)}</>}
              {previewLoading&&<p role="status">Loading {selected.kind} preview…</p>}
              <p>Choose a local project to add this {selected.kind}.</p></>}
        </>}
      </div> : <div className="library-empty-state">Choose a Cloud work to view its details.</div>}
    </>}
    </section></div>
    {deleting && owned && <Modal title="Delete Cloud publication" onClose={closeDelete}>
      <p>Delete “{deleting.name}” from Cloud? This removes the listing, all published versions, likes and asset follows. Local drafts and projects stay on this device.</p>
      {deleteError && <p role="alert">{deleteError}</p>}
      <div className="dialog-actions"><button className="command-button" disabled={busy} onClick={closeDelete}>Cancel</button><button className="command-button danger" disabled={busy} onClick={() => void removePublication()}>{busy ? 'Deleting…' : 'Delete Cloud publication'}</button></div>
    </Modal>}
  </>;
}
