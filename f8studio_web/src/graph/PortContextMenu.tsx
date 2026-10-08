import { useEffect, useRef, useState } from 'react';
import type { GraphNode, GraphPort } from '../api/contracts';
import { canPastePortType, copyPortType, type CopiedPortType } from './portType';

export interface PortMenuTarget {
  readonly node: GraphNode;
  readonly port: GraphPort;
  readonly x: number;
  readonly y: number;
}

export function PortContextMenu({ target, copied, busy, onCopy, onPaste, onClose }: {
  readonly target: PortMenuTarget;
  readonly copied: CopiedPortType | null;
  readonly busy: boolean;
  readonly onCopy: (value: CopiedPortType) => void;
  readonly onPaste: () => void;
  readonly onClose: () => void;
}) {
  const [details, setDetails] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const previousFocus = useRef(document.activeElement);
  const type = copyPortType(target.port);
  const definition = target.port.dataSpec ?? target.port.stateSpec ?? (target.node.spec.specKind === 'operator' && target.port.kind === 'exec'
    ? (target.port.direction === 'input' ? target.node.spec.execInPorts : target.node.spec.execOutPorts)?.find((port) => port.name === target.port.runtimeName)
    : target.port.kind === 'command' ? target.node.spec.commands?.find((command) => command.name === target.port.runtimeName) : null) ?? target.port;
  useEffect(() => {
    root.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const previous = previousFocus.current;
    const dismiss = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) onClose(); };
    document.addEventListener('pointerdown', dismiss);
    return () => { document.removeEventListener('pointerdown', dismiss); if (previous instanceof HTMLElement) previous.focus(); };
  }, [onClose]);
  return <div ref={root} className="port-context-popup" style={{ left: Math.max(8, Math.min(target.x, window.innerWidth - (details ? 460 : 250))), top: Math.max(8, Math.min(target.y, window.innerHeight - (details ? 420 : 180))) }} onKeyDown={(event) => {
    if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    if (event.key === 'Tab' || event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const buttons = [...(root.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      const index = buttons.findIndex((button) => button === document.activeElement);
      buttons[(index + (event.shiftKey || event.key === 'ArrowUp' ? -1 : 1) + buttons.length) % buttons.length]?.focus();
    }
    event.stopPropagation();
  }}>
    <strong>{target.node.name} · {target.port.name}</strong>
    <div role="menu" aria-label="Port actions">
      <button role="menuitem" onClick={() => setDetails(!details)}>{details ? 'Hide port definition' : 'View port definition / schema'}</button>
      <button role="menuitem" disabled={!type} onClick={() => { if (type) onCopy(type); }}>Copy data type</button>
      <button role="menuitem" disabled={busy || !canPastePortType(target.node, target.port, copied)} title={!canPastePortType(target.node, target.port, copied) ? 'Requires a compatible copied type and an editable port definition' : undefined} onClick={onPaste}>Paste data type</button>
      <button role="menuitem" onClick={onClose}>Close menu</button>
    </div>
    {details && <section aria-label="Port definition"><small>{target.port.kind} · {target.port.direction} · {target.port.runtimeName}</small><pre>{JSON.stringify(definition, null, 2)}</pre></section>}
  </div>;
}
