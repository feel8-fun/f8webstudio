import { useState } from 'react';
import type { StudioDocument } from '../api/contracts';
import { captureProjectComponent } from '../api/client';
import { ShareStateDialog } from './ShareStateDialog';

export function CaptureComponentDialog({ document, nodeIds, onClose, onSaved }: {
  readonly document: StudioDocument;
  readonly nodeIds: readonly string[];
  readonly onClose: () => void;
  readonly onSaved: (name: string) => void;
}) {
  const [name, setName] = useState(nodeIds.length === 1 ? document.nodes.find((node) => node.nodeId === nodeIds[0])?.name ?? 'Component' : 'Component');
  return <ShareStateDialog title="Save selection as component" document={document} nodeIds={nodeIds} onClose={onClose}
    onShare={async (excluded) => {
      const asset = await captureProjectComponent(document.projectId, document, name, excluded, nodeIds);
      onSaved(asset.name);
    }}>
    <label className="field-stack">Component name<input aria-label="Component name" value={name} onChange={(event) => setName(event.target.value)} /></label>
  </ShareStateDialog>;
}
