// @vitest-environment node
import { describe, expect, it } from 'vitest';
import vectors from '../../../contracts/fixtures/hash-v1.json';
import graph from '../../../contracts/fixtures/graph-v1.json';
import component from '../../../contracts/fixtures/component-v1.json';
import type { ComponentPublication, GraphPublication, JsonValue } from '../api/contracts.gen';
import { canonicalPublicationBytes } from './canonical';
import { publicationHashBytes } from './hash';

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

describe('publication hash shared Python/Web fixtures', () => {
  it.each(vectors)('has identical preimage and digest ($sha256)', async (fixture) => {
    const bytes = canonicalPublicationBytes(fixture.value as JsonValue);
    expect(new TextDecoder().decode(bytes)).toBe(fixture.canonical);
    expect(await digest(bytes)).toBe(fixture.sha256);
  });
  it('matches actual graph/component publication hashes', async () => {
    expect(await digest(publicationHashBytes(graph as unknown as GraphPublication))).toBe(graph.contentHash);
    expect(await digest(publicationHashBytes(component as unknown as ComponentPublication))).toBe(component.contentHash);
  });
  it('rejects nonportable numbers and Unicode', () => {
    for (const value of [NaN, Infinity, 2 ** 53, '\ud800']) {
      expect(() => canonicalPublicationBytes(value)).toThrow();
    }
  });
});
