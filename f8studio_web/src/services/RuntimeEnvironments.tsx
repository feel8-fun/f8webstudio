import { Folder, Layers, RefreshCw, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { cancelEnvironmentPreparation, cleanUnusedEnvironments, fetchEnvironmentDetail, fetchRuntimeStorage,
  prepareEnvironment, removeEnvironment, setRuntimeStorage } from '../api/client';
import type { EnvironmentDetail, EnvironmentStatus, EnvironmentUsage, ExtensionStatus, RuntimeStorageStatus } from '../api/contracts.gen';

const bytes = (value: number | null | undefined) => value == null ? 'Unavailable' : `${(value / 1024 / 1024).toFixed(1)} MiB`;
function Usage({ usage }: { usage: EnvironmentUsage }) {
  return <dl className="extension-metadata">
    <dt>File data (hardlinks counted once)</dt><dd>{bytes(usage.uniqueFileBytes)}</dd>
    <dt>Allocated file blocks</dt><dd>{bytes(usage.allocatedBytes)}</dd>
    <dt>Exclusive allocated blocks</dt><dd>{bytes(usage.exclusiveAllocatedBytes)}</dd>
    <dt>Data with multiple hardlinks</dt><dd>{bytes(usage.sharedLinkBytes)}</dd>
  </dl>;
}

export function RuntimeEnvironments({ environments, extensions, onRefresh, locked, refreshRevision = 0 }: {
  environments: readonly EnvironmentStatus[]; extensions: readonly ExtensionStatus[];
  onRefresh: () => Promise<void>; locked: boolean; refreshRevision?: number;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [selected, setSelected] = useState('');
  const [detail, setDetail] = useState<EnvironmentDetail | null>(null);
  const [storage, setStorage] = useState<RuntimeStorageStatus | null>(null);
  const [storagePath, setStoragePath] = useState('');
  const [revision, setRevision] = useState(0);
  const [storageRefresh, setStorageRefresh] = useState(0);
  const [measuring, setMeasuring] = useState(true);
  const lastForcedRevision = useRef(0);
  const preparing = environments.some((environment) => environment.state === 'preparing');
  const disabled = locked || busy;
  useEffect(() => {
    const controller = new AbortController();
    const forcedRevision = storageRefresh + refreshRevision;
    const force = forcedRevision !== lastForcedRevision.current;
    lastForcedRevision.current = forcedRevision;
    setMeasuring(true);
    void fetchRuntimeStorage(controller.signal, force).then((next) => {
      if (!controller.signal.aborted) { setStorage(next); setStoragePath(next.path); }
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Unable to load runtime storage');
    }).finally(() => { if (!controller.signal.aborted) setMeasuring(false); });
    return () => controller.abort();
  }, [revision, preparing, refreshRevision, storageRefresh]);
  useEffect(() => {
    if (!selected) { setDetail(null); return; }
    const controller = new AbortController();
    setDetail(null);
    void fetchEnvironmentDetail(selected, controller.signal).then((next) => {
      if (!controller.signal.aborted) setDetail(next);
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Unable to inspect environment');
    });
    return () => controller.abort();
  }, [selected, revision, preparing, refreshRevision]);
  const act = async (action: () => Promise<unknown>) => {
    setBusy(true); setError(''); setMessage('');
    try { await action(); await onRefresh(); setRevision((value) => value + 1); }
    catch (reason: unknown) { setError(reason instanceof Error ? reason.message : 'Environment operation failed'); }
    finally { setBusy(false); }
  };
  return <section className="runtime-environments" aria-label="Runtime environments">
    <header><div><h2><Layers size={18} />Runtime environments</h2><p>Environments are defined by extensions and installed by Pixi. Inspect packages and manage storage here.</p></div></header>
    {error && <div role="alert" className="services-error">{error}</div>}
    {message && <p role="status">{message}</p>}
    {measuring && <p role="status">{storage ? 'Updating storage usage…' : 'Measuring storage usage…'}</p>}
    {storage && <article className="runtime-card runtime-storage" aria-label="Runtime storage">
      <h3>Storage and package cache</h3>
      <p className="extension-muted">Environment files and package cache below share one total: hardlinks are counted once across both.</p>
      <Usage usage={storage.totalUsage} />
      <div className="runtime-grid">
        <div><h4>Environment files</h4><Usage usage={storage.environmentUsage} /></div>
        <div><h4>Package cache</h4><code>{storage.cachePath}</code><Usage usage={storage.cacheUsage} /></div>
      </div>
      <p className="extension-muted">Allocated blocks include filesystem block rounding. Shared copy-on-write extents are not measured. Windows reports file data sizes; allocated blocks may be unavailable. Deleting hardlinks still used elsewhere will not reclaim their data.</p>
      <p>The package cache is retained so packages can be reused by future installations.</p>
      {storage.usageUpdatedAt && <p className="extension-muted">Storage measured {new Date(storage.usageUpdatedAt * 1000).toLocaleTimeString()}</p>}
      <button className="command-button" disabled={busy || measuring} onClick={() => setStorageRefresh((value) => value + 1)}><RefreshCw size={14} />Refresh storage usage</button>
      {!!storage.unusedEnvironments.length && <details><summary>Unused environment directories ({storage.unusedEnvironments.length})</summary>
        <ul>{storage.unusedEnvironments.map((environment) => <li key={environment.environmentId}><code>{environment.path}</code> · {bytes(environment.usage.uniqueFileBytes)}</li>)}</ul>
        <p>These managed directories are no longer used by installed extensions. Releasing them keeps the package cache.</p>
        <button className="command-button" disabled={disabled} onClick={() => void act(async () => { await cleanUnusedEnvironments(); setMessage('Unused environment cleanup queued.'); })}><Trash2 size={14} />Release unused environment files</button>
      </details>}
      <details><summary><Folder size={16} />Storage directory</summary>
        <form className="runtime-form" onSubmit={(event) => { event.preventDefault(); void act(() => setRuntimeStorage(storagePath)); }}>
          <label>Storage directory<input aria-label="Runtime storage directory" value={storagePath} disabled={!storage.canChange || disabled} onChange={(event) => setStoragePath(event.target.value)} /></label>
          <p>Managed environments and their package cache use this directory. Development environments remain in their checkout. Models and resources remain separate.</p>
          {!storage.canChange && <p>Release managed environment files before changing storage. Existing directories are not moved.</p>}
          <button className="command-button" disabled={!storage.canChange || disabled || !storagePath}>Save storage directory</button>
        </form>
      </details>
    </article>}
    <div className="runtime-grid">
      {environments.map((environment) => {
        const state = environment.state ?? (environment.ready ? 'ready' : 'missing');
        const users = environment.extensionIds.map((id) => extensions.find((extension) => extension.extensionId === id)?.name ?? id);
        return <article className="runtime-card" key={environment.environmentId}>
          <div className="extension-heading"><strong><button type="button" className="runtime-name" onClick={() => { setError(''); setSelected(environment.environmentId); }}>{environment.name || environment.environmentId}</button></strong><span className={`extension-state runtime-${state}`}>{state === 'changed' ? 'Definition changed' : state}</span></div>
          <div className="extension-detail">{environment.source} · {environment.runtimeKind} · {environment.revision || 'unversioned'}</div>
          <p className="runtime-users">{users.length ? users.join(', ') : 'No extension references this environment.'}</p>
          {environment.detail && <p className="extension-detail" role="status">{environment.detail}</p>}
          {!!environment.serviceClasses?.length && <details><summary>Services ({environment.serviceClasses.length})</summary><ul>{environment.serviceClasses.map((service) => <li key={service}><code>{service}</code></li>)}</ul></details>}
          {!!environment.toolIds?.length && <details><summary>Tools ({environment.toolIds.length})</summary><ul>{environment.toolIds.map((tool) => <li key={tool}><code>{tool}</code></li>)}</ul></details>}
          <div className="runtime-actions">
            {state === 'preparing' ? <button className="command-button" disabled={busy} onClick={() => void act(() => cancelEnvironmentPreparation(environment.environmentId))}><X size={14} />Cancel preparation</button>
              : <button className="command-button" disabled={disabled || environment.runtimeKind === 'bundled'} onClick={() => void act(() => prepareEnvironment(environment.environmentId))}><RefreshCw size={14} />{state === 'changed' ? 'Verify and update' : state === 'ready' ? 'Verify' : 'Prepare'}</button>}
            {environment.runtimeKind === 'pixi' && <button className="command-button" aria-label={`Release ${environment.name}`} disabled={disabled || !environment.canRemove} onClick={() => void act(async () => { await removeEnvironment(environment.environmentId); })}><Trash2 size={14} />Release files</button>}
          </div>
        </article>;
      })}
    </div>
    {selected && <article className="extension-content runtime-inspector" aria-label="Environment details">
      <div className="extension-heading"><h2>{detail?.name ?? 'Loading environment…'}</h2><button className="icon-button" aria-label="Close environment details" onClick={() => setSelected('')}><X size={16} /></button></div>
      {detail && <>
        <dl className="extension-metadata"><dt>Revision</dt><dd>{detail.revision}</dd><dt>Definition file</dt><dd><code>{detail.definitionPath}</code></dd><dt>Pixi environment</dt><dd><code>{detail.sourceEnvironment}</code></dd><dt>Environment path</dt><dd><code>{detail.storagePath}</code></dd></dl>
        <Usage usage={detail.usage} />
        <h3>{detail.packageInventory === 'installed' ? 'Installed packages' : 'Locked packages'} ({detail.packages.length})</h3>
        {detail.packageInventory === 'locked' && <p className="extension-muted">The environment is not installed. Packages below come from the extension's lock file and may include multiple platforms.</p>}
        <table className="runtime-packages"><thead><tr><th>Package</th><th>Version</th><th>Manager</th><th>Build / platform</th></tr></thead><tbody>{detail.packages.map((pkg, index) => <tr key={`${pkg.manager}/${pkg.name}/${pkg.platform}/${index}`}><td>{pkg.name}</td><td>{pkg.version}</td><td>{pkg.manager}</td><td>{[pkg.build, pkg.platform].filter(Boolean).join(' · ')}</td></tr>)}</tbody></table>
        <details><summary>Environment definition</summary><pre>{detail.manifest}</pre></details>
      </>}
    </article>}
  </section>;
}
