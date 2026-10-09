import { useEffect, useState } from 'react';
import { studioEvents } from '../api/eventStream';
import { localLibraryProvider } from './localProvider';
import type { LibraryTemplate } from './types';

export function useLocalTemplates() {
  const [templates, setTemplates] = useState<readonly LibraryTemplate[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let current: AbortController | null = null;
    const refresh = () => {
      current?.abort();
      const controller = new AbortController();
      current = controller;
      setLoading(true);
      void localLibraryProvider.search('', null, controller.signal).then((page) => {
        if (!controller.signal.aborted) { setTemplates(page.items); setError(null); setLoading(false); }
      }, (reason: unknown) => {
        if (!controller.signal.aborted) { setError(reason instanceof Error ? reason.message : 'Cannot load local templates'); setLoading(false); }
      });
    };
    refresh();
    const unsubscribe = studioEvents.subscribe((event) => { if (event.type.startsWith('asset.')) refresh(); }, refresh);
    return () => { current?.abort(); unsubscribe(); };
  }, []);
  return { templates, error, loading };
}
