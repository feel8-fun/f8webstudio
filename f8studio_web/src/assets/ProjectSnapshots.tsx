import { Camera, Pencil, RotateCcw, Trash2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createProjectVersion, deleteProjectVersion, fetchProjectVersions, restoreProjectVersion, updateProjectVersion } from '../api/client';
import type { ProjectRecord, ProjectVersion } from '../api/contracts';
import { Modal } from '../app/Modal';

type SnapshotAction = { readonly kind: 'create' } | { readonly kind: 'edit' | 'restore' | 'delete'; readonly version: ProjectVersion };

export function ProjectSnapshots({ project, onRestored }: {
  readonly project: ProjectRecord;
  readonly onRestored: (record: ProjectRecord) => void;
}) {
  const [versions, setVersions] = useState<readonly ProjectVersion[]>([]);
  const [action, setAction] = useState<SnapshotAction | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [loadRevision, setLoadRevision] = useState(0);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void fetchProjectVersions(project.projectId, controller.signal).then((items) => {
      if (!controller.signal.aborted) { setVersions(items); setError(''); setLoading(false); }
    }, (reason: unknown) => {
      if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : 'Cannot load snapshots'); setLoading(false); }
    });
    return () => controller.abort();
  }, [project.projectId, loadRevision]);
  const close = useCallback(() => { if (!busy) setAction(null); }, [busy]);
  function begin(next: SnapshotAction) {
    setAction(next); setError(''); setMessage('');
    setName(next.kind === 'create' ? `Snapshot ${new Date().toLocaleString()}` : next.version.name);
    setDescription(next.kind === 'create' ? '' : next.version.description);
  }
  async function submit() {
    if (!action) return;
    setBusy(true); setError('');
    try {
      if (action.kind === 'create') {
        const snapshot = await createProjectVersion(project.projectId, name.trim(), description);
        if (active.current) { setVersions((items) => [snapshot, ...items]); setMessage('Snapshot saved on this device.'); }
      } else if (action.kind === 'edit') {
        const updated = await updateProjectVersion(project.projectId, action.version.versionId, name.trim(), description);
        if (active.current) { setVersions((items) => items.map((item) => item.versionId === updated.versionId ? updated : item)); setMessage('Snapshot details saved.'); }
      } else if (action.kind === 'delete') {
        await deleteProjectVersion(project.projectId, action.version.versionId);
        if (active.current) { setVersions((items) => items.filter((item) => item.versionId !== action.version.versionId)); setMessage('Snapshot deleted.'); }
      } else {
        const restored = await restoreProjectVersion(project.projectId, action.version.versionId);
        if (active.current) { onRestored(restored); setMessage(`Restored ${action.version.name}.`); }
      }
      if (active.current) setAction(null);
    } catch (reason: unknown) {
      console.error('Project snapshot action failed', reason);
      if (active.current) setError(reason instanceof Error ? reason.message : 'Snapshot action failed');
    } finally { if (active.current) setBusy(false); }
  }
  const editing = action?.kind === 'create' || action?.kind === 'edit';
  const title = action?.kind === 'create' ? 'Save local snapshot' : action?.kind === 'edit' ? 'Edit snapshot details' :
    action?.kind === 'delete' ? 'Delete snapshot' : 'Restore snapshot';
  return <section className="project-snapshots" aria-label="Local snapshots">
    <header className="asset-section-heading"><div><h3>Local snapshots</h3><p>Named checkpoints of this graph, saved on this device. Edit their notes or restore a checkpoint.</p></div>
      <button className="command-button" disabled={busy || loading} onClick={() => begin({ kind: 'create' })}><Camera size={15}/>Save snapshot</button></header>
    {message && <p role="status">{message}</p>}
    {!action && error && <div><p role="alert">{error}</p><button className="command-button" onClick={() => setLoadRevision((value) => value + 1)}>Reload snapshots</button></div>}
    <div className="snapshot-list">{versions.map((version) => <article key={version.versionId}>
      <div><h4>{version.name}</h4><small>{new Date(version.createdAt).toLocaleString()} · {version.document.nodes.length} nodes</small>{version.description && <p className="snapshot-description">{version.description}</p>}</div>
      <div className="snapshot-actions">
        <button className="icon-button" disabled={busy} title="Edit snapshot details" aria-label={`Edit ${version.name}`} onClick={() => begin({ kind: 'edit', version })}><Pencil size={15}/></button>
        <button className="command-button" disabled={busy} aria-label={`Restore ${version.name}`} onClick={() => begin({ kind: 'restore', version })}><RotateCcw size={14}/>Restore</button>
        <button className="icon-button danger" disabled={busy} title="Delete snapshot" aria-label={`Delete ${version.name}`} onClick={() => begin({ kind: 'delete', version })}><Trash2 size={15}/></button>
      </div>
    </article>)}</div>
    {loading && <p role="status">Loading snapshots…</p>}
    {versions.length === 0 && !error && !loading && <p className="library-empty-state">No snapshots yet. Save a checkpoint before making changes you may want to undo.</p>}
    {action && <Modal title={title} onClose={close}>
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        {editing ? <><label className="field-stack">Name<input className="plain-input" aria-label="Snapshot name" required disabled={busy} value={name} onChange={(event) => setName(event.target.value)}/></label>
          <label className="field-stack">Notes<textarea className="plain-input" aria-label="Snapshot notes" disabled={busy} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="What does this checkpoint capture?"/></label>
          <p>{action.kind === 'create' ? 'Saves the current graph. This does not publish to Cloud.' : 'Changes the name and notes. The saved graph stays fixed.'}</p></> :
          <p>{action.kind === 'delete' ? `Delete “${action.version.name}”? Your current graph and Cloud publications will stay as they are.` :
            `Restore “${action.version.name}”? This replaces the current graph. Save a snapshot first if you want to keep the current graph.`}</p>}
        {error && <p role="alert">{error}</p>}
        <div className="dialog-actions"><button className="command-button" type="button" disabled={busy} onClick={close}>Cancel</button>
          <button className={`command-button ${action.kind === 'delete' ? 'danger' : 'primary'}`} disabled={busy || (editing && !name.trim())}>{busy ? 'Working…' : editing ? 'Save' : action.kind === 'delete' ? 'Delete snapshot' : 'Restore snapshot'}</button></div>
      </form>
    </Modal>}
  </section>;
}
