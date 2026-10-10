import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { CatalogSnapshot } from '../api/contracts';
import type { VariantSummary } from '../api/contracts.gen';
import { NodeQuickSearch } from './NodeQuickSearch';
import { localTemplate, type LibraryTemplate } from '../library/types';

afterEach(cleanup);
const catalog = { services: [], operators: [
  { specKind: 'operator', serviceClass: 'f8.pyengine', operatorClass: 'f8.udp_in', label: 'UDP In', tags: ['network'] },
  { specKind: 'operator', serviceClass: 'f8.pystudio', operatorClass: 'f8.patch_hub', label: 'Patch Hub' },
] } as unknown as CatalogSnapshot;

test('focuses search, filters keywords and adds the selected type with Enter', () => {
  const onAdd = vi.fn();
  const onClose = vi.fn();
  render(<NodeQuickSearch catalog={catalog} services={new Set(['f8.pyengine'])} onAdd={onAdd} onClose={onClose} />);
  const input = screen.getByRole('textbox', { name: 'Quick node search' });
  expect(input).toHaveFocus();
  fireEvent.change(input, { target: { value: 'udp network' } });
  expect(screen.getAllByRole('option')).toHaveLength(1);
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onAdd).toHaveBeenCalledWith(catalog.operators[0]);
  expect(onClose).toHaveBeenCalled();
});

test('keeps unavailable operators visible without adding them and supports Escape', () => {
  const onAdd = vi.fn();
  const onClose = vi.fn();
  render(<NodeQuickSearch catalog={catalog} services={new Set()} onAdd={onAdd} onClose={onClose} />);
  const input = screen.getByRole('textbox', { name: 'Quick node search' });
  fireEvent.change(input, { target: { value: 'udp' } });
  expect(screen.getByRole('option')).toHaveAttribute('aria-disabled', 'true');
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onAdd).not.toHaveBeenCalled();
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(onClose).toHaveBeenCalled();
});

const variant: VariantSummary = { assetId: 'v', name: 'Fast UDP', description: 'Customized receiver', tags: ['network'],
  currentVersion: 3, nodeKind: 'operator', serviceClass: 'f8.pyengine', operatorClass: 'f8.udp_in' };
const template = localTemplate(variant);

test('searches node types and variants together and chooses a template with Enter', () => {
  const renderVariant = vi.fn(() => <div>Adding template</div>);
  render(<NodeQuickSearch catalog={catalog} services={new Set(['f8.pyengine'])} templates={[template]}
    renderTemplate={renderVariant} onAdd={vi.fn()} onClose={vi.fn()} />);
  const input = screen.getByRole('textbox', { name: 'Quick node search' });
  fireEvent.change(input, { target: { value: 'udp network' } });
  expect(screen.getAllByRole('option')).toHaveLength(2);
  expect(screen.getByRole('option', { name: /Fast UDP/ })).toHaveTextContent('Variant · v3');
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(renderVariant).toHaveBeenCalledWith(template, false, expect.any(Function), expect.any(Function));
  expect(screen.getByText('Adding template')).toBeInTheDocument();
});

test('opens version options in the same search popup', () => {
  const renderVariant = vi.fn(() => <div>Template options</div>);
  render(<NodeQuickSearch catalog={catalog} services={new Set()} templates={[template]}
    renderTemplate={renderVariant} onAdd={vi.fn()} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose version for Fast UDP' }));
  expect(renderVariant).toHaveBeenCalledWith(template, true, expect.any(Function), expect.any(Function));
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.getByRole('dialog', { name: 'Quick node search' })).toHaveTextContent('Template options');
});

test('searches components by description and tags, filters by kind, and keeps one details window', () => {
  const component: LibraryTemplate = { ...template, kind: 'component', name: 'Signal processing', description: 'Smooth a stream', tags: ['motion'] };
  const details = vi.fn(() => <div>Component preview</div>);
  render(<NodeQuickSearch catalog={catalog} services={new Set()} templates={[component, template]} renderTemplate={details} onAdd={vi.fn()} onClose={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: 'Components' }));
  expect(screen.getAllByRole('option')).toHaveLength(1);
  fireEvent.change(screen.getByRole('textbox', { name: 'Quick node search' }), { target: { value: 'smooth motion' } });
  fireEvent.click(screen.getByRole('button', { name: 'Details for Signal processing' }));
  expect(details).toHaveBeenCalledWith(component, true, expect.any(Function), expect.any(Function));
  expect(screen.getByLabelText('Component details')).toHaveTextContent('Component preview');
  expect(screen.getAllByRole('dialog')).toHaveLength(1);
  expect(screen.queryByLabelText('Library source')).not.toBeInTheDocument();
});
