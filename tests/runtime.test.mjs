import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunArtifact, verifyArtifact } from '../dist/artifact.js';
import { Controller, FileCheckpointStore } from '../dist/controller.js';
import { LocalJevProvider } from '../dist/providers/index.js';

const question = { type: 'noul', instructions: 'Bounded question' }, policy = { type: 'noul', falseAt: .2, trueAt: .8 };
const circuit = { version: 1, name: 'budgets', nodes: [
  { id: 'first', kind: 'semantic', question, policy },
  { id: 'second', kind: 'semantic', question, policy, context: ['first'] },
], outputs: ['second'] };
function provider(usage) { return { name: 'fixture', model: 'fixture-v1', evaluate: async (_state, questions) => ({ model: 'fixture-v1', answers: Object.fromEntries(Object.keys(questions).map(id => [id, { type: 'noul', noul: 1 }])), ...(usage ? { usage } : {}) }) }; }
const run = options => createRunArtifact({ circuit, input: {}, provider: provider(), ...options });

test('call, node and token budgets stop later work and retain valid partial artifacts', async () => {
  for (const [budget, reason] of [[{ maxCalls: 0 }, 'call_budget_exhausted'], [{ maxNodes: 0 }, 'node_budget_exhausted'], [{ maxTokens: 0 }, 'token_budget_exhausted'], [{ maxCostUsd: 0 }, 'cost_budget_exhausted']]) {
    const a = await run({ budget }); assert.equal(a.result.signals.first.reason, reason); assert.equal(a.requests.length, 0); assert.equal(a.workflow.status, 'budget_exhausted'); assert.equal((await verifyArtifact(a)).valid, true);
  }
  const token = await run({ provider: provider({ input_tokens: 5, output_tokens: 3 }), budget: { maxTokens: 8 } });
  assert.equal(token.requests.length, 1); assert.equal(token.result.signals.second.reason, 'token_budget_exhausted'); assert.equal(token.budget.usage.inputTokens, 5); assert.equal((await verifyArtifact(token)).valid, true);
  const unknown = await run({ budget: { maxTokens: 100 } }); assert.equal(unknown.result.signals.second.reason, 'token_usage_unknown'); assert.equal(unknown.budget.usage.inputTokens, 'unknown');
});

test('semantic batches respect the node limit without sending excess questions', async () => {
  const nodes = Array.from({ length: 7 }, (_, i) => ({ id: `node${i}`, kind: 'semantic', question, policy }));
  const a = await run({ circuit: { version: 1, name: 'nodes', nodes, outputs: nodes.map(n => n.id) }, budget: { maxNodes: 3 } });
  assert.equal(Object.keys(a.requests[0].questions).length, 3); assert.equal(a.budget.usage.nodes, 3);
  assert.equal(a.result.signals.node3.reason, 'node_budget_exhausted'); assert.equal((await verifyArtifact(a)).valid, true);
});

test('total deadline and cancellation bound providers that ignore AbortSignal', async () => {
  const p = { name: 'hung', model: 'hung', evaluate: () => new Promise(() => {}) };
  const timed = await run({ provider: p, budget: { maxTimeMs: 10, gateTimeoutMs: 100 } });
  assert.equal(timed.workflow.status, 'budget_exhausted'); assert.equal((await verifyArtifact(timed)).valid, true);
  const controller = new AbortController(); const running = run({ provider: p, signal: controller.signal }); setTimeout(() => controller.abort(), 5);
  const cancelled = await running; assert.equal(cancelled.workflow.status, 'cancelled'); assert.equal((await verifyArtifact(cancelled)).valid, true);
});

const definition = { id: 'repair', version: '1', initial: 'repair', maxSteps: 3, states: { repair: { gate: 'ready', tool: 'repair', next: 'done' }, done: { terminal: true } } };
function control(overrides = {}) {
  return new Controller(definition, { evaluate: () => 'TRUE', tools: { repair: { execute: async () => ({ healthy: true }), verify: receipt => receipt.healthy === true } }, gateTimeoutMs: 10, toolTimeoutMs: 10, verifyTimeoutMs: 10, ...overrides });
}

test('gate deadline pauses without executing; tool timeout remains pending and query never resubmits', async () => {
  let executions = 0, aborted = false;
  const gate = control({ evaluate: (_g, _s, context) => { context.signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); } });
  assert.equal((await gate.step({})).reason, 'condition_timeout'); assert.equal(aborted, true);
  let saved;
  const store = { save: async value => { saved = structuredClone(value); }, load: async () => saved };
  const options = { store, tools: { repair: {
    execute: async (_snapshot, context) => { executions++; assert.equal(saved.status, 'pending'); assert.match(saved.pending.inputDigest, /^[a-f0-9]{64}$/); assert.match(saved.pending.policyDigest, /^[a-f0-9]{64}$/); return new Promise(() => {}); },
    query: async context => ({ healthy: true, operationId: context.operationId }), verify: receipt => receipt.healthy === true,
  } } };
  const controller = control(options); const pending = await controller.step({ instruction: 'repair sandbox' });
  assert.equal(pending.reason, 'tool_timeout'); assert.equal(executions, 1);
  const restored = control({ ...options, checkpoint: pending }); assert.equal((await restored.queryPending()).status, 'completed');
  await assert.rejects(restored.queryPending(), /No pending/); assert.equal(executions, 1);
});

test('verify deadline never changes a pending action into completed', async () => {
  const controller = control({ tools: { repair: { execute: async () => ({}), verify: () => new Promise(() => {}) } } });
  const pending = await controller.step({}); assert.equal(pending.status, 'pending'); assert.equal(pending.reason, 'verification_timeout');
});

test('file store rejects a concurrent writer and a stale checkpoint', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-lock-test-'));
  try {
    const store = new FileCheckpointStore(join(directory, 'checkpoint.json')); let release;
    const held = store.withLock(() => new Promise(resolve => { release = resolve; }));
    while (!release) await new Promise(resolve => setTimeout(resolve, 1));
    await assert.rejects(new FileCheckpointStore(store.path).withLock(async () => {}), /writer lock/); release(); await held;
    const one = control({ store }), two = control({ store }); await one.step({}); await assert.rejects(two.step({}), /changed by another writer/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('HTTP captures complete transport JSON separately from normalized response without request key', async () => {
  const original = globalThis.fetch; let seenBody;
  globalThis.fetch = async (_url, init) => { seenBody = JSON.parse(init.body); return new Response(JSON.stringify({ model: 'localjev-bridge', upstream_model: 'actual-small-model', answers: { first: { type: 'noul', noul: 1 } }, extra: 'preserved transport metadata' }), { status: 200 }); };
  try {
    const a = await run({ circuit: { ...circuit, nodes: [circuit.nodes[0]], outputs: ['first'] }, provider: new LocalJevProvider({ apiKey: 'super-secret-key' }), mode: 'live-localjev' });
    assert.deepEqual(a.requests[0].transport.request, seenBody); assert.equal(a.requests[0].transport.response.extra, 'preserved transport metadata');
    assert.equal(a.requests[0].response.upstreamModel, 'actual-small-model'); assert.equal((await verifyArtifact(a)).valid, true); assert.ok(!JSON.stringify(a).includes('super-secret-key'));
  } finally { globalThis.fetch = original; }
});

test('combined node truncation and total timeout preserves causal stop reasons', async () => {
  const nodes = Array.from({ length: 5 }, (_, i) => ({ id: `node${i}`, kind: 'semantic', question, policy }));
  const a = await run({ circuit: { version: 1, name: 'combined', nodes, outputs: ['node4'] }, provider: { name: 'hung', model: 'hung', evaluate: () => new Promise(() => {}) }, budget: { maxNodes: 3, maxTimeMs: 10, gateTimeoutMs: 100 } });
  assert.equal(a.result.signals.node4.reason, 'time_budget_exhausted'); assert.equal((await verifyArtifact(a)).valid, true);
});

test('observer failures cannot relabel provider success or duplicate calls', async () => {
  const a = await run({ onEvent: () => { throw new Error('UI observer failed'); } });
  assert.equal(a.result.outputs.second.truth, 'TRUE'); assert.equal(a.requests.length, 2); assert.equal((await verifyArtifact(a)).valid, true);
});

test('HTTP failure retains safe status diagnosis without leaking response body or retrying', async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('server-secret-key private prompt', { status: 529 }); };
  try {
    const a = await run({ provider: new LocalJevProvider(), mode: 'live-localjev' });
    assert.equal(calls, 1); assert.equal(a.requests[0].error, 'Provider HTTP 529');
    const failure = a.events.find(e => e.type === 'provider_failed'); assert.equal(failure.detail.failureKind, 'http_error'); assert.equal(failure.detail.httpStatus, 529);
    assert.ok(!JSON.stringify(a).includes('server-secret-key')); assert.equal((await verifyArtifact(a)).valid, true);
  } finally { globalThis.fetch = original; }
});
