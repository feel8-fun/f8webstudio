import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CatalogSnapshot, OperatorSpec, ServiceSpec } from '../api/contracts';
import { matchesTemplate, templateKey, type LibraryProvider, type LibraryTemplate } from '../library/types';
import { useOnlineTemplates } from '../library/useOnlineTemplates';

type Spec = OperatorSpec | ServiceSpec;
type SearchEntry = { readonly kind: 'node'; readonly spec: Spec } | { readonly kind: 'template'; readonly template: LibraryTemplate };
type KindFilter = 'all' | 'node' | 'variant' | 'component';

export function NodeQuickSearch({ catalog, services, templates = [], initialTemplate, configureTemplate = false,
  renderTemplate, onlineProvider, localLoading = false, localError, onAdd, onClose }: {
  readonly catalog: CatalogSnapshot | null;
  readonly services: ReadonlySet<string>;
  readonly onAdd: (spec: Spec) => void;
  readonly onClose: () => void;
  readonly templates?: readonly LibraryTemplate[];
  readonly initialTemplate?: LibraryTemplate;
  readonly configureTemplate?: boolean;
  readonly renderTemplate?: (template: LibraryTemplate, configure: boolean, onBack: () => void, onBusy: (busy: boolean) => void) => ReactNode;
  readonly onlineProvider?: LibraryProvider;
  readonly localLoading?: boolean;
  readonly localError?: string | null;
}) {
  const [query, setQuery] = useState(initialTemplate?.name ?? '');
  const [index, setIndex] = useState(0);
  const [filter, setFilter] = useState<KindFilter>('all');
  const [source, setSource] = useState<'all' | 'local' | 'cloud'>('all');
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLElement>(null);
  const [choice, setChoice] = useState<{ template: LibraryTemplate; configure: boolean } | null>(
    initialTemplate ? { template: initialTemplate, configure: configureTemplate } : null);
  const [nodeDetail, setNodeDetail] = useState<Spec | null>(null);
  const [busy, setBusy] = useState(false);
  const previousFocus = useRef(document.activeElement);
  const online = useOnlineTemplates(query, source === 'local' ? undefined : onlineProvider);
  const results = useMemo(() => {
    const keywords = query.toLowerCase().trim().split(/\s+/);
    const specs: readonly Spec[] = [...(catalog?.services ?? []), ...(catalog?.operators ?? [])];
    const nodes: SearchEntry[] = source !== 'cloud' && (filter === 'all' || filter === 'node') ? specs.filter((spec) => !spec.hiddenInPalette && keywords.every((word) =>
      `${spec.label} ${spec.serviceClass} ${spec.specKind === 'operator' ? spec.operatorClass : ''} ${spec.description ?? ''} ${(spec.tags ?? []).join(' ')}`.toLowerCase().includes(word)))
      .map((spec) => ({ kind: 'node', spec })) : [];
    const local: SearchEntry[] = source !== 'cloud' ? templates.filter((item) => matchesTemplate(item, query) && (filter === 'all' || filter === item.kind))
      .map((template) => ({ kind: 'template', template })) : [];
    const remote: SearchEntry[] = source !== 'local' ? online.items.filter((item) => filter === 'all' || filter === item.kind)
      .map((template) => ({ kind: 'template', template })) : [];
    const label = (entry: SearchEntry) => entry.kind === 'node' ? entry.spec.label : entry.template.name;
    return [...[...nodes, ...local].sort((a, b) => label(a).localeCompare(label(b))), ...remote];
  }, [catalog, templates, query, source, filter, online.items]);
  const available = (entry: SearchEntry) => entry.kind === 'template' ? renderTemplate !== undefined :
    entry.spec.specKind === 'service' || entry.spec.serviceClass === 'f8.pystudio' || services.has(entry.spec.serviceClass);
  const choose = (entry: SearchEntry, configure = false) => {
    if (busy || !available(entry)) return;
    setNodeDetail(null);
    if (entry.kind === 'template') setChoice({ template: entry.template, configure });
    else { onClose(); onAdd(entry.spec); }
  };
  useEffect(() => {
    input.current?.focus();
    const previous = previousFocus.current;
    return () => { if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  useEffect(() => { document.getElementById(`quick-node-${index}`)?.scrollIntoView?.({ block: 'nearest' }); }, [index]);
  useEffect(() => { if (choice === null) input.current?.focus(); }, [choice]);
  useEffect(() => { setIndex(0); }, [filter, source]);
  const close = () => { if (!busy) onClose(); };
  const back = () => { setChoice(null); setNodeDetail(null); };
  const showingDetails = choice !== null || nodeDetail !== null;
  return <div className="graph-popup-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section ref={root} tabIndex={-1} className={`node-quick-search ${showingDetails ? 'library-with-details' : ''}`} role="dialog" aria-modal="true" aria-label="Quick node search" onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      else if (event.target === input.current && event.key === 'ArrowDown') { event.preventDefault(); setIndex((value) => Math.max(0, Math.min(value + 1, results.length - 1))); }
      else if (event.target === input.current && event.key === 'ArrowUp') { event.preventDefault(); setIndex((value) => Math.max(0, value - 1)); }
      else if (event.target === input.current && event.key === 'Enter') { event.preventDefault(); const entry = results[index]; if (entry) choose(entry); }
      else if (event.key === 'Tab') {
        event.preventDefault();
        const controls = [...(root.current?.querySelectorAll<HTMLElement>('input:not(:disabled), select:not(:disabled), button:not(:disabled), a[href]') ?? [])];
        const focused = controls.findIndex((control) => control === document.activeElement);
        const next = focused < 0 ? (event.shiftKey ? controls.length - 1 : 0) : (focused + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
        controls[next]?.focus();
      }
      event.stopPropagation();
    }}>
      <div className="history-toolbar"><strong>Add from Library</strong><button className="command-button" disabled={busy} onClick={close}>Close search</button></div>
      <input ref={input} className="plain-input" aria-label="Quick node search" placeholder="Search nodes, variants and components…" disabled={busy}
        value={query} onChange={(event) => { setQuery(event.target.value); setIndex(0); }} />
      <div className="library-filters">
        <div className="segment" aria-label="Library type filters">{(['all', 'node', 'variant', 'component'] as const).map((kind) =>
          <button type="button" key={kind} disabled={busy} aria-pressed={filter === kind} className={filter === kind ? 'selected' : ''}
            onClick={() => setFilter(kind)}>{kind === 'all' ? 'All' : kind === 'node' ? 'Nodes' : kind === 'variant' ? 'Variants' : 'Components'}</button>)}</div>
        {onlineProvider && <label>Source <select aria-label="Library source" value={source} disabled={busy} onChange={(event) => setSource(event.target.value as typeof source)}>
          <option value="all">All sources</option><option value="local">Local</option><option value="cloud">Online</option>
        </select></label>}
      </div>
      <div className="library-search-body">
        <div className="library-search-list">
          {localLoading && source !== 'cloud' && <p role="status">Loading local templates…</p>}
          {localError && source !== 'cloud' && <p role="alert">{localError}</p>}
          <div className="quick-node-results" role="listbox" aria-label="Node types">
            {results.map((entry, i) => <div className="quick-node-entry" key={entry.kind === 'template' ? templateKey(entry.template.reference) : `${entry.spec.serviceClass}:${entry.spec.specKind === 'operator' ? entry.spec.operatorClass : 'service'}`}>
              <button id={`quick-node-${i}`} type="button" role="option" disabled={busy} aria-selected={i === index} aria-disabled={!available(entry)}
                onMouseEnter={() => setIndex(i)} onClick={() => choose(entry)}>
                <strong>{entry.kind === 'template' ? entry.template.name : entry.spec.label}</strong>
                <small>{entry.kind === 'template' ? `${entry.template.kind === 'component' ? 'Component' : 'Variant'} · v${entry.template.reference.version} · ${entry.template.reference.source === 'local' ? 'Local' : `Online · ${entry.template.author?.name ?? entry.template.reference.registryId}`}` :
                  entry.spec.specKind === 'operator' ? `${entry.spec.operatorClass} · ${entry.spec.serviceClass}` : entry.spec.serviceClass}</small>
                {!available(entry) && entry.kind === 'node' && <small>Requires {entry.spec.serviceClass}</small>}
              </button>
              {entry.kind === 'template' && renderTemplate ? <div className="quick-entry-actions">
                <button type="button" disabled={busy} aria-label={`Details for ${entry.template.name}`} onClick={() => choose(entry, true)}>Details</button>
                <button type="button" disabled={busy} aria-label={`Choose version for ${entry.template.name}`} onClick={() => choose(entry, true)}>Versions…</button>
              </div> : entry.kind === 'node' && <button className="quick-entry-info" type="button" disabled={busy} aria-label={`Details for ${entry.spec.label}`}
                onClick={() => { setChoice(null); setNodeDetail(entry.spec); }}>Details</button>}
            </div>)}
            {!results.length && <p>No matching nodes or templates.</p>}
          </div>
          {online.loading && <p role="status">Searching online…</p>}
          {online.error && <p role="alert">Online search: {online.error}</p>}
          {online.cursor && <button className="command-button" disabled={online.loading || busy} onClick={online.loadMore}>More online results</button>}
          <small>↑ ↓ select · Enter add · Esc close</small>
        </div>
        {choice && renderTemplate && <aside className="library-detail" aria-label="Template details">
          {renderTemplate(choice.template, choice.configure, back, setBusy)}
        </aside>}
        {nodeDetail && <aside className="library-detail" aria-label="Node details"><strong>{nodeDetail.label}</strong>
          <p>{nodeDetail.description || 'No description provided.'}</p><small>{nodeDetail.serviceClass}</small>
          <p>{nodeDetail.tags?.join(' · ')}</p><button className="command-button" onClick={back}>Back to search</button>
        </aside>}
      </div>
    </section>
  </div>;
}
