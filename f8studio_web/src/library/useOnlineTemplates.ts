import { useCallback, useEffect, useRef, useState } from 'react';
import { templateKey, type LibraryProvider, type LibraryTemplate } from './types';

/** Online search has its own loading/error state and never gates local results. */
export function useOnlineTemplates(query: string, provider?: LibraryProvider) {
  const [items, setItems] = useState<readonly LibraryTemplate[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const current = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  const search = useCallback(async (next: string | null, controller: AbortController) => {
    if (!provider) return;
    inFlight.current = true; setLoading(true); setError(null);
    try {
      const page = await provider.search(query, next, controller.signal);
      if (controller.signal.aborted) return;
      setItems((previous) => [...new Map([...(next ? previous : []), ...page.items].map((item) => [templateKey(item.reference), item])).values()]);
      setCursor(page.nextCursor);
    } catch (reason: unknown) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Cannot search online templates');
    } finally {
      if (!controller.signal.aborted) { inFlight.current = false; setLoading(false); }
    }
  }, [provider, query]);
  useEffect(() => {
    current.current?.abort();
    const controller = new AbortController(); current.current = controller;
    setItems([]); setCursor(null); setError(null); inFlight.current = false; setLoading(!!provider);
    const timer = setTimeout(() => { void search(null, controller); }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [search, provider]);
  const loadMore = () => {
    if (inFlight.current || !cursor || !current.current) return;
    void search(cursor, current.current);
  };
  return { items, cursor, error, loading, loadMore };
}
