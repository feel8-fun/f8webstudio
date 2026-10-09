import type { AssetSummary, StudioDocument } from '../api/contracts';
import type { ComponentPreview, InsertComponentRequestInput, VariantSummary } from '../api/contracts.gen';

export type TemplateKind = 'component' | 'variant';
export type TemplateReference =
  | { readonly source: 'local'; readonly assetId: string; readonly version: number }
  | { readonly source: 'cloud'; readonly registryId: string; readonly assetId: string; readonly version: number; readonly contentHash: string };

export interface LibraryTemplate {
  readonly reference: TemplateReference;
  readonly kind: TemplateKind;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly author?: { readonly id: string; readonly name: string };
  readonly license?: string;
}

export interface LibraryVersion { readonly reference: TemplateReference; readonly createdAt: string; readonly note?: string }
export interface LibraryPage { readonly items: readonly LibraryTemplate[]; readonly nextCursor: string | null }

/** Cloud adapters call Studio Server; remote IDs never go through local asset routes. */
export interface LibraryProvider {
  readonly source: 'local' | 'cloud';
  search(query: string, cursor: string | null, signal: AbortSignal): Promise<LibraryPage>;
  versions(reference: TemplateReference, signal: AbortSignal): Promise<readonly LibraryVersion[]>;
  preview(reference: TemplateReference, signal: AbortSignal): Promise<ComponentPreview>;
  insert(reference: TemplateReference, document: StudioDocument,
    request: Omit<InsertComponentRequestInput, 'assetId' | 'version'>): Promise<void>;
}

export function templateKey(reference: TemplateReference): string {
  return reference.source === 'local' ? JSON.stringify(['local', reference.assetId]) :
    JSON.stringify(['cloud', reference.registryId, reference.assetId]);
}

export function localTemplate(asset: AssetSummary | VariantSummary): LibraryTemplate {
  return { reference: { source: 'local', assetId: asset.assetId, version: asset.currentVersion },
    kind: 'kind' in asset && asset.kind === 'component' ? 'component' : 'variant',
    name: asset.name, description: asset.description, tags: asset.tags };
}

export function matchesTemplate(template: LibraryTemplate, query: string): boolean {
  const haystack = `${template.name} ${template.kind} ${template.description} ${template.tags.join(' ')} ${template.author?.name ?? ''}`.toLowerCase();
  return query.toLowerCase().trim().split(/\s+/).every((word) => haystack.includes(word));
}
