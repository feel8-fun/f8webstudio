/** f8publication-hash/1: tagged JSON tree and binary64 numeric tokens. */
import type { JsonValue } from '../api/contracts.gen';

export function scalarOrder(left: string, right: string): number {
  const a = Array.from(left, (char) => char.codePointAt(0)!);
  const b = Array.from(right, (char) => char.codePointAt(0)!);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

function tree(value: JsonValue): JsonValue {
  if (value === null) return ['null'];
  if (typeof value === 'boolean') return ['boolean', value];
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Publication numbers must be finite');
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw new Error('Publication integers must be exactly representable in JavaScript');
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value === 0 ? 0 : value, false);
    return ['number', Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')];
  }
  if (typeof value === 'string') {
    validateUnicode(value);
    return ['string', value];
  }
  if (Array.isArray(value)) return ['array', value.map(tree)];
  const object = value as Readonly<Record<string, JsonValue>>;
  return ['object', Object.keys(object).sort(scalarOrder).map((key) => {
    validateUnicode(key);
    return [key, tree(object[key]!)];
  })];
}

function validateUnicode(value: string): void {
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code >= 0xd800 && code <= 0xdfff) throw new Error('Publication strings must contain valid Unicode');
  }
}

export function canonicalPublicationBytes(value: JsonValue): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(['f8publication-hash/1', tree(value)]));
}
