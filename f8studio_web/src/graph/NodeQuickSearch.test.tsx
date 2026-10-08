import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import type { CatalogSnapshot } from '../api/contracts';
import { NodeQuickSearch } from './NodeQuickSearch';

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
