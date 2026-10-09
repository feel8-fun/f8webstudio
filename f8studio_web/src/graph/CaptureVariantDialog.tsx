import { useEffect, useState } from 'react';
import type { AssetRecord, GraphNode, StudioDocument } from '../api/contracts';
import type { VariantSource, VariantSummary } from '../api/contracts.gen';
import { captureProjectVariant, fetchAsset } from '../api/client';
import { ShareStateDialog } from './ShareStateDialog';

export function variantMatchesNode(variant: VariantSummary, node: GraphNode): boolean {
  return variant.nodeKind === node.kind && variant.serviceClass === node.serviceClass &&
    variant.operatorClass === (node.kind === 'operator' ? node.operatorClass : null);
}

export function CaptureVariantDialog({ document, node, updating, variants, source, onClose, onSaved }: {
  readonly document: StudioDocument;
  readonly node: GraphNode;
  readonly updating: boolean;
  readonly variants: readonly VariantSummary[];
  readonly source: VariantSource | undefined;
  readonly onClose: () => void;
  readonly onSaved: (name: string) => void;
}) {
  const choices = variants.filter((variant) => variantMatchesNode(variant, node));
  const [assetId, setAssetId] = useState(updating ? choices.find((variant) => variant.assetId === source?.assetId)?.assetId ?? choices[0]?.assetId ?? '' : '');
  const [asset, setAsset] = useState<AssetRecord | null>(null);
  const [name, setName] = useState(node.name);
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!assetId) return;
    let disposed = false;
    setAsset(null);
    setError(null);
    void fetchAsset(assetId).then((record) => {
      if (disposed) return;
      setAsset(record); setName(record.name); setDescription(record.description); setTags(record.tags.join(', '));
    }, (reason: unknown) => { if (!disposed) setError(reason instanceof Error ? reason.message : 'Cannot load Variant'); });
    return () => { disposed = true; };
  }, [assetId]);
  const title = updating ? 'Update Variant' : 'Save as Variant';
  return <ShareStateDialog title={title} document={document} nodeIds={[node.nodeId]} onClose={onClose}
    disabled={!name.trim() || (updating && asset === null)} onShare={async (excludedStates) => {
      const saved = await captureProjectVariant(document.projectId, {
        nodeId: node.nodeId, expectedGraphRevision: document.graphRevision, expectedLayoutRevision: document.layoutRevision,
        name, description, tags: tags.split(',').map((tag) => tag.trim()).filter(Boolean), excludedStates,
        ...(updating && asset ? { assetId: asset.assetId, expectedVersion: asset.currentVersion } : {}),
      });
      onSaved(saved.name);
    }}>
    <p>Save the customized definition and configuration of <strong>{node.name}</strong>.</p>
    {updating && <label className="field-stack">Variant to update<select aria-label="Variant to update" value={assetId}
      onChange={(event) => setAssetId(event.target.value)}>{choices.map((variant) => <option key={variant.assetId} value={variant.assetId}>{variant.name} · v{variant.currentVersion}</option>)}</select></label>}
    {asset && <p>Saving updates v{asset.currentVersion}. Other node instances keep their current configuration.
      {source?.assetId === asset.assetId && <span> This node was saved from v{source.version}.</span>}</p>}
    <label className="field-stack">Variant name<input aria-label="Variant name" value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label className="field-stack">Description<input aria-label="Variant description" value={description} onChange={(event) => setDescription(event.target.value)} /></label>
    <label className="field-stack">Tags<input aria-label="Variant tags" placeholder="signal, filter" value={tags} onChange={(event) => setTags(event.target.value)} /></label>
    {error && <p role="alert">{error}</p>}
  </ShareStateDialog>;
}
