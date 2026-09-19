import { createHash } from 'node:crypto';
import type { Json } from './types.js';

export function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object' || !value || seen.has(value)) throw new Error('Expected finite, acyclic JSON');
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Expected plain JSON object');
  seen.add(value);
  let result: string;
  if (Array.isArray(value)) {
    // Sparse arrays are not JSON values supplied by a JSON parser.
    for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i)) throw new Error('Sparse array');
    result = '[' + value.map(item => canonical(item, seen)).join(',') + ']';
  } else {
    result = '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key], seen)).join(',') + '}';
  }
  seen.delete(value);
  return result;
}
export function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function jsonCopy<T>(value: T): T { return JSON.parse(canonical(value)) as T; }
export function validPointer(path: unknown): path is string {
  return typeof path === 'string' && (path === '' || (path.startsWith('/') && !/~(?:[^01]|$)/.test(path)));
}
export function pointer(input: Json, path: string): { found: boolean; value?: Json } {
  let value: Json = input;
  if (path === '') return { found: true, value };
  for (const segment of path.slice(1).split('/')) {
    const key = segment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) return { found: false };
    if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/.test(key)) return { found: false };
    value = (value as Record<string, Json>)[key]!;
  }
  return { found: true, value };
}
