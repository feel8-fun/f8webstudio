import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { StudioDocument } from '../api/contracts';
import type { ComponentPreview } from '../api/contracts.gen';
import { GraphView } from '../graph/GraphView';
import { localLibraryProvider } from './localProvider';
import { templatePlacement } from './templatePlacement';
import type { LibraryProvider, LibraryTemplate, LibraryVersion, TemplateReference } from './types';

export function TemplateInsertion({ document, template, provider = localLibraryProvider, configure = false, showVersions = true, embedded = false,
  preferredServiceId, position, onBack, onBusy, onInserted }: {
  readonly document: StudioDocument;
  readonly template: LibraryTemplate;
  readonly provider?: LibraryProvider;
  readonly configure?: boolean;
  readonly showVersions?: boolean;
  readonly embedded?: boolean;
  readonly preferredServiceId?: string;
  readonly position?: { readonly x: number; readonly y: number };
  readonly onBack: () => void;
  readonly onBusy: (busy: boolean) => void;
  readonly onInserted: (name: string) => Promise<void>;
}) {
  const [reference, setReference] = useState<TemplateReference>(template.reference);
  const [versions, setVersions] = useState<readonly LibraryVersion[]>([]);
  const [preview, setPreview] = useState<ComponentPreview | null>(null);
  const [bindings, setBindings] = useState<Readonly<Record<string, string>>>({});
  const [needsOptions, setNeedsOptions] = useState(configure);
  const [error, setError] = useState<string | null>(null);
  const [versionError, setVersionError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [loadRevision, setLoadRevision] = useState(0);
  const attempted = useRef(false);
  const adding = useRef(false);
  const requestId = useRef(crypto.randomUUID());
  const label = template.kind === 'component' ? 'Component' : 'Variant';
  const versionLicense=versions.find((version)=>version.reference.version===reference.version)?.license??template.license;
  useEffect(() => {
    if (!needsOptions || !showVersions) return;
    const controller = new AbortController();
    void provider.versions(template.reference, controller.signal).then((history) => { if (!controller.signal.aborted) setVersions(history); },
      (reason: unknown) => { if (!controller.signal.aborted) setVersionError(reason instanceof Error ? reason.message : `Cannot load ${label.toLowerCase()} versions`); });
    return () => controller.abort();
  }, [provider, template.reference, needsOptions, showVersions, loadRevision]);
  useEffect(() => {
    setPreview(null); setBindings({}); setError(null);
    requestId.current = crypto.randomUUID();
    const controller = new AbortController();
    void provider.preview(reference, controller.signal).then((loaded) => {
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
      if (!loaded.component.presentation.nodeOrder.length || loaded.issues.length > 0 || loaded.component.hostBindings.some((binding) => !next[binding.bindingId])) setNeedsOptions(true);
    }, (reason: unknown) => {
      if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : `Cannot load ${label.toLowerCase()}`); setNeedsOptions(true); }
    });
    return () => controller.abort();
  }, [provider, reference, document.nodes, preferredServiceId, loadRevision]);
  const ready = preview !== null && preview.component.presentation.nodeOrder.length > 0 && preview.issues.length === 0 &&
    preview.component.hostBindings.every((binding) => bindings[binding.bindingId]);
  const add = useCallback(async () => {
    if (!ready || !preview || adding.current) return;
    adding.current = true; setPending(true); onBusy(true); setError(null);
    try {
      await provider.insert(reference, document, {
        requestId: requestId.current, expectedGraphRevision: document.graphRevision, expectedLayoutRevision: document.layoutRevision,
        hostBindings: bindings, ...templatePlacement(document, preview, bindings, position),
      });
      await onInserted(template.name);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : `Cannot add ${label.toLowerCase()}`); setNeedsOptions(true);
    } finally { adding.current = false; setPending(false); onBusy(false); }
  }, [ready, preview, onBusy, position, document, bindings, reference, template.name, provider, onInserted]);
  useEffect(() => {
    if (ready && !needsOptions && !attempted.current) { attempted.current = true; void add(); }
  }, [ready, needsOptions, add]);
  return <div className="template-insertion" aria-label={`${label} insertion`}>
    {!embedded && <strong>{template.name} · {label} · v{reference.version}</strong>}
    {!preview && !error && <p role="status">Loading {label.toLowerCase()}…</p>}
    {pending && <p role="status">Adding {label.toLowerCase()}…</p>}
    {needsOptions && <>
      {!embedded && <><small>{reference.source === 'local' ? `Local ${label.toLowerCase()}` : `Online · ${template.author?.name ?? reference.registryId}`}</small>
      <div className="library-description markdown-body"><ReactMarkdown remarkPlugins={[remarkGfm]}>{template.description || 'No description provided.'}</ReactMarkdown></div>
      {template.tags.length > 0 && <p className="library-tags">{template.tags.join(' · ')}</p>}
      {versionLicense && <p>License: {versionLicense}</p>}</>}
      {showVersions&&<label className="field-stack">Version<select aria-label={`${label} version`} value={reference.version} disabled={pending} onChange={(event) => {
        const selected = versions.find((item) => item.reference.version === Number(event.target.value));
        if (selected) { attempted.current = false; setPreview(null); setReference(selected.reference); }
      }}>
        {!versions.some((item) => item.reference.version === reference.version) && <option value={reference.version}>v{reference.version}</option>}
        {versions.map((item) => <option key={item.reference.version} value={item.reference.version}>v{item.reference.version}</option>)}
      </select></label>}
      {versions.find((item) => item.reference.version === reference.version)?.note && <p>{versions.find((item) => item.reference.version === reference.version)?.note}</p>}
      {versionError && <p role="alert">{versionError}</p>}
      {preview && <>
        <GraphView document={preview.document} />
        <p>{preview.component.presentation.nodeOrder.length} node(s) · {preview.component.connections.length} internal connection(s)</p>
        {!preview.component.presentation.nodeOrder.length && <p role="alert">This {label.toLowerCase()} has no nodes to add.</p>}
        {preview.issues.map((issue, index) => <p key={index} role="alert">{issue.message}</p>)}
        {preview.component.hostBindings.map((binding) => {
          const hosts = document.nodes.filter((node) => node.kind === 'service' && node.serviceClass === binding.serviceClass);
          return <label className="field-stack" key={binding.bindingId}>Host for {binding.serviceClass} · {binding.bindingId}
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
        {preview.component.endpoints.length > 0 && <div><strong>Connect after adding</strong><ul>
          {preview.component.endpoints.map((endpoint) => <li key={endpoint.endpointId}>{endpoint.direction} · {endpoint.nodeId} / {endpoint.portId}</li>)}
        </ul></div>}
      </>}
    </>}
    {error && <p role="alert">{error}</p>}
    {error&&!preview&&<button className="command-button" disabled={pending} onClick={()=>setLoadRevision((value)=>value+1)}>Retry {label.toLowerCase()}</button>}
    <div className="template-actions">
      {needsOptions && <button className="command-button primary" type="button" disabled={pending || !ready} onClick={() => void add()}>Add node</button>}
      {!embedded && <button className="command-button" type="button" disabled={pending} onClick={onBack}>Back to search</button>}
    </div>
  </div>;
}
