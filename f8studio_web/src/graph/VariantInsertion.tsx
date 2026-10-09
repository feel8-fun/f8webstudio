import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchAssetVersions, fetchComponentPreview, insertProjectComponent } from '../api/client';
import type { AssetVersion, StudioDocument } from '../api/contracts';
import type { ComponentPreview, VariantSummary } from '../api/contracts.gen';
import { projectDocument } from './projection';
import { variantPositionInHost } from './variantPlacement';

export function VariantInsertion({ document, variant, configure = false, preferredServiceId, position, onBack, onBusy, onInserted }: {
  readonly document: StudioDocument;
  readonly variant: VariantSummary;
  readonly configure?: boolean;
  readonly preferredServiceId?: string;
  readonly position?: { readonly x: number; readonly y: number };
  readonly onBack: () => void;
  readonly onBusy: (busy: boolean) => void;
  readonly onInserted: (name: string) => Promise<void>;
}) {
  const [version, setVersion] = useState(variant.currentVersion);
  const [versions, setVersions] = useState<readonly AssetVersion[]>([]);
  const [preview, setPreview] = useState<ComponentPreview | null>(null);
  const [bindings, setBindings] = useState<Readonly<Record<string, string>>>({});
  const [needsOptions, setNeedsOptions] = useState(configure);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const attempted = useRef(false);
  const requestId = useRef(crypto.randomUUID());
  useEffect(() => {
    if (!needsOptions) return;
    let disposed = false;
    void fetchAssetVersions(variant.assetId).then((history) => { if (!disposed) setVersions(history); },
      (reason: unknown) => { if (!disposed) setError(reason instanceof Error ? reason.message : 'Cannot load Variant versions'); });
    return () => { disposed = true; };
  }, [variant.assetId, needsOptions]);
  useEffect(() => {
    setPreview(null); setBindings({}); setError(null);
    requestId.current = crypto.randomUUID();
    const controller = new AbortController();
    void fetchComponentPreview(variant.assetId, version, controller.signal).then((loaded) => {
      if (controller.signal.aborted) return;
      const next: Record<string, string> = {};
      for (const binding of loaded.component.hostBindings) {
        const hosts = document.nodes.filter((node) => node.kind === 'service' && node.serviceClass === binding.serviceClass);
        const preferred = hosts.find((node) => node.serviceId === preferredServiceId);
        if (binding.serviceClass === 'f8.pystudio') next[binding.bindingId] = 'studio';
        else if (preferred) next[binding.bindingId] = preferred.serviceId;
        else if (hosts.length === 1) next[binding.bindingId] = hosts[0]!.serviceId;
      }
      setPreview(loaded); setBindings(next);
      if (loaded.issues.length > 0 || loaded.component.hostBindings.some((binding) => !next[binding.bindingId])) setNeedsOptions(true);
    }, (reason: unknown) => {
      if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : 'Cannot load Variant'); setNeedsOptions(true); }
    });
    return () => controller.abort();
  }, [variant.assetId, version, document.nodes, preferredServiceId]);
  const ready = preview !== null && preview.issues.length === 0 && preview.component.hostBindings.every((binding) => bindings[binding.bindingId]);
  const add = useCallback(async () => {
    if (!ready || !preview || pending) return;
    setPending(true); onBusy(true); setError(null);
    try {
      let location = position ?? { x: 40, y: 40 };
      const binding = preview.component.hostBindings[0];
      if (binding && binding.serviceClass !== 'f8.pystudio') {
        const nodes = projectDocument(document).nodes;
        const host = nodes.find((node) => node.data.graphNode.kind === 'service' && node.data.graphNode.serviceId === bindings[binding.bindingId]);
        const template = preview.document.nodes.find((node) => node.nodeId === preview.component.presentation.nodeOrder[0]);
        if (host && template) location = variantPositionInHost(host, nodes, template, position);
      }
      await insertProjectComponent(document.projectId, {
        requestId: requestId.current, expectedGraphRevision: document.graphRevision, expectedLayoutRevision: document.layoutRevision,
        assetId: variant.assetId, version, hostBindings: bindings, x: location.x, y: location.y,
      });
      await onInserted(variant.name);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Cannot add Variant'); setNeedsOptions(true);
    } finally { setPending(false); onBusy(false); }
  }, [ready, preview, pending, onBusy, position, document, bindings, variant, version, onInserted]);
  useEffect(() => {
    if (ready && !needsOptions && !attempted.current) { attempted.current = true; void add(); }
  }, [ready, needsOptions, add]);
  return <div className="quick-variant-insertion" aria-label="Variant insertion">
    <strong>{variant.name} · Variant · v{version}</strong>
    {!preview && !error && <p role="status">Loading template…</p>}
    {pending && <p role="status">Adding node…</p>}
    {needsOptions && <>
      <label className="field-stack">Version<select aria-label="Variant version" value={version} disabled={pending} onChange={(event) => {
        attempted.current = false; setPreview(null); setVersion(Number(event.target.value));
      }}>
        {versions.length ? versions.map((item) => <option key={item.version} value={item.version}>v{item.version}</option>) : <option value={version}>v{version}</option>}
      </select></label>
      {preview?.issues.map((issue, index) => <p key={index} role="alert">{issue.message}</p>)}
      {preview?.component.hostBindings.map((binding) => {
        const hosts = document.nodes.filter((node) => node.kind === 'service' && node.serviceClass === binding.serviceClass);
        return <label className="field-stack" key={binding.bindingId}>Host for {binding.serviceClass}
          <select aria-label={`Host for ${binding.bindingId}`} disabled={pending || binding.serviceClass === 'f8.pystudio'}
            value={bindings[binding.bindingId] ?? ''} onChange={(event) => {
              requestId.current = crypto.randomUUID(); setBindings((previous) => ({ ...previous, [binding.bindingId]: event.target.value }));
            }}>
            <option value="">Choose a service</option>
            {binding.serviceClass === 'f8.pystudio' ? <option value="studio">Web Studio Runtime</option> :
              hosts.map((node) => <option key={node.nodeId} value={node.serviceId}>{node.name}</option>)}
          </select>
          {hosts.length === 0 && binding.serviceClass !== 'f8.pystudio' && <small>Add a {binding.serviceClass} service first.</small>}
        </label>;
      })}
      <button className="command-button primary" type="button" disabled={pending || !ready} onClick={() => void add()}>Add node</button>
    </>}
    {error && <p role="alert">{error}</p>}
    <button className="command-button" type="button" disabled={pending} onClick={onBack}>Back to search</button>
  </div>;
}
