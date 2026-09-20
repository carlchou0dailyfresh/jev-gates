import type { Circuit, RunEvent, Signal } from './api';

export interface NodeExecution {
  state: 'idle' | 'waiting' | 'running' | 'evaluated' | 'failed' | 'timeout' | 'skipped' | 'cancelled' | 'budget_stopped';
  label: string;
  reason?: string;
}
const budgetReasons = new Set(['time_budget_exhausted', 'node_budget_exhausted', 'call_budget_exhausted', 'token_budget_exhausted', 'cost_budget_exhausted', 'token_usage_unknown', 'cost_usage_unknown']);
const skippedReasons = new Set(['condition_false', 'condition_unknown', 'context_unknown', 'provider_missing']);

/** Presentation of observable execution events; never changes truth or a provider response. */
export function nodeExecutions(circuit: Circuit, signals: Record<string, Signal>, events: RunEvent[]): Record<string, NodeExecution> {
  const calls = new Map<string, { questionIds: string[]; status: 'running' | 'completed' | 'failed'; failureKind?: string }>();
  const nodeCalls = new Map<string, string>();
  const runStarted = events.some(e => e.type === 'run_started');
  const runFinished = events.some(e => e.type === 'run_completed');
  for (const event of events) {
    const detail = event.detail && typeof event.detail === 'object' && !Array.isArray(event.detail) ? event.detail : {};
    if (event.type === 'provider_started' && event.requestDigest) {
      const questionIds = Array.isArray(detail.questionIds) ? detail.questionIds.filter((id): id is string => typeof id === 'string') : [];
      calls.set(event.requestDigest, { questionIds, status: 'running' });
      for (const id of questionIds) nodeCalls.set(id, event.requestDigest);
    } else if ((event.type === 'provider_completed' || event.type === 'provider_failed') && event.requestDigest) {
      const previous = calls.get(event.requestDigest);
      if (previous) calls.set(event.requestDigest, { ...previous, status: event.type === 'provider_completed' ? 'completed' : 'failed', ...(typeof detail.failureKind === 'string' ? { failureKind: detail.failureKind } : {}) });
    }
    if (event.type === 'node_completed' && event.nodeId && event.requestDigest) nodeCalls.set(event.nodeId, event.requestDigest);
  }
  return Object.fromEntries(circuit.nodes.map(node => {
    const signal = signals[node.id]; const reason = signal?.reason;
    const digest = nodeCalls.get(node.id); const call = digest ? calls.get(digest) : undefined;
    let execution: NodeExecution;
    if (reason === 'aborted' || call?.failureKind === 'aborted') execution = { state: 'cancelled', label: '已取消 · CANCELLED' };
    else if ((reason && budgetReasons.has(reason)) || call?.failureKind === 'run_timeout') execution = { state: 'budget_stopped', label: '預算停止 · BUDGET_STOPPED' };
    else if (call?.failureKind === 'gate_timeout' || call?.failureKind === 'timeout') execution = { state: 'timeout', label: '呼叫逾時 · TIMEOUT' };
    else if (reason === 'provider_error' || reason === 'answer_type_mismatch' || reason === 'invalid_policy_or_answer' || call?.status === 'failed') execution = { state: 'failed', label: '執行失敗 · FAILED' };
    else if (reason && (skippedReasons.has(reason) || node.kind === 'semantic' && reason === 'missing_input')) execution = { state: 'skipped', label: reason === 'provider_missing' ? '未呼叫模型 · SKIPPED' : '條件未滿足，已跳過 · SKIPPED' };
    else if (signal) execution = { state: 'evaluated', label: '已評估 · EVALUATED' };
    else if (call?.status === 'running' && !runFinished) execution = { state: 'running', label: '執行中 · RUNNING' };
    else if (call?.status === 'completed' && !runFinished) execution = { state: 'waiting', label: '已收回應，等待判定' };
    else execution = runStarted && !runFinished ? { state: 'waiting', label: '等待執行' } : { state: 'idle', label: '尚未執行' };
    return [node.id, { ...execution, ...(reason ? { reason } : {}) }];
  }));
}
