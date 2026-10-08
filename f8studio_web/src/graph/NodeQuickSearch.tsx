import { useEffect, useMemo, useRef, useState } from 'react';
import type { CatalogSnapshot, OperatorSpec, ServiceSpec } from '../api/contracts';

type Spec = OperatorSpec | ServiceSpec;

export function NodeQuickSearch({ catalog, services, onAdd, onClose }: {
  readonly catalog: CatalogSnapshot | null;
  readonly services: ReadonlySet<string>;
  readonly onAdd: (spec: Spec) => void;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const previousFocus = useRef(document.activeElement);
  const results = useMemo(() => {
    const keywords = query.toLowerCase().trim().split(/\s+/);
    const specs: readonly Spec[] = [...(catalog?.services ?? []), ...(catalog?.operators ?? [])];
    return specs.filter((spec) => !spec.hiddenInPalette && keywords.every((word) =>
      `${spec.label} ${spec.serviceClass} ${spec.specKind === 'operator' ? spec.operatorClass : ''} ${spec.description ?? ''} ${(spec.tags ?? []).join(' ')}`.toLowerCase().includes(word)))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [catalog, query]);
  const available = (spec: Spec) => spec.specKind === 'service' || spec.serviceClass === 'f8.pystudio' || services.has(spec.serviceClass);
  const choose = (spec: Spec) => { if (available(spec)) { onClose(); onAdd(spec); } };
  useEffect(() => {
    input.current?.focus();
    const previous = previousFocus.current;
    return () => { if (previous instanceof HTMLElement) previous.focus(); };
  }, []);
  useEffect(() => { document.getElementById(`quick-node-${index}`)?.scrollIntoView?.({ block: 'nearest' }); }, [index]);
  return <div className="graph-popup-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="node-quick-search" role="dialog" aria-modal="true" aria-label="Quick node search" onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      else if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((value) => Math.min(value + 1, results.length - 1)); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((value) => Math.max(0, value - 1)); }
      else if (event.key === 'Enter') { event.preventDefault(); const spec = results[index]; if (spec) choose(spec); }
      else if (event.key === 'Tab') { event.preventDefault(); input.current?.focus(); }
      event.stopPropagation();
    }}>
      <div className="history-toolbar"><strong>Add node</strong><button className="command-button" onClick={onClose}>Close search</button></div>
      <input ref={input} className="plain-input" aria-label="Quick node search" placeholder="Search node types…" value={query} onChange={(event) => { setQuery(event.target.value); setIndex(0); }} />
      <div className="quick-node-results" role="listbox" aria-label="Node types">
        {results.map((spec, i) => <button id={`quick-node-${i}`} key={`${spec.serviceClass}:${spec.specKind === 'operator' ? spec.operatorClass : 'service'}`} type="button" role="option" aria-selected={i === index} aria-disabled={!available(spec)} onMouseEnter={() => setIndex(i)} onClick={() => choose(spec)}>
          <strong>{spec.label}</strong><small>{spec.specKind === 'operator' ? `${spec.operatorClass} · ${spec.serviceClass}` : spec.serviceClass}</small>
          {!available(spec) && <small>Requires {spec.serviceClass}</small>}
        </button>)}
        {!results.length && <p>No matching nodes.</p>}
      </div>
      <small>↑ ↓ select · Enter add · Esc close</small>
    </section>
  </div>;
}
