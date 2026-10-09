import { useEffect, useRef } from 'react';
import type { GraphNode } from '../api/contracts';

export interface NodeMenuTarget {
  readonly node: GraphNode | null;
  readonly x: number;
  readonly y: number;
}

export function NodeContextMenu({ target, busy, hasSource, canSaveVariant, canUpdateVariant, canCapture, onSaveVariant,
  onUpdateVariant, onCapture, onAddNode, onClose }: {
  readonly target: NodeMenuTarget;
  readonly busy: boolean;
  readonly hasSource: boolean;
  readonly canSaveVariant: boolean;
  readonly canUpdateVariant: boolean;
  readonly canCapture: boolean;
  readonly onSaveVariant: () => void;
  readonly onUpdateVariant: () => void;
  readonly onCapture: () => void;
  readonly onAddNode: () => void;
  readonly onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const previousFocus = useRef(document.activeElement);
  useEffect(() => {
    root.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    const previous = previousFocus.current;
    const dismiss = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) onClose(); };
    document.addEventListener('pointerdown', dismiss);
    return () => { document.removeEventListener('pointerdown', dismiss); if (previous instanceof HTMLElement) previous.focus(); };
  }, [onClose]);
  return <div ref={root} className="port-context-popup" style={{ left: Math.max(8, Math.min(target.x, window.innerWidth - 260)),
    top: Math.max(8, Math.min(target.y, window.innerHeight - 240)) }} onContextMenu={(event) => event.preventDefault()}
    onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); }
      if (event.key === 'Tab' || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
        const index = buttons.findIndex((button) => button === document.activeElement);
        buttons[(index + (event.shiftKey || event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus();
      }
      event.stopPropagation();
    }}>
    <strong>{target.node?.name ?? 'Graph canvas'}</strong>
    <div role="menu" aria-label={target.node ? 'Node actions' : 'Canvas actions'}>
      {target.node && <>
        <button role="menuitem" disabled={busy || !canSaveVariant} onClick={onSaveVariant}>{hasSource ? 'Save as new Variant…' : 'Save as Variant…'}</button>
        <button role="menuitem" disabled={busy || !canUpdateVariant} onClick={onUpdateVariant}>Update Variant…</button>
      </>}
      <button role="menuitem" disabled={busy || !canCapture} onClick={onCapture}>Save selection as Component…</button>
      <button role="menuitem" disabled={busy} onClick={onAddNode}>Add node…</button>
      <button role="menuitem" onClick={onClose}>Close menu</button>
    </div>
  </div>;
}
