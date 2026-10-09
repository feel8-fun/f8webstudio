import { ShareStateDialog } from "../graph/ShareStateDialog";
import type { ExcludedState } from "../api/contracts.gen";
import { Box, Camera, Download, Plus, Save, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  captureProjectComponent, createAsset,
  createProjectVersion,
  deleteAsset,
  fetchAsset,
  fetchAssets,
  fetchAssetVersions,
  fetchComponentPreview,
  insertProjectComponent,
  fetchProjects,
  fetchProjectVersions,
  fetchProject,
  patchProject,
  restoreProjectVersion,
  updateAsset,
} from '../api/client';
import type { AssetKind, AssetRecord, AssetSummary, AssetVersion, JsonValue, ProjectRecord, ProjectSummary, ProjectVersion } from '../api/contracts';
import type { ComponentPreview } from '../api/contracts.gen';
import { GraphView } from '../graph/GraphView';

const EMPTY_COMPONENT = { format: 'f8component', formatVersion: 1, definitions: { services: {}, operators: {} },
  services: {}, operators: {}, connections: [], presentation: { layout: [], nodeOrder: [] }, hostBindings: [], endpoints: [] };
const EMPTY_VARIANT = { schemaVersion: 'f8studio-variant/1', serviceClass: 'f8.pyengine', stateValues: {} };

function downloadJson(filename: string, value: unknown): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function AssetsWorkspace() {
  const [assets, setAssets] = useState<readonly AssetSummary[]>([]);
  const [selected, setSelected] = useState<AssetRecord | null>(null);
  const [versions, setVersions] = useState<readonly AssetVersion[]>([]);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const [projects, setProjects] = useState<readonly ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState('');
  const [projectVersions, setProjectVersions] = useState<readonly ProjectVersion[]>([]);
  const [projectRecord, setProjectRecord] = useState<ProjectRecord | null>(null);
  const [targetNodeId, setTargetNodeId] = useState('');
  const [capturing, setCapturing] = useState(false);
  const closeCapture = useCallback(() => setCapturing(false), []);
  const [status, setStatus] = useState('Ready');
  const [previewVersion, setPreviewVersion] = useState(1);
  const [preview, setPreview] = useState<ComponentPreview | null>(null);
  const [hostBindings, setHostBindings] = useState<Readonly<Record<string, string>>>({});
  const insertionRequestId = useRef<string | null>(null);

  useEffect(() => {
    setPreview(null);
    setHostBindings({});
    if (selected?.kind !== 'component' && selected?.kind !== 'variant') return;
    const controller = new AbortController();
    void fetchComponentPreview(selected.assetId, previewVersion, controller.signal).then(setPreview,
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
    setProjectId((current) => current || nextProjects[0]?.projectId || '');
  }, []);

  useEffect(() => { void reload().catch((error: unknown) => setStatus(error instanceof Error ? error.message : 'Load failed')); }, [reload]);

  useEffect(() => {
    if (!projectId) { setProjectVersions([]); return; }
    void Promise.all([fetchProjectVersions(projectId), fetchProject(projectId)]).then(([history, record]) => {
      setProjectVersions(history);
      setProjectRecord(record);
      setTargetNodeId((current) => record.document.nodes.some((node) => node.nodeId === current) ? current : record.document.nodes[0]?.nodeId ?? '');
    }, (error: unknown) => setStatus(error instanceof Error ? error.message : 'Version load failed'));
  }, [projectId]);

  const selectAsset = useCallback(async (assetId: string) => {
    try {
      const [record, history] = await Promise.all([fetchAsset(assetId), fetchAssetVersions(assetId)]);
      setSelected(record);
      setPreviewVersion(record.currentVersion);
      setVersions(history);
      setName(record.name);
      setDescription(record.description);
      setContent(JSON.stringify(record.content, null, 2));
      setStatus('Ready');
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : 'Asset load failed');
    }
  }, []);

  const addAsset = useCallback(async (kind: AssetKind) => {
    try {
      const created = await createAsset({
        kind,
        name: kind === 'component' ? 'New component' : 'New preset',
        content: (kind === 'component' ? EMPTY_COMPONENT : EMPTY_VARIANT) as JsonValue,
      });
      await reload();
      await selectAsset(created.assetId);
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : 'Asset creation failed');
    }
  }, [reload, selectAsset]);

  const save = useCallback(async () => {
    if (selected === null) return;
    try {
      const parsed = JSON.parse(content) as JsonValue;
      const updated = await updateAsset(selected.assetId, { name, description, tags: selected.tags, content: parsed, expectedVersion: selected.currentVersion });
      setSelected(updated);
      setPreviewVersion(updated.currentVersion);
      setVersions(await fetchAssetVersions(updated.assetId));
      await reload();
      setStatus(`Saved version ${updated.currentVersion}`);
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : 'Save failed');
    }
  }, [content, description, name, reload, selected]);

  const createSnapshot = useCallback(async () => {
    if (!projectId) return;
    try {
      await createProjectVersion(projectId, `Snapshot ${new Date().toLocaleString()}`);
      setProjectVersions(await fetchProjectVersions(projectId));
      setStatus('Project snapshot created');
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : 'Snapshot failed');
    }
  }, [projectId]);

  const restoreSnapshot = useCallback(async (versionId: string) => {
    if (!projectId) return;
    try {
      const restored = await restoreProjectVersion(projectId, versionId);
      setProjectRecord(restored);
      setTargetNodeId((current) => restored.document.nodes.some((node) => node.nodeId === current)
        ? current
        : restored.document.nodes[0]?.nodeId ?? '');
      setStatus('Version restored');
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : 'Version restore failed');
    }
  }, [projectId]);

  const removeAsset = useCallback(async () => {
    if (selected === null) return;
    try {
      await deleteAsset(selected.assetId);
      setSelected(null);
      setVersions([]);
      await reload();
      setStatus('Asset deleted');
    } catch (error: unknown) {
      setStatus(error instanceof Error ? error.message : 'Asset deletion failed');
    }
  }, [reload, selected]);

  const captureProject = useCallback(async (excludedStates: readonly ExcludedState[]) => {
    if (projectRecord === null) return;
    const created = await captureProjectComponent(projectRecord.projectId, projectRecord.document,
      `${projects.find((project) => project.projectId === projectId)?.name ?? 'Project'} component`, excludedStates);
    await reload();
    await selectAsset(created.assetId);
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

  return (
    <section className="assets-workspace" aria-label="Assets and versions">
      <aside className="asset-browser">
        <div className="pane-heading">Local assets</div>
        <div className="asset-actions">
          <button className="command-button" type="button" onClick={() => void addAsset('component')}><Plus size={14} />Component</button>
          <button className="command-button" type="button" onClick={() => void addAsset('preset')}><Plus size={14} />Preset</button>
        </div>
        <div className="asset-list">
          {assets.map((asset) => <button className={selected?.assetId === asset.assetId ? 'selected' : ''} type="button" key={asset.assetId} onClick={() => void selectAsset(asset.assetId)}>
            <Box size={15} /><span><strong>{asset.name}</strong><small>{asset.kind} · v{asset.currentVersion}</small></span>
          </button>)}
          {assets.length === 0 && <div className="empty-state">No local assets</div>}
        </div>
        <div className="pane-heading version-heading">Project versions</div>
        <select value={projectId} onChange={(event) => setProjectId(event.target.value)} aria-label="Versioned project">
          {projects.map((project) => <option value={project.projectId} key={project.projectId}>{project.name}</option>)}
        </select>
        <button className="command-button" type="button" disabled={!projectId} onClick={() => void createSnapshot()}><Camera size={14} />Snapshot</button>
        {capturing && projectRecord !== null && <ShareStateDialog key={projectRecord.projectId} title="Capture component" document={projectRecord.document} onClose={closeCapture} onShare={captureProject} />}
        <button className="command-button" type="button" disabled={projectRecord === null} onClick={() => setCapturing(true)}><Box size={14} />Capture graph</button>
        <div className="project-version-list">
          {projectVersions.map((version) => <div key={version.versionId}><span>{version.name}<small>r{version.document.graphRevision}</small></span><button className="icon-button bordered" type="button" title="Restore version" aria-label={`Restore ${version.name}`} onClick={() => void restoreSnapshot(version.versionId)}><Download size={14} /></button></div>)}
        </div>
      </aside>
      <div className="asset-editor">
        {selected === null ? <div className="empty-state centered">Select or create an asset</div> : <>
          <div className="tool-strip">
            <input className="plain-input asset-name" value={name} onChange={(event) => setName(event.target.value)} aria-label="Asset name" />
            {selected.kind === 'preset' && <select className="plain-input asset-target" value={targetNodeId} onChange={(event) => setTargetNodeId(event.target.value)} aria-label="Preset target node">{projectRecord?.document.nodes.map((node) => <option value={node.nodeId} key={node.nodeId}>{node.name}</option>)}</select>}
            <span className="tool-status" role="status">{status}</span>
            <button className="icon-button bordered" type="button" aria-label="Export asset" title="Export asset" onClick={() => downloadJson(`${selected.name}.json`, { schemaVersion: 'f8studio-asset/1', asset: selected, versions })}><Download size={16} /></button>
            <button className="icon-button bordered danger" type="button" aria-label="Delete asset" title="Delete asset" onClick={() => void removeAsset()}><Trash2 size={16} /></button>
            <button className="command-button primary" type="button" onClick={() => void save()}><Save size={15} />Save version</button>
            <button className="command-button" type="button" disabled={projectRecord === null || ((selected.kind === 'component' || selected.kind === 'variant') &&
              (preview === null || preview.component.presentation.nodeOrder.length === 0 || preview.issues.length > 0 || preview.component.hostBindings.some((binding) => !hostBindings[binding.bindingId])))} onClick={() => void applyAsset()}>Apply</button>
          </div>
          <label className="field-stack">Description<input className="plain-input" value={description} onChange={(event) => setDescription(event.target.value)} /></label>
          {preview !== null && <section aria-label="Component preview">
            <GraphView document={preview.document} readonly />
            {preview.issues.map((issue, index) => <p role="alert" key={`${issue.nodeId}:${index}`}>{issue.message}</p>)}
            {preview.component.hostBindings.map((binding) => <label className="field-stack" key={binding.bindingId}>
              Host for {binding.serviceClass}<select aria-label={`Host for ${binding.bindingId}`} value={hostBindings[binding.bindingId] ?? ''}
                onChange={(event) => setHostBindings((previous) => ({ ...previous, [binding.bindingId]: event.target.value }))}>
                <option value="">Choose an existing service</option>
                {selected.kind === 'variant' && binding.serviceClass === 'f8.pystudio' ? <option value="studio">Web Studio Runtime</option> :
                  projectRecord?.document.nodes.filter((node) => node.kind === 'service' && node.serviceClass === binding.serviceClass)
                    .map((node) => <option key={node.nodeId} value={node.nodeId}>{node.name}</option>)}
              </select>
            </label>)}
            {preview.component.endpoints.length > 0 && <p>Connect these exposed ports after insertion: {preview.component.endpoints.map((endpoint) => `${endpoint.nodeId}/${endpoint.portId}`).join(', ')}</p>}
          </section>}
          <label className="field-stack asset-json">Typed JSON content<textarea value={content} onChange={(event) => setContent(event.target.value)} spellCheck={false} /></label>
          <div className="asset-version-strip">{versions.map((version) => <button type="button" key={version.version} onClick={() => { setPreviewVersion(version.version); setContent(JSON.stringify(version.content, null, 2)); }}>v{version.version}<small>{new Date(version.createdAt).toLocaleString()}</small></button>)}</div>
        </>}
      </div>
    </section>
  );
}
