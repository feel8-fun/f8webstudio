export type LibraryKindFilter = 'all' | 'graph' | 'component' | 'variant';

const filters: readonly { kind: LibraryKindFilter; label: string }[] = [
  { kind: 'all', label: 'All' }, { kind: 'graph', label: 'Graphs' },
  { kind: 'component', label: 'Components' }, { kind: 'variant', label: 'Variants' },
];

export function LibraryKindFilters({ value, onChange, label, disabled = false }: {
  readonly value: LibraryKindFilter;
  readonly onChange: (kind: LibraryKindFilter) => void;
  readonly label: string;
  readonly disabled?: boolean;
}) {
  return <div className="library-kind-filters" role="group" aria-label={label}>
    {filters.map((filter) => <button key={filter.kind} aria-pressed={value === filter.kind}
      disabled={disabled} onClick={() => onChange(filter.kind)}>{filter.label}</button>)}
  </div>;
}
