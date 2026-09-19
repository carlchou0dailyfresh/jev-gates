import type { EvaluationOptions, Json, Provider, ProviderResponse, Question } from '../types.js';
import { record, validateResponse } from './validation.js';

export const MAX_REQUEST_BYTES = 64 * 1024;
export const MAX_RESPONSE_BYTES = 1024 * 1024;
/** Protective adapter limits, not service rate limits or token budgets. */
export const PROVIDER_LIMITS = {
  typesafe: { questions: 100, choiceOptions: 255, scoreLevels: 10, outcomes: 25_500 },
  localjev: { questions: 16, choiceOptions: 128, scoreLevels: 10, outcomes: 128 },
} as const;

type Limits = { questions: number; choiceOptions: number; scoreLevels: number; outcomes: number };

export function nonempty(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
}

function assertJson(value: unknown, seen = new Set<unknown>(), depth = 0): void {
  if (depth > 64) throw new Error('Provider input exceeds the maximum nesting depth');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || value === null || seen.has(value)) throw new Error('Provider input must be finite, acyclic JSON');
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('Provider input must contain plain JSON objects');
  seen.add(value);
  for (const item of Object.values(value)) assertJson(item, seen, depth + 1);
  seen.delete(value);
}

export function validateQuestions(questions: Record<string, Question>, limits: Limits): void {
  if (!record(questions)) throw new Error('Provider questions must be an object');
  const entries = Object.entries(questions);
  if (!entries.length || entries.length > limits.questions) throw new Error(`Provider request requires 1–${limits.questions} questions`);
  let outcomes = 0;
  for (const [id, q] of entries) {
    if (!id || !record(q) || typeof q.instructions !== 'string' || !q.instructions.trim()) throw new Error('Provider question requires an ID and nonempty instructions');
    if (q.type === 'noul') {
      if (q.criteria !== undefined && (!record(q.criteria) || Object.entries(q.criteria).some(([key, value]) => !['true', 'false'].includes(key) || typeof value !== 'string'))) throw new Error('Invalid noul criteria');
      outcomes += 1;
    } else if (q.type === 'choice') {
      if (!record(q.criteria)) throw new Error('Choice criteria must be an object');
      const options = Object.entries(q.criteria);
      if (options.length < 2 || options.length > limits.choiceOptions) throw new Error(`Choice requires 2–${limits.choiceOptions} options`);
      if (options.some(([label, value]) => !label || (value !== null && typeof value !== 'string'))) throw new Error('Invalid choice criteria');
      outcomes += options.length;
    } else if (q.type === 'score') {
      if (!Array.isArray(q.criteria) || q.criteria.length < 2 || q.criteria.length > limits.scoreLevels || q.criteria.some(value => typeof value !== 'string')) throw new Error(`Score requires 2–${limits.scoreLevels} string levels`);
      outcomes += q.criteria.length;
    } else throw new Error('Unknown provider question type');
  }
  if (outcomes > limits.outcomes) throw new Error(`Provider request exceeds ${limits.outcomes} total outcomes`);
}

class TransportError extends Error {}

async function readJson(response: Response): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length !== null && Number(length) > MAX_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new TransportError('Provider response exceeds 1 MiB');
  }
  if (!response.body) throw new TransportError('Provider response body is empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new TransportError('Provider response exceeds 1 MiB');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new TransportError('Provider response is not valid UTF-8 JSON'); }
}

abstract class HttpProvider implements Provider {
  abstract readonly name: string;
  readonly model: string;
  readonly timeoutMs: number;
  protected readonly endpoint: URL;
  protected readonly apiKey?: string;
  protected readonly limits: Limits;

  constructor(endpoint: URL, model: string, timeoutMs: number, limits: Limits, apiKey?: string) {
    this.endpoint = endpoint;
    this.model = nonempty(model, 'Provider model');
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error('timeoutMs must be an integer from 1 to 600000');
    this.timeoutMs = timeoutMs;
    this.limits = limits;
    if (apiKey !== undefined) {
      nonempty(apiKey, 'API key');
      if (/\s/.test(apiKey)) throw new Error('API key must not contain whitespace');
      this.apiKey = apiKey;
    }
  }

  async evaluate(state: Json, questions: Record<string, Question>, options: EvaluationOptions = {}): Promise<ProviderResponse> {
    if (options.signal?.aborted) throw new Error('Provider request aborted');
    assertJson(state);
    validateQuestions(questions, this.limits);
    assertJson(questions);
    // The wire API accepts strings, objects and arrays. Preserve scalar meaning explicitly.
    const wireState = state === null || typeof state === 'number' || typeof state === 'boolean' ? { value: state } : state;
    const body = JSON.stringify({ state: wireState, model: this.model, questions });
    if (new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) throw new Error('Provider request exceeds 64 KiB');
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.timeoutMs);
    const abort = () => controller.abort();
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
      if (this.apiKey !== undefined) headers.authorization = `Bearer ${this.apiKey}`;
      const response = await fetch(this.endpoint, { method: 'POST', headers, body, signal: controller.signal, redirect: 'error' });
      if (!response.ok) {
        await response.body?.cancel();
        throw new TransportError(`Provider HTTP ${response.status}`);
      }
      const raw = await readJson(response);
      if (timedOut) throw new TransportError('Provider request timed out');
      if (options.signal?.aborted) throw new TransportError('Provider request aborted');
      // Validation happens outside catch to keep its safe, specific diagnostics.
      return validateResponse(raw, questions);
    } catch (error) {
      if (timedOut) throw new Error('Provider request timed out');
      if (options.signal?.aborted) throw new Error('Provider request aborted');
      if (error instanceof TransportError) throw new Error(error.message);
      if (error instanceof Error && error.message.startsWith('Invalid provider response:')) throw error;
      throw new Error('Provider transport failed');
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
    }
  }
}

export interface TypeSafeProviderOptions { apiKey: string; model?: string; timeoutMs?: number }
export class TypeSafeProvider extends HttpProvider {
  readonly name = 'typesafe';
  constructor(options: TypeSafeProviderOptions) {
    super(new URL('https://api.typesafe.ai/v1/systemone'), options.model ?? 'jev-1.13.0', options.timeoutMs ?? 30_000, PROVIDER_LIMITS.typesafe, nonempty(options.apiKey, 'API key'));
  }
}

export interface LocalJevProviderOptions {
  baseUrl?: string; model?: string; timeoutMs?: number;
  /** Explicit operator metadata; LocalJev 0.2 evaluations do not report the upstream model. */
  upstreamModel?: string;
  /** Only required when the LocalJev server has LOCALJEV_API_KEY configured. */
  apiKey?: string;
}

function localEndpoint(baseUrl: string): URL {
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new Error('LocalJev baseUrl must be an absolute HTTP(S) URL'); }
  if (url.username || url.password || url.search || url.hash) throw new Error('LocalJev baseUrl must not contain credentials, a query, or fragment');
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\./.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new Error('LocalJev requires HTTPS except for loopback HTTP');
  if (!['', '/', '/v1', '/v1/'].includes(url.pathname)) throw new Error('LocalJev baseUrl must be a server origin or end in /v1');
  url.pathname = '/v1/systemone';
  return url;
}

export class LocalJevProvider extends HttpProvider {
  readonly name = 'localjev';
  readonly upstreamModel?: string;
  constructor(options: LocalJevProviderOptions = {}) {
    super(localEndpoint(options.baseUrl ?? 'http://127.0.0.1:8080'), options.model ?? 'localjev-0.2', options.timeoutMs ?? 30_000, PROVIDER_LIMITS.localjev, options.apiKey);
    if (options.upstreamModel !== undefined) this.upstreamModel = nonempty(options.upstreamModel, 'Upstream model');
  }
  override async evaluate(state: Json, questions: Record<string, Question>, options?: EvaluationOptions): Promise<ProviderResponse> {
    const result = await super.evaluate(state, questions, options);
    if (result.upstreamModel === undefined && this.upstreamModel !== undefined) result.upstreamModel = this.upstreamModel;
    return result;
  }
}
