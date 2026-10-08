import type { ComponentPublication, GraphPublication, JsonValue } from '../api/contracts.gen';
import { canonicalPublicationBytes, scalarOrder } from './canonical';

/** Input is the normalized output contract, validated against publication.gen.json. */
export function publicationHashBytes(publication: GraphPublication | ComponentPublication): Uint8Array {
  const { metadata: _localMetadata, ...graphContent } = publication.kind === 'graph'
    ? publication.content : { metadata: null, ...publication.content };
  const source = publication.kind === 'graph' ? graphContent : publication.content;
  const content = {
    ...source,
    connections: [...source.connections].sort((a, b) => scalarOrder(a.edgeId, b.edgeId)),
    presentation: { ...source.presentation, layout: [...source.presentation.layout].sort((a, b) => scalarOrder(a.nodeId, b.nodeId)) },
    ...('hostBindings' in source ? {
      hostBindings: [...source.hostBindings].sort((a, b) => scalarOrder(a.bindingId, b.bindingId)),
      endpoints: [...source.endpoints].sort((a, b) => scalarOrder(a.endpointId, b.endpointId)),
    } : {}),
  };
  const manifest = { ...publication.manifest, dependencies: [...publication.manifest.dependencies]
    .sort((a, b) => scalarOrder(a.extensionId, b.extensionId)).map((dependency) => ({ ...dependency,
      compatibleVersions: [...dependency.compatibleVersions].sort(scalarOrder),
      serviceClasses: [...dependency.serviceClasses].sort(scalarOrder),
      protocolVersions: [...dependency.protocolVersions].sort(scalarOrder),
      capabilities: [...dependency.capabilities].sort(scalarOrder),
      operators: [...dependency.operators].sort((a, b) => scalarOrder(a.serviceClass, b.serviceClass) || scalarOrder(a.operatorClass, b.operatorClass)),
    })) };
  return canonicalPublicationBytes({ hashProfile: 'f8publication-hash/1', manifest, content } as unknown as JsonValue);
}

export async function publicationHash(publication: GraphPublication | ComponentPublication): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(publicationHashBytes(publication)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
