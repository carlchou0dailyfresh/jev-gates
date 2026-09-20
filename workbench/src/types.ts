export type Truth = 'TRUE' | 'FALSE' | 'UNKNOWN';
export type Mode = 'fixture' | 'localjev' | 'typesafe';
export interface Evidence { id: string; title: string; text: string }
export interface Gate { id: string; title: string; question: string; enabled: boolean; falseAt: number; trueAt: number; fixture: number }
export interface Branch { title: string; instruction: string }
export interface Draft {
  scenarioId: string; title: string; task: string; evidence: Evidence[]; gates: Gate[];
  combination: 'and' | 'or' | 'kofn'; k: number; branches: Record<Truth, Branch>;
}
export interface Scenario { id: string; category: string; title: string; description: string; icon: 'research' | 'support' | 'incident' | 'planning'; duration: string; draft: Draft }
export interface Health {
  localjev: { available: boolean; model: string; upstreamModel?: string };
  llm: { available: boolean; models: string[]; defaultModel?: string };
  typesafe: { configured: boolean };
}
export interface NodeResult { id: string; kind: string; signal: { truth: Truth; reason: string; answer?: { noul?: number } }; elapsedMs: number }
export interface Run {
  id: string; createdAt: string; mode: Mode; draft: Draft; truth: Truth; branch: Branch;
  provenance: { provider: string; model: string; upstreamModel?: string; synthetic: true; calibrated: false };
  elapsedMs: number; digest: string;
  result: { circuit: string; circuitDigest: string; inputDigest: string; status: string; signals: Record<string, { truth: Truth; reason: string; answer?: { noul?: number } }>; outputs: Record<string, { truth: Truth; reason: string }>; nodes: NodeResult[]; calls: Array<{ status: string; model?: string; upstreamModel?: string; elapsedMs: number; questionIds: string[]; error?: string }> };
  template: string;
}
export interface Narration { text: string; model: string; kind: 'llm'; elapsedMs: number; runId: string; citationIds: string[] }
export interface Replay { valid: boolean; truth: Truth; checks: string[] }
