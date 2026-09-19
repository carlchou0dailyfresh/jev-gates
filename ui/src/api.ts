import type { Circuit, Json } from '../../src/types';
import type { EvidenceRecord, RunArtifact, RunEvent } from '../../src/workbench-types';
export type { Circuit, GateNode, Json, Truth, Signal } from '../../src/types';
export type { RunArtifact, RunEvent, EvidenceRecord, DecisionSignal } from '../../src/workbench-types';
export interface Scenario { id: string; title: string; description: string; learning: string | string[]; variants: string[] }
export interface ScenarioDetail { id: string; title: string; variant: string; seed: number; circuit: Circuit; input: Json; evidence: EvidenceRecord[]; notes: string[]; sourceKind: string }
export interface Configuration { localjev: { available: boolean; model: string; upstreamModel?: string }; typesafe: { available: boolean; model: string } }
export interface Job { status: 'running' | 'completed' | 'failed' | 'cancelled'; events: RunEvent[]; artifact?: RunArtifact; error?: string }
export async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json().catch(() => ({ error: `服務回傳非 JSON 資料 (${response.status})` }));
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : JSON.stringify(result.error ?? result));
  return result as T;
}
export function downloadArtifact(artifact: RunArtifact) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(artifact, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = `${artifact.runId}.json`; a.click(); URL.revokeObjectURL(url);
}
export function pretty(value: unknown) { return JSON.stringify(value, null, 2) ?? '—'; }
export function dependencies(node: Circuit['nodes'][number]): string[] {
  return node.kind === 'logic' ? node.inputs : node.kind === 'semantic' ? [...(node.context ?? []), ...(node.when ? [node.when] : [])] : [];
}
