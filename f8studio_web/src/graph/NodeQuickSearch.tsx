import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { CatalogSnapshot, OperatorSpec, ServiceSpec } from '../api/contracts';
import type { VariantSummary } from '../api/contracts.gen';

type Spec = OperatorSpec | ServiceSpec;

type SearchEntry = { readonly kind: 'node'; readonly spec: Spec } | { readonly kind: 'variant'; readonly variant: VariantSummary };

export function NodeQuickSearch({ catalog, services, variants = [], initialVariant, configureVariant = false, renderVariant, onAdd, onClose }: {
  readonly catalog: CatalogSnapshot | null;
  readonly services: ReadonlySet<string>;
  readonly onAdd: (spec: Spec) => void;
  readonly onClose: () => void;
  readonly variants?: readonly VariantSummary[];
  readonly initialVariant?: VariantSummary;
  readonly configureVariant?: boolean;
  readonly renderVariant?: (variant: VariantSummary, configure: boolean, onBack: () => void, onBusy: (busy: boolean) => void) => ReactNode;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLElement>(null);
  const [choice, setChoice] = useState<{ variant: VariantSummary; configure: boolean } | null>(initialVariant ? { variant: initialVariant, configure: configureVariant } : null);
  const [busy, setBusy] = useState(false);
  const previousFocus = useRef(document.activeElement);
  const results = useMemo(() => {
    const keywords = query.toLowerCase().trim().split(/\s+/);
    const specs: readonly Spec[] = [...(catalog?.services ?? []), ...(catalog?.operators ?? [])];
    const nodes: SearchEntry[] = specs.filter((spec) => !spec.hiddenInPalette && keywords.every((word) =>
      `${spec.label} ${spec.serviceClass} ${spec.specKind === 'operator' ? spec.operatorClass : ''} ${spec.description ?? ''} ${(spec.tags ?? []).join(' ')}`.toLowerCase().includes(word)))
      .map((spec) => ({ kind: 'node', spec }));
    const templates: SearchEntry[] = variants.filter((variant) => keywords.every((word) =>
      `${variant.name} variant ${variant.serviceClass} ${variant.operatorClass ?? ''} ${variant.description} ${variant.tags.join(' ')}`.toLowerCase().includes(word)))
      .map((variant) => ({ kind: 'variant', variant }));
    const label = (entry: SearchEntry) => entry.kind === 'node' ? entry.spec.label : entry.variant.name;
    return [...nodes, ...templates].sort((a, b) => label(a).localeCompare(label(b)));
  }, [catalog, variants, query]);
  const available = (entry: SearchEntry) => entry.kind === 'variant' ? renderVariant !== undefined :
    entry.spec.specKind === 'service' || entry.spec.serviceClass === 'f8.pystudio' || services.has(entry.spec.serviceClass);
  const choose = (entry: SearchEntry) => {
    if (!available(entry)) return;
    if (entry.kind === 'variant') setChoice({ variant: entry.variant, configure: false });
    else { onClose(); onAdd(entry.spec); }
  };
  useEffect(() => {
    input.current?.focus();
    const previous = previousFocus.current;
    return () => { if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  useEffect(() => { document.getElementById(`quick-node-${index}`)?.scrollIntoView?.({ block: 'nearest' }); }, [index]);
  useEffect(() => { if (choice === null) input.current?.focus(); else root.current?.focus(); }, [choice]);
  const close = () => { if (!busy) onClose(); };
  return <div className="graph-popup-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) close(); }}>
    <section ref={root} tabIndex={-1} className="node-quick-search" role="dialog" aria-modal="true" aria-label="Quick node search" onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      else if (event.target === input.current && event.key === 'ArrowDown') { event.preventDefault(); setIndex((value) => Math.max(0, Math.min(value + 1, results.length - 1))); }
      else if (event.target === input.current && event.key === 'ArrowUp') { event.preventDefault(); setIndex((value) => Math.max(0, value - 1)); }
      else if (event.target === input.current && event.key === 'Enter') { event.preventDefault(); const entry = results[index]; if (entry) choose(entry); }
      else if (event.key === 'Tab') {
        event.preventDefault();
        const controls = [...(root.current?.querySelectorAll<HTMLElement>('input:not(:disabled), select:not(:disabled), button:not(:disabled)') ?? [])];
        const focused = controls.findIndex((control) => control === document.activeElement);
        controls[(focused + (event.shiftKey ? -1 : 1) + controls.length) % controls.length]?.focus();
      }
      event.stopPropagation();
    }}>
      <div className="history-toolbar"><strong>Add node</strong><button className="command-button" disabled={busy} onClick={close}>Close search</button></div>
      {choice && renderVariant ? renderVariant(choice.variant, choice.configure, () => { setChoice(null); input.current?.focus(); }, setBusy) : <>
      <input ref={input} className="plain-input" aria-label="Quick node search" placeholder="Search nodes and variants…" value={query} onChange={(event) => { setQuery(event.target.value); setIndex(0); }} />
      <div className="quick-node-results" role="listbox" aria-label="Node types">
        {results.map((entry, i) => <div className="quick-node-entry" key={entry.kind === 'variant' ? entry.variant.assetId : `${entry.spec.serviceClass}:${entry.spec.specKind === 'operator' ? entry.spec.operatorClass : 'service'}`}>
          <button id={`quick-node-${i}`} type="button" role="option" aria-selected={i === index} aria-disabled={!available(entry)} onMouseEnter={() => setIndex(i)} onClick={() => choose(entry)}>
            <strong>{entry.kind === 'variant' ? entry.variant.name : entry.spec.label}</strong>
            <small>{entry.kind === 'variant' ? `Variant · v${entry.variant.currentVersion} · ${entry.variant.operatorClass ?? entry.variant.serviceClass}` :
              entry.spec.specKind === 'operator' ? `${entry.spec.operatorClass} · ${entry.spec.serviceClass}` : entry.spec.serviceClass}</small>
            {!available(entry) && entry.kind === 'node' && <small>Requires {entry.spec.serviceClass}</small>}
          </button>
          {entry.kind === 'variant' && renderVariant && <button className="quick-variant-options" type="button" aria-label={`Choose version for ${entry.variant.name}`}
            onClick={() => setChoice({ variant: entry.variant, configure: true })}>Versions…</button>}
        </div>)}
        {!results.length && <p>No matching nodes.</p>}
      </div>
      <small>↑ ↓ select · Enter add · Esc close</small>
      </>}
    </section>
  </div>;
}
