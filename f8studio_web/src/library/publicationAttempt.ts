import type { CloudGraphPublishRequest, CloudPublishRequest, ExcludedState } from '../api/contracts.gen';

export type PublicationAttempt =
  | { readonly kind: 'asset'; readonly request: CloudPublishRequest }
  | { readonly kind: 'graph'; readonly request: CloudGraphPublishRequest };

// Store only author options and the saved revision. The server owns the content
// snapshot and credentials; this record lets the browser recover its request ID.
export function publicationAttemptKey(registryId: string, userId: string, localId: string): string {
  return 'f8studio.cloudPublication:' + JSON.stringify([registryId, userId, localId]);
}

export function readPublicationAttempt(key: string): PublicationAttempt | null {
  const stored = localStorage.getItem(key);
  if (stored === null) return null;
  const value: unknown = JSON.parse(stored);
  if (typeof value !== 'object' || value === null || !('kind' in value) || !('request' in value)) {
    throw new Error('Saved publication retry has an invalid format');
  }
  const request = value.request;
  if (typeof request !== 'object' || request === null ||
    !('requestId' in request) || typeof request.requestId !== 'string' || !request.requestId ||
    !('license' in request) || typeof request.license !== 'string' ||
    !('visibility' in request) || (request.visibility !== 'public' && request.visibility !== 'private') ||
    !('changeSummary' in request) || typeof request.changeSummary !== 'string') {
    throw new Error('Saved publication retry has invalid options');
  }
  const options: Pick<CloudPublishRequest, 'requestId' | 'license' | 'visibility' | 'changeSummary'> = { requestId: request.requestId, license: request.license,
    visibility: request.visibility, changeSummary: request.changeSummary };
  if (value.kind === 'asset' && 'localVersion' in request && typeof request.localVersion === 'number' &&
    Number.isSafeInteger(request.localVersion) && request.localVersion > 0) {
    return { kind: 'asset', request: { ...options, localVersion: request.localVersion } };
  }
  if (value.kind === 'graph' &&
    'expectedGraphRevision' in request && typeof request.expectedGraphRevision === 'number' &&
    Number.isSafeInteger(request.expectedGraphRevision) && request.expectedGraphRevision >= 0 &&
    'expectedLayoutRevision' in request && typeof request.expectedLayoutRevision === 'number' &&
    Number.isSafeInteger(request.expectedLayoutRevision) && request.expectedLayoutRevision >= 0) {
    const excludedStates: ExcludedState[]=[];
    if('excludedStates' in request) {
      if(!Array.isArray(request.excludedStates))throw new Error('Saved publication retry has invalid configuration choices');
      const fields:readonly unknown[]=request.excludedStates;
      for(const field of fields) {
        if(typeof field!=='object'||field===null||!('nodeId' in field)||typeof field.nodeId!=='string'||!('field' in field)||typeof field.field!=='string')
          throw new Error('Saved publication retry has invalid configuration choices');
        excludedStates.push({nodeId:field.nodeId,field:field.field});
      }
    }
    return { kind: 'graph', request: { ...options, expectedGraphRevision: request.expectedGraphRevision,
      expectedLayoutRevision: request.expectedLayoutRevision,excludedStates } };
  }
  throw new Error('Saved publication retry has an invalid saved revision');
}

export function savePublicationAttempt(key: string, attempt: PublicationAttempt): void {
  localStorage.setItem(key, JSON.stringify(attempt));
}

export function clearPublicationAttempt(key: string): void {
  localStorage.removeItem(key);
}
