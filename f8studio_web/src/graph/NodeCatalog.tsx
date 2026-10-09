import { ChevronDown, RefreshCw, Search } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';

import type { CatalogSnapshot, OperatorSpec, ServiceSpec } from '../api/contracts';
import type { VariantSummary } from '../api/contracts.gen';

type CatalogSpec = ServiceSpec | OperatorSpec;
type GroupMode = 'service' | 'category';

interface CatalogGroup {
  readonly key: string;
  readonly label: string;
  readonly specs: readonly OperatorSpec[];
}

const CATEGORY_LABELS: Readonly<Record<string, string>> = {
  canvas: 'Canvas', control: 'Controls', debug: 'Debug', execution: 'Execution',
  expr: 'Expressions', flow: 'Flow', input: 'Inputs', motion: 'Motion',
  output: 'Outputs', routing: 'Routing', signal: 'Signal', viz: 'Visualization',
};

function categoryLabel(category: string): string {
  const suffix = category.split('.').at(-1) ?? category;
  return CATEGORY_LABELS[suffix] ?? suffix.replaceAll('_', ' ');
}

function variantBelongsTo(variant: VariantSummary, spec: CatalogSpec): boolean {
  return variant.serviceClass === spec.serviceClass && ('operatorClass' in spec
    ? variant.nodeKind === 'operator' && variant.operatorClass === spec.operatorClass : variant.nodeKind === 'service');
}

function operatorGroups(operators: readonly OperatorSpec[], services: readonly ServiceSpec[], mode: GroupMode): readonly CatalogGroup[] {
  const serviceLabels = new Map(services.map((service) => [service.serviceClass, service.label]));
  const groups = new Map<string, OperatorSpec[]>();
  for (const operator of operators) {
    const key = mode === 'service' ? operator.serviceClass : (operator.paletteCategory || 'other').split('.').at(-1) ?? 'other';
    const members = groups.get(key) ?? [];
    members.push(operator);
    groups.set(key, members);
  }
  return [...groups.entries()].map(([key, specs]) => ({
    key,
    label: mode === 'service' ? serviceLabels.get(key) ?? key : categoryLabel(key),
    specs: [...specs].sort((left, right) => left.label.localeCompare(right.label)),
  })).sort((left, right) => left.label.localeCompare(right.label));
}

function CatalogFold({ label, count, initiallyOpen, children }: {
  readonly label: string;
  readonly count: number;
  readonly initiallyOpen: boolean;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return <details className="catalog-group" open={open}>
    <summary onClick={(event) => { event.preventDefault(); setOpen((current) => !current); }}>
      <ChevronDown size={13} /><span>{label}</span><small>{count}</small>
    </summary>
    {children}
  </details>;
}

export function NodeCatalog({ catalog, projectServiceClasses, canAdd, refreshing, onAdd, onRefresh, variants = [], onAddVariant }: {
  readonly catalog: CatalogSnapshot | null;
  readonly projectServiceClasses: ReadonlySet<string>;
  readonly canAdd: boolean;
  readonly refreshing: boolean;
  readonly onAdd: (spec: CatalogSpec) => void;
  readonly onRefresh: () => void;
  readonly variants?: readonly VariantSummary[];
  readonly onAddVariant?: (variant: VariantSummary, configure?: boolean) => void;
}) {
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<GroupMode>('service');
  const normalizedQuery = query.trim().toLowerCase();
  const serviceLabels = useMemo(() => new Map((catalog?.services ?? []).map((service) => [service.serviceClass, service.label])), [catalog]);
  const matchingVariants = useMemo(() => variants.filter((variant) =>
    `${variant.name} ${variant.description} ${variant.serviceClass} ${variant.operatorClass ?? ''} ${variant.tags.join(' ')}`.toLowerCase().includes(normalizedQuery)), [variants, normalizedQuery]);
  const services = useMemo(() => (catalog?.services ?? []).filter((spec) => !spec.hiddenInPalette &&
    (`${spec.label} ${spec.serviceClass} ${(spec.tags ?? []).join(' ')}`.toLowerCase().includes(normalizedQuery) ||
      matchingVariants.some((variant) => variantBelongsTo(variant, spec)))), [catalog, normalizedQuery, matchingVariants]);
  const operators = useMemo(() => (catalog?.operators ?? []).filter((spec) => !spec.hiddenInPalette &&
    (`${spec.label} ${spec.operatorClass} ${spec.serviceClass} ${serviceLabels.get(spec.serviceClass) ?? ''} ${spec.paletteCategory ?? ''} ${(spec.tags ?? []).join(' ')}`.toLowerCase().includes(normalizedQuery) ||
      matchingVariants.some((variant) => variantBelongsTo(variant, spec)))), [catalog, normalizedQuery, serviceLabels, matchingVariants]);
  const groups = useMemo(() => operatorGroups(operators, catalog?.services ?? [], mode), [operators, catalog, mode]);

  const variantButtons = (items: readonly VariantSummary[]) => items.map((variant) => <div className="catalog-variant" key={variant.assetId}>
    <button type="button" disabled={!canAdd || !onAddVariant} onClick={() => onAddVariant?.(variant)} title={variant.description}>
      <strong>{variant.name}</strong><span>Variant · v{variant.currentVersion}</span>
    </button>
    <button className="catalog-variant-versions" type="button" disabled={!canAdd || !onAddVariant}
      aria-label={`Choose version for ${variant.name}`} onClick={() => onAddVariant?.(variant, true)}>Versions…</button>
  </div>);
  const specEntry = (spec: CatalogSpec) => {
    const available = !('operatorClass' in spec) || projectServiceClasses.has(spec.serviceClass) || spec.serviceClass === 'f8.pystudio';
    const owned = variants.filter((variant) => variantBelongsTo(variant, spec));
    const filtered = owned.filter((variant) => matchingVariants.includes(variant));
    const shown = filtered.length > 0 ? filtered : owned;
    return <div className="catalog-type" key={`${spec.serviceClass}:${'operatorClass' in spec ? spec.operatorClass : 'service'}`}>
      <button type="button" disabled={!canAdd || !available}
      title={available ? spec.description : `Requires ${spec.serviceClass}`} onClick={() => onAdd(spec)}>
        <strong>{spec.label}</strong><span>{'operatorClass' in spec ? spec.operatorClass : spec.serviceClass}</span>
      </button>
      {owned.length > 0 && <details className="catalog-variants" key={normalizedQuery} open={normalizedQuery !== '' || undefined}>
        <summary><ChevronDown size={12} /><span>Variants</span><small>{shown.length}</small></summary>{variantButtons(shown)}
      </details>}
    </div>;
  };
  const unlisted = matchingVariants.filter((variant) => ![...(catalog?.services ?? []), ...(catalog?.operators ?? [])]
    .some((spec) => !spec.hiddenInPalette && variantBelongsTo(variant, spec)));

  return <>
    <div className="catalog-search-row"><label className="catalog-search"><Search size={15} />
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search nodes" aria-label="Search nodes" />
    </label><button type="button" className="small-icon-button" title="Refresh node catalog" aria-label="Refresh node catalog"
      disabled={refreshing} onClick={onRefresh}><RefreshCw size={15} /></button></div>
    <div className="catalog-mode segment" role="tablist" aria-label="Group operators by">
      <button type="button" role="tab" aria-selected={mode === 'service'} className={mode === 'service' ? 'selected' : ''} onClick={() => setMode('service')}>Service</button>
      <button type="button" role="tab" aria-selected={mode === 'category'} className={mode === 'category' ? 'selected' : ''} onClick={() => setMode('category')}>Category</button>
    </div>
    <div className="catalog-list">
      <CatalogFold label="Services" count={services.length} initiallyOpen key={`services:${normalizedQuery !== ''}`}>
        {services.map(specEntry)}
      </CatalogFold>
      <h2>Operators</h2>
      {groups.map((group) => <CatalogFold label={group.label} count={group.specs.length} key={`${mode}:${group.key}:${normalizedQuery !== ''}`}
        initiallyOpen={normalizedQuery !== ''}>
        {group.specs.map(specEntry)}
      </CatalogFold>)}
      {groups.length === 0 && <p className="catalog-empty">No matching operators</p>}
      {unlisted.length > 0 && <CatalogFold label="Other Variants" count={unlisted.length} initiallyOpen>{variantButtons(unlisted)}</CatalogFold>}
    </div>
  </>;
}
