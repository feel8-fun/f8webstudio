import { useState } from 'react';
import type { CloudAsset } from '../api/contracts.gen';
import { cloudUpdateListing } from './cloudApi';

export function CloudListingEditor({ asset, onSaved, onBusy }: {
  readonly asset: CloudAsset;
  readonly onSaved: (asset: CloudAsset) => void;
  readonly onBusy: (busy: boolean) => void;
}) {
  const [name, setName] = useState(asset.name);
  const [description, setDescription] = useState(asset.description);
  const [tags, setTags] = useState(asset.tags.join(', '));
  const [visibility, setVisibility] = useState(asset.visibility);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  async function save() {
    setBusy(true); onBusy(true); setMessage(null);
    try {
      const updated = await cloudUpdateListing(asset.assetId, {
        name, description, tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean), visibility,
      });
      onSaved(updated);
      setMessage('Cloud listing saved. Content version unchanged.');
    } catch (reason: unknown) {
      console.error('Cloud listing update failed', reason);
      setMessage(reason instanceof Error ? reason.message : 'Cannot update Cloud listing');
    } finally { setBusy(false); onBusy(false); }
  }
  return <details className="cloud-listing-editor">
    <summary>Manage your Cloud listing</summary>
    <p>Change the Cloud name, introduction, tags and visibility here. Edit content in a local draft, then publish an update.</p>
    <label className="field-stack">Cloud name<input className="plain-input" aria-label="Cloud name" disabled={busy} value={name} onChange={(event) => setName(event.target.value)}/></label>
    <label className="field-stack">Cloud introduction<textarea className="plain-input" aria-label="Cloud introduction" disabled={busy} value={description} onChange={(event) => setDescription(event.target.value)}/></label>
    <label className="field-stack">Cloud tags<input className="plain-input" aria-label="Cloud tags" disabled={busy} value={tags} onChange={(event) => setTags(event.target.value)}/></label>
    <label className="field-stack">Visibility<select className="plain-input" aria-label="Cloud visibility" disabled={busy} value={visibility} onChange={(event) => setVisibility(event.target.value as typeof visibility)}>
      <option value="public">Public · visible in Discover</option><option value="private">Private · only you can access</option>
    </select></label>
    <button className="command-button primary" disabled={busy || !name.trim()} onClick={() => void save()}>{busy ? 'Saving…' : 'Save Cloud listing'}</button>
    {message && <p role="status">{message}</p>}
  </details>;
}
