import { requestJson } from '../api/client';
import type * as Wire from '../api/contracts.gen';
const id = encodeURIComponent;
async function read<T>(path: string, signal?: AbortSignal): Promise<T> { return await requestJson(path,{signal}) as T; }
async function write<T>(path:string,body:unknown,signal?:AbortSignal,method='POST'):Promise<T> {
  return await requestJson(path,{method,body:JSON.stringify(body),headers:{'Content-Type':'application/json'},signal}) as T;
}
export async function cloudStatus(signal?:AbortSignal):Promise<Wire.CloudStatus> {
  const value = await read<Wire.CloudStatus>('/api/cloud/status',signal);
  if (typeof value.configured !== 'boolean' || typeof value.registryId !== 'string') throw new Error('Invalid Cloud status response');
  return value;
}
export const configureCloud = (baseUrl:string) => write<Wire.CloudStatus>('/api/cloud/settings',{baseUrl},undefined,'PUT');
export const loginCloud = () => write<Wire.CloudLoginStart>('/api/cloud/auth/start',undefined);
export const logoutCloud = () => write<Wire.CloudStatus>('/api/cloud/auth/logout',undefined);
export type CloudKindFilter = Wire.CloudAsset['kind'] | 'all';
export const cloudSearch = (q:string,cursor:string|null,signal:AbortSignal,view='all',kind:CloudKindFilter='all') =>
  read<Wire.CloudPage>('/api/cloud/library?'+new URLSearchParams({q,cursor:cursor??'',view,kind}),signal);
export const cloudVersions = (assetId:string,signal:AbortSignal) => read<readonly Wire.CloudVersion[]>(`/api/cloud/library/${id(assetId)}/versions`,signal);
export const cloudPreview = (reference:Wire.CloudReference,signal:AbortSignal) => write<Wire.ComponentPreview>('/api/cloud/templates:preview',reference,signal);
export const cloudGraphPreview = (reference:Wire.CloudReference,signal:AbortSignal) => write<Wire.CloudGraphPreview>('/api/cloud/graphs:preview',reference,signal);
export const cloudOpenGraph = (reference:Wire.CloudReference,name:string) => write<Wire.ProjectRecord>('/api/cloud/graphs:open',{reference,name});
export const cloudInsert = (projectId:string,input:Wire.InsertCloudComponentRequestInput) => write<Wire.InsertComponentResult>(`/api/projects/${id(projectId)}/cloud:insert`,input);
export const cloudDraft = (reference:Wire.CloudReference) => write<Wire.AssetRecord>('/api/cloud/drafts',reference);
export const cloudDraftLinks = (signal?:AbortSignal) => read<readonly Wire.CloudDraftLink[]>('/api/cloud/drafts',signal);
export const cloudUpdateListing = (assetId:string,input:Wire.CloudMetadataRequestInput) => write<Wire.CloudAsset>(`/api/cloud/library/${id(assetId)}/metadata`,input,undefined,'PUT');
export const cloudDeletePublication = (assetId:string) => write<Wire.CloudAssetDeletion>(`/api/cloud/library/${id(assetId)}`,undefined,undefined,'DELETE');
export const cloudDraftLink = (assetId:string,signal?:AbortSignal) => read<Wire.CloudDraftLink|null>(`/api/assets/${id(assetId)}/cloud`,signal);
export const cloudProjectLink = (projectId:string,signal?:AbortSignal) => read<Wire.CloudDraftLink|null>(`/api/projects/${id(projectId)}/cloud`,signal);
export const cloudPublish = (assetId:string,input:Wire.CloudPublishRequestInput) => write<Wire.CloudPublicationResult>(`/api/assets/${id(assetId)}/cloud:publish`,input);
export const cloudMetadata = (assetId:string,input:Wire.CloudMetadataRequestInput) => write<Wire.CloudAsset>(`/api/assets/${id(assetId)}/cloud:metadata`,input,undefined,'PUT');
export const cloudProjectMetadata = (projectId:string,input:Wire.CloudMetadataRequestInput) => write<Wire.CloudAsset>(`/api/projects/${id(projectId)}/cloud:metadata`,input,undefined,'PUT');
export const cloudPublishGraph = (projectId:string,input:Wire.CloudGraphPublishRequestInput) => write<Wire.CloudPublicationResult>(`/api/projects/${id(projectId)}/cloud:publish`,input);
export const cloudRelations = (assetId:string,signal?:AbortSignal) => read<Wire.CloudRelations>(`/api/cloud/library/${id(assetId)}/relations`,signal);
export const cloudRelate = (assetId:string,action:'like'|'follow'|'follow-author',enabled:boolean) => write<Wire.CloudRelations>(`/api/cloud/library/${id(assetId)}/relations/${action}`,undefined,undefined,enabled?'PUT':'DELETE');
