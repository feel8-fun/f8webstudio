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
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  return <ShareStateDialog title="Save selection as component" document={document} nodeIds={nodeIds} onClose={onClose} disabled={!name.trim()}
    onShare={async (excluded) => {
      const asset = await captureProjectComponent(document.projectId, document, name, excluded, nodeIds,
        { description, tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean) });
      onSaved(asset.name);
    }}>
    <label className="field-stack">Component name<input aria-label="Component name" value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label className="field-stack">Description<textarea aria-label="Component description" placeholder="Markdown introduction" value={description} onChange={(event) => setDescription(event.target.value)} /></label>
    <label className="field-stack">Tags<input aria-label="Component tags" placeholder="signal, filter" value={tags} onChange={(event) => setTags(event.target.value)} /></label>
  </ShareStateDialog>;
}
