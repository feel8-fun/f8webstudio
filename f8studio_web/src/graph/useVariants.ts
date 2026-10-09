import { useCallback, useEffect, useState } from 'react';
import { fetchVariants, fetchVariantSources } from '../api/client';
import { studioEvents } from '../api/eventStream';
import type { VariantSource, VariantSummary } from '../api/contracts.gen';

export function useVariants(projectId: string | null, graphRevision: number | undefined) {
  const [variants, setVariants] = useState<readonly VariantSummary[]>([]);
  const [sources, setSources] = useState<readonly VariantSource[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const [catalog, sources] = await Promise.all([fetchVariants(signal),
      projectId === null ? Promise.resolve([]) : fetchVariantSources(projectId, signal)]);
    if (!signal?.aborted) { setVariants(catalog); setSources(sources); setError(null); }
  }, [projectId]);
  useEffect(() => {
    const controller = new AbortController();
    setSources([]);
    const reload = () => {
      void refresh(controller.signal).catch((reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Cannot load Variants');
      });
    };
    reload();
    const unsubscribe = studioEvents.subscribe((event) => {
      if (event.type.startsWith('asset.')) reload();
    }, reload);
    return () => { controller.abort(); unsubscribe(); };
  }, [refresh, graphRevision]);
  return { variants, sources, error, refresh };
}
