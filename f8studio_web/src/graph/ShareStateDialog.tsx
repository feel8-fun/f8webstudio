import { useCallback, useState, type ReactNode } from 'react';
import type { JsonValue, StudioDocument } from '../api/contracts';
import type { ExcludedState } from '../api/contracts.gen';
import { SettingsDialog } from './SchemaEditor';

function valuePreview(value: JsonValue): string {
  const text = JSON.stringify(value);
  return text.length > 100 ? `${text.slice(0, 100)}…` : text;
}

export function ShareStateDialog({ title, document, nodeIds, children, disabled = false, onClose, onShare }: {
  readonly title: string;
  readonly document: StudioDocument;
  readonly nodeIds?: readonly string[];
  readonly children?: ReactNode;
  readonly disabled?: boolean;
  readonly onClose: () => void;
  readonly onShare: (excluded: readonly ExcludedState[]) => Promise<void>;
}) {
  const [excluded, setExcluded] = useState<readonly ExcludedState[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = nodeIds === undefined ? null : new Set(nodeIds);
  const close = useCallback(() => { if (!pending) onClose(); }, [onClose, pending]);
  const enabled = (nodeId: string): boolean => {
    const node = document.nodes.find((item) => item.nodeId === nodeId);
    return node !== undefined && node.enabled && (node.kind === 'service' ||
      document.nodes.some((item) => item.nodeId === node.serviceId && item.enabled));
  };
  const share = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      await onShare(excluded);
      onClose();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : 'Export failed');
    } finally {
      setPending(false);
    }
  };
  return <SettingsDialog title={title} onClose={close}>
    {children}
    <p>Select saved configuration values to include. Unchanged fields use their defaults, which are included in the node definition.</p>
    {document.nodes.filter((node) => selected === null || selected.has(node.nodeId)).map((node) => <fieldset key={node.nodeId}>
      <legend>{node.name}</legend>
      {(node.spec.stateFields ?? []).map((field) => {
        const input = node.ports.find((port) => port.kind === 'state' && port.direction === 'input' && port.runtimeName === field.name);
        const driven = enabled(node.nodeId) && document.edges.some((edge) => edge.kind === 'state' &&
          edge.toNodeId === node.nodeId && edge.toPortId === input?.portId && enabled(edge.fromNodeId) &&
          (selected === null || selected.has(edge.fromNodeId)));
        const hasSavedValue = Object.hasOwn(node.stateValues, field.name);
        const defaultValue = field.valueSchema.default;
        const usesDefault = !hasSavedValue && defaultValue !== undefined;
        const reason = field.access === 'ro' ? 'Read-only output · not saved' : field.persistent === false ? 'Runtime only · not saved' :
          field.publishable === false || field.redactOnPublish === true ? 'Local only · not published' : driven ? 'Supplied by upstream node' :
          !hasSavedValue && !usesDefault ? 'No configured value or default' : null;
        const omitted = excluded.some((item) => item.nodeId === node.nodeId && item.field === field.name);
        return <label className="schema-dialog-check" key={field.name}>
          <input type="checkbox" aria-label={`${node.name}.${field.name}`} checked={reason === null && (usesDefault || !omitted)}
            disabled={pending || reason !== null || usesDefault} onChange={(event) => setExcluded((previous) => event.target.checked
              ? previous.filter((item) => item.nodeId !== node.nodeId || item.field !== field.name)
              : [...previous, { nodeId: node.nodeId, field: field.name }])} />
          {field.label ?? field.name}{reason !== null ? <small> · {reason}</small> :
            usesDefault && <small> · Default: {valuePreview(defaultValue)} · included in definition</small>}
        </label>;
      })}
    </fieldset>)}
    {error !== null && <p role="alert">{error}</p>}
    <button type="button" className="command-button primary" disabled={pending || disabled} onClick={() => void share()}>
      {pending ? 'Exporting…' : title}
    </button>
  </SettingsDialog>;
}
