import { cloudSearch, cloudVersions, cloudPreview, cloudInsert } from './cloudApi';
import type { CloudAsset } from '../api/contracts.gen';
import type { LibraryTemplate, LibraryProvider, TemplateReference } from './types';
function cloudReference(reference:TemplateReference) {
  if (reference.source !== 'cloud') throw new Error('A local template requires its local provider');
  return {registryId:reference.registryId,assetId:reference.assetId,version:reference.version,contentHash:reference.contentHash};
}
export function cloudTemplate(asset:CloudAsset,registryId:string):LibraryTemplate {
  if (asset.kind === 'graph') throw new Error('Graphs open as projects');
  return {reference:{source:'cloud',registryId,assetId:asset.assetId,version:asset.version,contentHash:asset.contentHash},
    kind:asset.kind,name:asset.name,description:asset.description,tags:asset.tags,author:asset.author,license:asset.license};
}
export function createCloudProvider(registryId:string):LibraryProvider {
  return {
    source:'cloud',
    async search(query,cursor,signal) {
      const page = await cloudSearch(query,cursor,signal);
      return {items:page.items.filter((asset)=>asset.kind!=='graph').map((asset)=>cloudTemplate(asset,registryId)),nextCursor:page.nextCursor};
    },
    async versions(reference,signal) {
      const ref=cloudReference(reference);
      return (await cloudVersions(ref.assetId,signal)).map((v)=>({reference:{source:'cloud' as const,...ref,version:v.version,contentHash:v.contentHash},createdAt:v.createdAt,note:v.note}));
    },
    async preview(reference,signal) { return cloudPreview(cloudReference(reference),signal); },
    async insert(reference,document,request) { await cloudInsert(document.projectId,{...request,reference:cloudReference(reference)}); },
  };
}
