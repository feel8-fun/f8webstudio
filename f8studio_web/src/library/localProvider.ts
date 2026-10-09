import { fetchAssets, fetchAssetVersions, fetchComponentPreview, insertProjectComponent } from '../api/client';
import { localTemplate, matchesTemplate, type LibraryProvider, type TemplateReference } from './types';

function localReference(reference: TemplateReference) {
  if (reference.source !== 'local') throw new Error('An online template requires its Cloud provider');
  return reference;
}

export const localLibraryProvider: LibraryProvider = {
  source: 'local',
  async search(query, _cursor, signal) {
    const assets = await fetchAssets(undefined, signal);
    return { items: assets.filter((asset) => asset.kind === 'component' || asset.kind === 'variant')
      .map(localTemplate).filter((item) => matchesTemplate(item, query)), nextCursor: null };
  },
  async versions(reference, signal) {
    const local = localReference(reference);
    const versions = await fetchAssetVersions(local.assetId, signal);
    return versions.map((version) => ({ reference: { ...local, version: version.version }, createdAt: version.createdAt }));
  },
  async preview(reference, signal) {
    const local = localReference(reference);
    return fetchComponentPreview(local.assetId, local.version, signal);
  },
  async insert(reference, document, request) {
    const local = localReference(reference);
    await insertProjectComponent(document.projectId, { ...request, assetId: local.assetId, version: local.version });
  },
};
