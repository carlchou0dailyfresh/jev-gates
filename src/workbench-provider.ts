import { LocalJevProvider, TypeSafeProvider, MockProvider } from './providers/index.js';
import type { Answer, Provider } from './types.js';
export type WorkbenchMode = 'fixture' | 'live-localjev' | 'live-typesafe';

export async function localReadiness(): Promise<{ available: boolean; model: string; upstreamModel?: string }> {
  const model = process.env.LOCALJEV_MODEL ?? 'localjev-0.2';
  try {
    const base = new URL(process.env.LOCALJEV_BASE_URL ?? 'http://127.0.0.1:8080');
    // UI server is local-only; remote endpoints require deliberate library/CLI use.
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname) || base.username || base.password) throw new Error('Local endpoint required');
    const response = await fetch(new URL('/ready', base), { signal: AbortSignal.timeout(1500), redirect: 'error' });
    if (!response.ok) throw new Error('Unavailable');
    const raw = await response.json() as Record<string, unknown>;
    const upstreamModel = typeof raw.upstream_model === 'string' ? raw.upstream_model : typeof raw.upstreamModel === 'string' ? raw.upstreamModel : process.env.LOCALJEV_UPSTREAM_MODEL;
    return { available: true, model, ...(upstreamModel ? { upstreamModel } : {}) };
  } catch { return { available: false, model }; }
}
export async function workbenchConfig() {
  return { localjev: await localReadiness(), typesafe: { available: Boolean(process.env.TYPESAFE_API_KEY), model: process.env.TYPESAFE_MODEL ?? 'jev-1.13.0' } };
}
export async function selectProvider(mode: WorkbenchMode, answers: Record<string, Answer>, fault = false): Promise<Provider> {
  if (mode === 'fixture') {
    if (fault) return { name: 'fixture', model: 'injected-fault-v1', async evaluate() { throw new Error('Synthetic provider fault'); } };
    return new MockProvider(answers);
  }
  if (mode === 'live-localjev') {
    const ready = await localReadiness();
    if (!ready.available) throw new Error('LocalJev 尚未設定或服務無法連線；可選 fixture 離線操作。');
    return new LocalJevProvider({ model: ready.model, ...(ready.upstreamModel ? { upstreamModel: ready.upstreamModel } : {}), ...(process.env.LOCALJEV_BASE_URL ? { baseUrl: process.env.LOCALJEV_BASE_URL } : {}), ...(process.env.LOCALJEV_API_KEY ? { apiKey: process.env.LOCALJEV_API_KEY } : {}), timeoutMs: 35_000 });
  }
  if (mode === 'live-typesafe') {
    if (!process.env.TYPESAFE_API_KEY) throw new Error('TypeSafe 未設定金鑰；本次未執行雲端推論。');
    return new TypeSafeProvider({ apiKey: process.env.TYPESAFE_API_KEY, model: process.env.TYPESAFE_MODEL ?? 'jev-1.13.0' });
  }
  throw new Error('Unknown execution mode');
}
