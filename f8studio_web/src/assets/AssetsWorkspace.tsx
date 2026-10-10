import { ShareStateDialog } from "../graph/ShareStateDialog";
import { ProjectSnapshots } from './ProjectSnapshots';
import { Modal } from '../app/Modal';
import { CloudBrowser } from '../library/CloudBrowser';
import { PublishPanel } from '../library/PublishPanel';
import { useCloud } from '../library/CloudContext';
import { cloudDraftLinks } from '../library/cloudApi';
import { LibraryKindFilters, type LibraryKindFilter } from '../library/LibraryKindFilters';
import type { ExcludedState } from "../api/contracts.gen";
import { Box, Boxes, Cloud, Compass, Download, Heart, HardDrive, MoreHorizontal, Save, Trash2, Workflow } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  captureProjectComponent,
  deleteAsset,
  fetchAsset,
  fetchAssets,
  fetchAssetVersions,
  fetchComponentPreview,
  insertProjectComponent,
  fetchProjects,
  fetchProject,
  patchProject,
  updateAsset,
} from '../api/client';
import type { AssetKind, AssetRecord, AssetSummary, AssetVersion, JsonValue, ProjectRecord, ProjectSummary } from '../api/contracts';
import type { CloudDraftLink, ComponentPreview } from '../api/contracts.gen';
import { GraphView } from '../graph/GraphView';

type LibraryView = 'local' | 'mine' | 'discover' | 'following';
type LocalSelection = { readonly kind: 'graph'; readonly projectId: string } | { readonly kind: 'draft'; readonly assetId: string };
type LocalWork = { readonly kind: 'graph'; readonly project: ProjectSummary } | { readonly kind: 'draft'; readonly asset: AssetSummary };
function legacyGraphRoute(): boolean {
  const view = new URLSearchParams(window.location.search).get('library');
  return view === 'projects' || view === 'history';
}
function initialLibraryView(): LibraryView {
  const view = new URLSearchParams(window.location.search).get('library');
  return view === 'mine' || view === 'discover' || view === 'following' ? view : 'local';
}
function kindLabel(kind: AssetKind): string {
  return kind === 'variant' ? 'Variant' : kind === 'component' ? 'Component' : kind === 'preset' ? 'Preset (legacy)' : 'Modding recipe';
}

function downloadJson(filename: string, value: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function AssetsWorkspace() {
  const { status: cloudStatus, libraryRevision } = useCloud();
  const [view, setView] = useState<LibraryView>(initialLibraryView);
  const [query, setQuery] = useState('');
  const [links, setLinks] = useState<readonly CloudDraftLink[] | null>(null);
  const [assets, setAssets] = useState<readonly AssetSummary[]>([]);
  const [selected, setSelected] = useState<AssetRecord | null>(null);
  const [localSelection, setLocalSelection] = useState<LocalSelection | null>(null);
  const [versions, setVersions] = useState<readonly AssetVersion[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [projects, setProjects] = useState<readonly ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState('');
  const [kindFilter, setKindFilter] = useState<LibraryKindFilter>(() => legacyGraphRoute() ? 'graph' : 'all');
  const [editingJson, setEditingJson] = useState(false);
  const [moreActions, setMoreActions] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const closeDelete = useCallback(() => { if (!deleteBusy) setDeleting(false); }, [deleteBusy]);
  const [loadedProject, setProjectRecord] = useState<ProjectRecord | null>(null);
  const projectRecord = loadedProject?.projectId === projectId ? loadedProject : null;
  const [targetNodeId, setTargetNodeId] = useState('');
  const [capturing, setCapturing] = useState(false);
  const closeCapture = useCallback(() => setCapturing(false), []);
  const [status, setStatus] = useState('');
  const [previewVersion, setPreviewVersion] = useState(1);
  const [preview, setPreview] = useState<ComponentPreview | null>(null);
  const [hostBindings, setHostBindings] = useState<Readonly<Record<string, string>>>({});
  const insertionRequestId = useRef<string | null>(null);
  const assetSelection = useRef(0);
  const selectLegacyGraph = useRef(legacyGraphRoute());

  const navigate = useCallback((next: LibraryView) => {
    setView(next);
    setStatus('');
    if (next === 'local' && localSelection?.kind === 'graph') setProjectId(localSelection.projectId);
    const url = new URL(window.location.href);
    url.searchParams.set('library', next);
    window.history.replaceState(null, '', url);
  }, [localSelection]);
  useEffect(() => {
    if (!legacyGraphRoute()) return;
    const url = new URL(window.location.href);
    url.searchParams.set('library', 'local');
    window.history.replaceState(null, '', url);
  }, []);
  useEffect(() => {
    setLinks(null);
    if (!cloudStatus?.configured) return;
    const controller = new AbortController();
    void cloudDraftLinks(controller.signal).then((value) => { if (!controller.signal.aborted) setLinks(value); },
      (error: unknown) => { if (!controller.signal.aborted) setStatus(error instanceof Error ? error.message : 'Cannot load draft sources'); });
    return () => controller.abort();
  }, [cloudStatus?.configured, cloudStatus?.registryId, cloudStatus?.user?.id, assets, libraryRevision]);

  useEffect(() => {
    setPreview(null);
    setHostBindings({});
    if (selected?.kind !== 'component' && selected?.kind !== 'variant') return;
    const controller = new AbortController();
    void fetchComponentPreview(selected.assetId, previewVersion, controller.signal).then((value)=>{if(!controller.signal.aborted)setPreview(value);},
      (error: unknown) => { if (!controller.signal.aborted) setStatus(error instanceof Error ? error.message : 'Preview failed'); });
    return () => controller.abort();
  }, [selected?.assetId, selected?.kind, selected?.currentVersion, previewVersion]);
  useEffect(() => { insertionRequestId.current = null; }, [selected?.assetId, previewVersion, projectId, hostBindings]);
  useEffect(() => {
    if (selected?.kind !== 'variant' || preview === null || projectRecord === null) return;
    setHostBindings((previous) => {
      const next: Record<string, string> = {};
      for (const binding of preview.component.hostBindings) {
        const hosts = projectRecord.document.nodes.filter((node) => node.kind === 'service' && node.serviceClass === binding.serviceClass);
        if (binding.serviceClass === 'f8.pystudio') next[binding.bindingId] = 'studio';
        else if (hosts.some((node) => node.serviceId === previous[binding.bindingId])) next[binding.bindingId] = previous[binding.bindingId]!;
        else if (hosts.length === 1) next[binding.bindingId] = hosts[0]!.serviceId;
      }
      return next;
    });
  }, [selected?.kind, preview, projectRecord]);

  const reload = useCallback(async () => {
    const [nextAssets, nextProjects] = await Promise.all([fetchAssets(), fetchProjects()]);
    setAssets(nextAssets);
    setProjects(nextProjects);
    setProjectId((current) => current || (nextProjects.find((project) => project.projectId === localStorage.getItem('f8studio.selectedProjectId')) ?? nextProjects[0])?.projectId || '');
    if (selectLegacyGraph.current && nextProjects.length > 0) {
      selectLegacyGraph.current = false;
      const project = nextProjects.find((item) => item.projectId === localStorage.getItem('f8studio.selectedProjectId')) ?? nextProjects[0]!;
      setLocalSelection({ kind: 'graph', projectId: project.projectId });
    }
  }, []);

  useEffect(() => { void reload().catch((error: unknown) => setStatus(error instanceof Error ? error.message : 'Load failed')); }, [reload]);

  useEffect(() => {
    let active=true;
    setProjectRecord(null);
    if (!projectId) return;
    void fetchProject(projectId).then((record) => {
      if(!active)return;
      setProjectRecord(record);
      setTargetNodeId((current) => record.document.nodes.some((node) => node.nodeId === current) ? current : record.document.nodes[0]?.nodeId ?? '');
    }, (error: unknown) => {if(active)setStatus(error instanceof Error ? error.message : 'Project load failed');});
    return()=>{active=false;};
  }, [projectId]);

  const selectAsset = useCallback(async (assetId: string, reveal = false) => {
    const selection=++assetSelection.current;
    setLocalSelection({ kind: 'draft', assetId });
    setSelected(null);
    setVersions([]);
    setStatus('');
    if (reveal) { setKindFilter('all'); setQuery(''); }
    try {
      const [record, history] = await Promise.all([fetchAsset(assetId), fetchAssetVersions(assetId)]);
      if(selection!==assetSelection.current)return;
      setSelected(record);
      setPreviewVersion(record.currentVersion);
      setVersions(history);
      setName(record.name);
      setDescription(record.description);
      setContent(JSON.stringify(record.content, null, 2));
      setStatus(''); setEditingJson(false); setMoreActions(false);
    } catch (error: unknown) {
      if(selection!==assetSelection.current)return;
      setStatus(error instanceof Error ? error.message : 'Asset load failed');
    }
  }, []);

  const selectProject = useCallback((nextProjectId: string) => {
    ++assetSelection.current;
    setLocalSelection({ kind: 'graph', projectId: nextProjectId });
    setSelected(null);
    setProjectId(nextProjectId);
    setStatus('');
  }, []);

  const save = useCallback(async () => {
    if (selected === null) return;
    try {
      const parsed = JSON.parse(content) as JsonValue;
      const updated = await updateAsset(selected.assetId, { name, description, tags: selected.tags, content: parsed, expectedVersion: selected.currentVersion });
      setSelected(updated);
      setContent(JSON.stringify(updated.content, null, 2));
      setPreviewVersion(updated.currentVersion);
      setVersions(await fetchAssetVersions(updated.assetId));
      await reload();
      setStatus(`Draft saved · v${updated.currentVersion}`);
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : 'Save failed');
    }
  }, [content, description, name, reload, selected]);

  const removeAsset = useCallback(async () => {
    if (selected === null || deleteBusy) return;
    setDeleteBusy(true); setDeleteError('');
    try {
      await deleteAsset(selected.assetId);
      setSelected(null);
      setLocalSelection(null);
      setVersions([]);
      await reload();
      setStatus('Local draft deleted'); setDeleting(false);
    } catch (error: unknown) {
      console.error('Local draft deletion failed', error);
      setDeleteError(error instanceof Error ? error.message : 'Asset deletion failed');
    } finally {
      setDeleteBusy(false);
    }
  }, [reload, selected, deleteBusy]);

  const captureProject = useCallback(async (excludedStates: readonly ExcludedState[]) => {
    if (projectRecord === null) return;
    const created = await captureProjectComponent(projectRecord.projectId, projectRecord.document,
      `${projects.find((project) => project.projectId === projectId)?.name ?? 'Project'} component`, excludedStates);
    await reload();
    await selectAsset(created.assetId, true);
    setView('local');
    setStatus('Project graph captured as component');
  }, [projectId, projectRecord, projects, reload, selectAsset]);

  const applyAsset = useCallback(async () => {
    if (selected === null || projectRecord === null) return;
    try {
      if (selected.kind === 'component' || selected.kind === 'variant') {
        if (preview === null || preview.issues.length > 0) throw new Error('Resolve component requirements before insertion');
        insertionRequestId.current ??= `component:${crypto.randomUUID()}`;
        const result = await insertProjectComponent(projectRecord.projectId, {
          requestId: insertionRequestId.current, expectedGraphRevision: projectRecord.document.graphRevision,
          expectedLayoutRevision: projectRecord.document.layoutRevision, assetId: selected.assetId,
          version: preview.version, hostBindings,
        });
        insertionRequestId.current = null;
        setProjectRecord({ ...projectRecord, document: result.patch.document });
        if (result.source.endpoints.length > 0) setStatus(`Inserted component; connect ${result.source.endpoints.length} exposed port(s) in Graph`);
      } else if (selected.kind === 'preset') {
        if (!targetNodeId) throw new Error('Select a target node');
        if (typeof selected.content !== 'object' || selected.content === null || Array.isArray(selected.content)) throw new Error('Invalid variant content');
        const variant = selected.content as Readonly<Record<string, JsonValue>>;
        const target = projectRecord.document.nodes.find((node) => node.nodeId === targetNodeId);
        if (!target || target.serviceClass !== variant.serviceClass ||
          (target.kind === 'operator' ? target.operatorClass : null) !== (variant.operatorClass ?? null)) throw new Error('Preset requires a matching service/operator class');
        const stateValues = variant.stateValues;
        if (typeof stateValues !== 'object' || stateValues === null || Array.isArray(stateValues)) throw new Error('Variant requires stateValues');
        const operations = Object.entries(stateValues as Readonly<Record<string, JsonValue>>).map(([field, value]) => ({ op: 'setNodeState' as const, nodeId: targetNodeId, field, value }));
        const result = await patchProject(projectRecord.projectId, projectRecord.document, operations);
        setProjectRecord({ ...projectRecord, document: result.document });
      }
      if (selected.kind === 'preset' || preview?.component.endpoints.length === 0) setStatus(`Applied ${selected.kind} to project`);
    } catch (error: unknown) { setStatus(error instanceof Error ? error.message : 'Asset apply failed'); }
  }, [projectRecord, selected, targetNodeId, preview, hostBindings]);

  const saved = selected !== null && name === selected.name && description === selected.description && content === JSON.stringify(selected.content, null, 2);
  const search = query.toLowerCase().trim();
  const localWorks: readonly LocalWork[] = [
    ...projects.map((project): LocalWork => ({ kind: 'graph', project })),
    ...assets.map((asset): LocalWork => ({ kind: 'draft', asset })),
  ];
  const filteredWorks = localWorks.filter((work) => {
    const kind = work.kind === 'graph' ? 'graph' : work.asset.kind;
    const record = work.kind === 'graph' ? work.project : work.asset;
    const tags = work.kind === 'draft' ? work.asset.tags.join(' ') : '';
    return (kindFilter === 'all' || kindFilter === kind) && `${record.name} ${record.description} ${tags}`.toLowerCase().includes(search);
  }).sort((a, b) => {
    const first = a.kind === 'graph' ? a.project : a.asset;
    const second = b.kind === 'graph' ? b.project : b.asset;
    return second.updatedAt.localeCompare(first.updatedAt) || first.name.localeCompare(second.name);
  });
  const insertionContent = previewVersion === selected?.currentVersion ? selected.content : versions.find((version) => version.version === previewVersion)?.content;
  const canApply = projectRecord !== null && (selected?.kind === 'preset' || (preview !== null &&
    preview.component.presentation.nodeOrder.length > 0 && preview.issues.length === 0 &&
    !preview.component.hostBindings.some((binding) => !hostBindings[binding.bindingId]) && content === JSON.stringify(insertionContent, null, 2)));

  const navigation = <nav className="library-navigation" aria-label="Asset library">
        <button className={view === 'local' ? 'selected' : ''} aria-current={view === 'local' ? 'page' : undefined} onClick={() => navigate('local')}><HardDrive size={16}/>My Local</button>
        <span className="library-nav-label">Cloud</span>
        <button className={view === 'mine' ? 'selected' : ''} aria-current={view === 'mine' ? 'page' : undefined} onClick={() => navigate('mine')}><Cloud size={16}/>My Cloud</button>
        <button className={view === 'discover' ? 'selected' : ''} aria-current={view === 'discover' ? 'page' : undefined} onClick={() => navigate('discover')}><Compass size={16}/>Discover</button>
        <button className={view === 'following' ? 'selected' : ''} aria-current={view === 'following' ? 'page' : undefined} onClick={() => navigate('following')}><Heart size={16}/>Following</button>
      </nav>;
  if (view === 'mine' || view === 'discover' || view === 'following') return <section className="assets-workspace" aria-label="Asset library">
    <CloudBrowser key={view} view={view === 'discover' ? 'all' : view} project={projectRecord} draftLinks={links ?? []} navigation={navigation}
      targetProject={projects.length > 0 && <label className="field-stack">Target project<select className="plain-input" aria-label="Target project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>{projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.name}</option>)}</select></label>}
      onDraft={async (assetId) => { await reload(); navigate('local'); await selectAsset(assetId, true); }}
      onInserted={async () => { if (projectId) setProjectRecord(await fetchProject(projectId)); }}/>
  </section>;

  return <section className="assets-workspace" aria-label="Asset library">
    <aside className="asset-browser" aria-label="Local library sidebar">
      {navigation}
      <input className="plain-input local-draft-search" aria-label="Search My Local" placeholder="Search local works…" value={query} onChange={(event) => setQuery(event.target.value)}/>
      <LibraryKindFilters value={kindFilter} onChange={setKindFilter} label="Local asset type"/>
      <div className="asset-list" aria-label="Local results">{filteredWorks.map((work) => {
        if (work.kind === 'graph') {
          const project = work.project;
          return <button key={`graph:${project.projectId}`} className={localSelection?.kind === 'graph' && localSelection.projectId === project.projectId ? 'selected' : ''} onClick={() => selectProject(project.projectId)}>
            <Workflow size={15}/><span><strong>{project.name}</strong><small>Project graph · Local</small></span>
          </button>;
        }
        const asset = work.asset;
        const link = links?.find((item) => item.localAssetId === asset.assetId);
        const Icon = asset.kind === 'component' ? Boxes : Box;
        return <button className={localSelection?.kind === 'draft' && localSelection.assetId === asset.assetId ? 'selected' : ''} type="button" key={`draft:${asset.assetId}`} onClick={() => void selectAsset(asset.assetId)}>
          <Icon size={15}/><span><strong>{asset.name}</strong><small>{kindLabel(asset.kind)} · Local v{asset.currentVersion}</small>
            {link && <small>{link.owned ? 'Your Cloud work' : 'From another author'} · cloud v{link.reference.version}</small>}</span>
        </button>;
      })}</div>
      {filteredWorks.length === 0 && <p className="library-empty-state">{localWorks.length === 0 ? 'Create a project in Graph to get started.' : 'No local works match your search and type filter.'}</p>}
      <p className="draft-authoring-hint">In Graph: right-click a node to save a Variant, or a selection to save a Component.</p>
    </aside>
    <div className="asset-editor">
      {status && <p className="asset-workspace-status" role="status">{status}</p>}
      <header className="library-workspace-heading"><h2>My Local</h2><p>Your project graphs, Components and Variants on this device. Publish a saved version when you want to share it.</p></header>
      {localSelection?.kind === 'graph' ? <>
        {projectRecord?.projectId === localSelection.projectId ? <div className="project-detail">
          <header className="asset-section-heading"><div><h3>{projectRecord.name}</h3><p>{projectRecord.description || `${projectRecord.document.nodes.length} nodes in this graph`}</p></div>
            <div className="asset-detail-actions"><button className="command-button" onClick={() => { localStorage.setItem('f8studio.selectedProjectId', projectRecord.projectId); window.location.assign('/?view=graph'); }}>Open in Graph</button>
              <button className="command-button" onClick={() => setCapturing(true)}><Box size={15}/>Save as Component</button></div></header>
          <PublishPanel key={`graph:${projectRecord.projectId}`} project={projectRecord} onManage={() => navigate('mine')}/>
          <ProjectSnapshots key={projectRecord.projectId} project={projectRecord} onRestored={setProjectRecord}/>
        </div> : <p className="library-empty-state">Loading project…</p>}
      </> : <>
        {selected === null ? <div className="library-empty-state">{localSelection?.kind === 'draft' ? 'Loading local draft…' : 'Choose a local work to view its details.'}</div> : <div className="draft-detail">
          <header className="draft-detail-heading"><div><span className="source-badge">Local draft</span><span className="draft-kind-label">{kindLabel(selected.kind)} · v{selected.currentVersion}</span>{!saved && <span className="draft-unsaved">Unsaved changes</span>}</div>
            <div className="asset-detail-actions"><button className="command-button primary" type="button" disabled={saved || !name.trim()} onClick={() => void save()}><Save size={15}/>Save draft</button>
              <div className="draft-more"><button className="icon-button bordered" aria-label="More draft actions" aria-expanded={moreActions} onClick={() => setMoreActions((value) => !value)}><MoreHorizontal size={17}/></button>
                {moreActions && <div className="draft-more-menu" role="menu">
                  <button role="menuitem" onClick={() => { setEditingJson((value) => !value); setMoreActions(false); }}>{editingJson ? 'Hide content JSON' : 'Edit content JSON'}</button>
                  <button role="menuitem" onClick={() => { downloadJson(`${selected.name}.json`, { schemaVersion: 'f8studio-asset/1', asset: selected, versions }); setMoreActions(false); }}><Download size={14}/>Export draft</button>
                  <button role="menuitem" className="danger" aria-label="Delete local draft" onClick={() => { setDeleteError(''); setDeleting(true); setMoreActions(false); }}><Trash2 size={14}/>Delete local draft</button>
                </div>}
              </div></div></header>
          <div className="draft-metadata"><label className="field-stack">Name<input className="plain-input" value={name} onChange={(event) => setName(event.target.value)} aria-label="Asset name"/></label>
            <label className="field-stack">Description<textarea className="plain-input" aria-label="Description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Describe what this draft does and how to use it."/></label></div>
          {(selected.kind === 'component' || selected.kind === 'variant') && <PublishPanel key={selected.assetId} asset={selected} saved={saved} onManage={() => navigate('mine')}/>}
          {preview !== null && <section className="draft-preview" aria-label="Component preview">
            <header className="asset-section-heading"><h3>{kindLabel(selected.kind)} preview</h3><label className="local-version-picker">Local version<select className="plain-input" aria-label="Local draft version" value={previewVersion} onChange={(event) => {
              const version = Number(event.target.value); setPreviewVersion(version);
              const nextContent = version === selected.currentVersion ? selected.content : versions.find((item) => item.version === version)?.content;
              if (nextContent !== undefined) setContent(JSON.stringify(nextContent, null, 2));
            }}>{[...new Set([selected.currentVersion, ...versions.map((version) => version.version)])].sort((a, b) => b - a).map((version) => <option key={version} value={version}>v{version}{version === selected.currentVersion ? ' · latest' : ''}</option>)}</select></label></header>
            <GraphView document={preview.document} readonly/>
            {preview.issues.map((issue, index) => <p role="alert" key={`${issue.nodeId}:${index}`}>{issue.message}</p>)}
            <div className="draft-insertion"><label className="field-stack">Target project<select className="plain-input" aria-label="Target project" value={projectId} onChange={(event) => setProjectId(event.target.value)}>{projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.name}</option>)}</select></label>
              {preview.component.hostBindings.map((binding) => <label className="field-stack" key={binding.bindingId}>Host for {binding.serviceClass}<select className="plain-input" aria-label={`Host for ${binding.bindingId}`} value={hostBindings[binding.bindingId] ?? ''} onChange={(event) => setHostBindings((previous) => ({ ...previous, [binding.bindingId]: event.target.value }))}>
                <option value="">Choose an existing service</option>
                {selected.kind === 'variant' && binding.serviceClass === 'f8.pystudio' ? <option value="studio">Web Studio Runtime</option> : projectRecord?.document.nodes.filter((node) => node.kind === 'service' && node.serviceClass === binding.serviceClass).map((node) => <option key={node.nodeId} value={node.nodeId}>{node.name}</option>)}
              </select></label>)}
              <button className="command-button" disabled={!canApply} onClick={() => void applyAsset()}>Add to project</button>
            </div>
            {preview.component.endpoints.length > 0 && <p>Connect these exposed ports after insertion: {preview.component.endpoints.map((endpoint) => `${endpoint.nodeId}/${endpoint.portId}`).join(', ')}</p>}
          </section>}
          {selected.kind === 'preset' && <div className="draft-insertion"><p>Legacy parameter preset. Save a Variant in Graph to reuse a complete node.</p><label className="field-stack">Target node<select className="plain-input" value={targetNodeId} onChange={(event) => setTargetNodeId(event.target.value)} aria-label="Preset target node">{projectRecord?.document.nodes.map((node) => <option value={node.nodeId} key={node.nodeId}>{node.name}</option>)}</select></label><button className="command-button" disabled={!canApply} onClick={() => void applyAsset()}>Apply preset</button></div>}
          {editingJson && <label className="field-stack asset-json">Content JSON<textarea aria-label="Content JSON" value={content} onChange={(event) => setContent(event.target.value)} spellCheck={false}/></label>}
        </div>}
      </>}
    </div>
    {capturing && projectRecord !== null && <ShareStateDialog key={projectRecord.projectId} title="Save as Component" document={projectRecord.document} onClose={closeCapture} onShare={captureProject}/>}
    {deleting && selected && <Modal title="Delete local draft" onClose={closeDelete}><p>Delete “{selected.name}” from this device? Your Cloud publications will stay as they are.</p>{deleteError && <p role="alert">{deleteError}</p>}<div className="dialog-actions"><button className="command-button" disabled={deleteBusy} onClick={closeDelete}>Cancel</button><button className="command-button danger" disabled={deleteBusy} onClick={() => void removeAsset()}>{deleteBusy ? 'Deleting…' : 'Delete local draft'}</button></div></Modal>}
  </section>;
}
