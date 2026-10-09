import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';

import type { CatalogSnapshot } from '../api/contracts';
import { NodeCatalog } from './NodeCatalog';
import type { VariantSummary } from '../api/contracts.gen';
import type { LibraryTemplate } from '../library/types';

afterEach(cleanup);

const catalog: CatalogSnapshot = {
  services: [
    { specKind: 'service', serviceClass: 'test.engine', label: 'Engine' },
    { specKind: 'service', serviceClass: 'f8.pystudio', label: 'Studio' },
  ],
  operators: [
    { specKind: 'operator', serviceClass: 'test.engine', operatorClass: 'test.filter', label: 'Filter', paletteCategory: 'test.engine.signal' },
    { specKind: 'operator', serviceClass: 'test.engine', operatorClass: 'test.capture', label: 'Capture', paletteCategory: 'test.engine.input' },
    { specKind: 'operator', serviceClass: 'f8.pystudio', operatorClass: 'f8.viz.video', label: 'Video', paletteCategory: 'viz' },
  ],
};

test('groups operators by service or category and expands search matches', () => {
  const onAdd = vi.fn();
  const onRefresh = vi.fn();
  render(<NodeCatalog catalog={catalog} projectServiceClasses={new Set(['test.engine'])} canAdd refreshing={false}
    onAdd={onAdd} onRefresh={onRefresh} />);
  expect(screen.getByText('Engine', { selector: 'summary span' })).toBeInTheDocument();
  expect(screen.getByText('Studio', { selector: 'summary span' })).toBeInTheDocument();

  fireEvent.click(screen.getByRole('tab', { name: 'Category' }));
  expect(screen.getByText('Signal', { selector: 'summary span' })).toBeInTheDocument();
  expect(screen.getByText('Inputs', { selector: 'summary span' })).toBeInTheDocument();

  fireEvent.change(screen.getByLabelText('Search nodes'), { target: { value: 'Filter' } });
  fireEvent.click(screen.getByRole('button', { name: /Filter/ }));
  expect(onAdd).toHaveBeenCalledWith(catalog.operators[0]);
  fireEvent.click(screen.getByRole('button', { name: 'Refresh node catalog' }));
  expect(onRefresh).toHaveBeenCalledOnce();
});

test('finds components by keywords and offers direct addition or details', () => {
  const component: LibraryTemplate = { kind: 'component', reference: { source: 'local', assetId: 'c', version: 2 },
    name: 'Motion pipeline', description: 'Smooth stream', tags: ['filter'] };
  const add = vi.fn();
  render(<NodeCatalog catalog={catalog} projectServiceClasses={new Set()} canAdd refreshing={false}
    components={[component]} onAddComponent={add} onAdd={vi.fn()} onRefresh={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Search nodes'), { target: { value: 'smooth filter' } });
  fireEvent.click(screen.getByRole('button', { name: /Motion pipeline.*Component/ }));
  expect(add).toHaveBeenCalledWith(component);
  fireEvent.click(screen.getByRole('button', { name: 'Details for Motion pipeline' }));
  expect(add).toHaveBeenCalledWith(component, true);
});

test('places service and operator variants under their types and finds variants by name', () => {
  const variants: readonly VariantSummary[] = [
    { assetId: 's', name: 'Configured Engine', description: '', tags: [], currentVersion: 1, nodeKind: 'service', serviceClass: 'test.engine', operatorClass: null },
    { assetId: 'o', name: 'Soft Filter', description: '', tags: [], currentVersion: 2, nodeKind: 'operator', serviceClass: 'test.engine', operatorClass: 'test.filter' },
  ];
  const add = vi.fn();
  render(<NodeCatalog catalog={catalog} projectServiceClasses={new Set(['test.engine'])} canAdd refreshing={false}
    variants={variants} onAddVariant={add} onAdd={vi.fn()} onRefresh={vi.fn()} />);
  const engine = screen.getByRole('button', { name: /Engine.*test.engine/ }).closest('.catalog-type');
  if (!(engine instanceof HTMLElement)) throw new Error('Missing Engine type');
  expect(within(engine).getByText('Configured Engine')).toBeInTheDocument();
  expect(within(engine).queryByText('Soft Filter')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Search nodes'), { target: { value: 'Soft' } });
  fireEvent.click(screen.getByRole('button', { name: /Soft Filter.*Variant · v2/ }));
  expect(add).toHaveBeenCalledWith(variants[1]);
  fireEvent.click(screen.getByRole('button', { name: 'Choose version for Soft Filter' }));
  expect(add).toHaveBeenCalledWith(variants[1], true);
  expect(screen.queryByText('Configured Engine')).not.toBeInTheDocument();
});
