import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { useOnlineTemplates } from './useOnlineTemplates';
import { templateKey, type LibraryProvider, type LibraryTemplate, type LibraryPage } from './types';
import { localLibraryProvider } from './localProvider';

afterEach(() => { cleanup(); vi.useRealTimers(); });
const template: LibraryTemplate = { kind: 'component', reference: { source: 'cloud', registryId: 'feel8', assetId: 'c', version: 2, contentHash: 'hash' },
  name: 'Smooth', description: '', tags: [] };
const provider = (search: LibraryProvider['search']): LibraryProvider => ({ source: 'cloud', search,
  preview: vi.fn(), versions: vi.fn(), insert: vi.fn() });

test('debounces searches, cancels stale queries, and paginates independently', async () => {
  vi.useFakeTimers();
  let resolveOld!: (page: LibraryPage) => void;
  const search = vi.fn<LibraryProvider['search']>().mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }))
    .mockResolvedValueOnce({ items: [template], nextCursor: 'next' })
    .mockResolvedValueOnce({ items: [template, { ...template, reference: { ...template.reference, assetId: 'd' }, name: 'Second' }], nextCursor: null });
  const online = provider(search);
  const { result, rerender } = renderHook(({ query }) => useOnlineTemplates(query, online), { initialProps: { query: 'old' } });
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  const signal = search.mock.calls[0]![2];
  rerender({ query: 'new' });
  expect(signal.aborted).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(result.current.items.map((item) => item.name)).toEqual(['Smooth']);
  await act(async () => { resolveOld({ items: [{ ...template, name: 'Stale' }], nextCursor: null }); });
  expect(result.current.items[0]!.name).toBe('Smooth');
  await act(async () => { result.current.loadMore(); result.current.loadMore(); });
  expect(search).toHaveBeenCalledTimes(3);
  expect(search.mock.calls[2]!.slice(0, 2)).toEqual(['new', 'next']);
  expect(result.current.items.map((item) => item.name)).toEqual(['Smooth', 'Second']);
  expect(result.current.cursor).toBeNull();
});

test('reports network errors without a local dependency and makes no requests without a provider', async () => {
  vi.useFakeTimers();
  const search = vi.fn<LibraryProvider['search']>().mockRejectedValue(new Error('Offline'));
  const online = provider(search);
  const { result, rerender } = renderHook(({ active }: { active: LibraryProvider | undefined }) => useOnlineTemplates('smooth', active), { initialProps: { active: online as LibraryProvider | undefined } });
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(result.current.error).toBe('Offline');
  rerender({ active: undefined });
  await act(async () => { await vi.advanceTimersByTimeAsync(250); });
  expect(result.current.error).toBeNull();
  expect(result.current.loading).toBe(false);
  expect(search).toHaveBeenCalledTimes(1);
});

test('separates registry identities and rejects Cloud references on local routes', async () => {
  expect(templateKey(template.reference)).not.toBe(templateKey({ source: 'local', assetId: 'c', version: 2 }));
  if (template.reference.source !== 'cloud') throw new Error('Expected online fixture');
  expect(templateKey(template.reference)).not.toBe(templateKey({ ...template.reference, registryId: 'other' }));
  await expect(localLibraryProvider.preview(template.reference, new AbortController().signal)).rejects.toThrow('Cloud provider');
});
