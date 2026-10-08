import { useState } from 'react';

export function isActiveJob(state: string): boolean {
  return state === 'queued' || state === 'running';
}

// Dismissal belongs to this browser; execution records remain available to the platform.
export function useHistoryVisibility(key: string) {
  const [dismissed, setDismissed] = useState<readonly string[]>(() => {
    return (localStorage.getItem(key) ?? '').split('\n').filter(Boolean);
  });
  const [closed, updateClosed] = useState(() => localStorage.getItem(`${key}-closed`) === 'true');
  const setClosed = (value: boolean) => {
    localStorage.setItem(`${key}-closed`, String(value));
    updateClosed(value);
  };
  const dismiss = (ids: readonly string[]) => {
    const next = [...new Set([...dismissed, ...ids])];
    localStorage.setItem(key, next.join('\n'));
    setDismissed(next);
  };
  return { dismissed, dismiss, closed, setClosed };
}
