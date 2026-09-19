import type { Answer, Circuit, Json, Policy, ProviderResponse, Question, RunResult, Signal, Truth } from './types.js';

export type RunMode = 'fixture' | 'recorded-live' | 'live-localjev' | 'live-typesafe';
export interface EvidenceRecord {
  schemaVersion: '1.0'; evidenceId: string; sourceId: string;
  kind: 'synthetic' | 'public-source' | 'user-provided';
  locator: string; retrievedAt: string; content: string; contentDigest: string;
  citations: Array<{ start: number; end: number; quote: string }>;
  scope: { task?: string; subject?: string; conditions?: string[]; metrics?: string[] };
  freshness: { observedAt?: string; validUntil?: string; version?: string };
}
export interface GateSpec {
  schemaVersion: '1.0'; gateId: string; version: string; question: string;
  inputSchema: Json; evidenceIds: string[]; outputType: 'truth' | 'support' | 'choice' | 'score';
  unknownConditions: string[]; policy: Json; calibrationVersion: string | null;
  examples: Json[]; counterexamples: Json[];
}
export interface DecisionSignal {
  schemaVersion: '1.0'; truth: Truth; reasonCode: string; inputDigest: string; policyDigest: string;
  provider: string; model: string | null; upstreamModel?: string; evidenceIds: string[];
  answer?: Answer; provenance: RunMode | 'deterministic';
}
export interface ActionRecord {
  schemaVersion: '1.0'; operationId: string; target: string; parametersDigest: string; policyDigest: string;
  status: 'pending' | 'executed' | 'verified' | 'failed'; toolKind: 'sandbox' | 'live';
  receipt?: Json; queryResult?: Json; verification?: { passed: boolean; evidence: Json }; executionCount?: number;
}
export interface Assessment {
  schemaVersion: '1.0'; status: 'passed' | 'failed' | 'not_evaluated'; labelsVersion: string | null;
  splitVersion: string | null; applicableData: string[]; metrics: Record<string, number | null>;
  sampleCount: number; independentReview: boolean; notes: string[];
}
export interface RunBudgetLimits {
  maxCalls: number; maxNodes: number; maxTimeMs: number; gateTimeoutMs: number;
  maxTokens?: number; maxCostUsd?: number;
}
export interface RunBudget {
  limits: RunBudgetLimits;
  usage: { calls: number; nodes: number; elapsedMs: number; inputTokens: number | 'unknown'; outputTokens: number | 'unknown'; costUsd: number | 'unknown' };
  exhausted: string[];
}
export interface RunEvent {
  sequence: number; type: 'run_started' | 'node_completed' | 'provider_started' | 'provider_completed' | 'provider_failed' | 'run_completed';
  at: string; nodeId?: string; requestDigest?: string; signal?: Signal; detail?: Json;
}
export interface RequestRecord {
  index: number; provider: string; requestedModel: string; state: Json; questions: Record<string, Question>;
  requestDigest: string; status: 'ok' | 'error'; response?: ProviderResponse; rawResponse?: Json;
  error?: string; elapsedMs: number; provenance: RunMode; transport?: { request: Json; response: Json };
}
export interface RunArtifact {
  schemaVersion: '1.0'; runId: string; parentRunId?: string; changeReason?: string; createdAt: string;
  scenarioId?: string; mode: RunMode; circuit: Circuit; input: Json; evidence: EvidenceRecord[];
  model: { provider: string; requestedModel: string; actualModels: string[]; upstreamModels: string[] };
  events: RunEvent[]; result: RunResult; signals: Record<string, DecisionSignal>; requests: RequestRecord[];
  budget: RunBudget; actions: ActionRecord[]; assessment: Assessment;
  workflow: { status: 'completed' | 'cancelled' | 'budget_exhausted'; errors: string[] };
  integrity: { algorithm: 'sha256'; digest: string };
}
export interface UncertaintyPolicy { nodeId: string; provider: string; model: string; language: string; scenario: string; version: string; policy: Policy }
