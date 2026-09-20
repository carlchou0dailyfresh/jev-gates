import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunArtifact, sealArtifact, verifyArtifact, replayArtifact, validateEvidenceRecord, validateGateSpec, validateActionRecord, validateAssessment } from '../dist/artifact.js';
import { digest } from '../dist/json.js';
import { MockProvider } from '../dist/providers/mock.js';

const question = { type: 'noul', instructions: 'Is the bounded observation valid?' };
const policy = { type: 'noul', falseAt: 0.2, trueAt: 0.8 };
const circuit = { version: 1, name: 'artifact-test', nodes: [
  { id: 'evidence', kind: 'rule', path: '/present', op: 'eq', value: true },
  { id: 'claim', kind: 'semantic', question, policy, when: 'evidence' },
  { id: 'result', kind: 'logic', op: 'and', inputs: ['evidence', 'claim'] },
], outputs: ['result'] };
const evidence = () => ({ schemaVersion: '1.0', evidenceId: 'e1', sourceId: 's1', kind: 'synthetic', locator: 'fixture:source', retrievedAt: '2026-09-20T00:00:00.000Z', content: 'Synthetic source.', contentDigest: digest('Synthetic source.'), citations: [{ start: 0, end: 16, quote: 'Synthetic source' }], scope: { task: 'bounded claim' }, freshness: { version: '1' } });
const provider = () => new MockProvider({ claim: { type: 'noul', noul: 0.95 } });
const run = (options = {}) => createRunArtifact({ circuit, input: { present: true }, provider: provider(), evidence: [evidence()], ...options });

test('artifact export, complete verification and pure offline replay agree', async () => {
  const artifact = await run();
  assert.equal(artifact.assessment.status, 'not_evaluated');
  assert.equal(artifact.result.outputs.result.truth, 'TRUE');
  assert.deepEqual(await verifyArtifact(artifact), { valid: true, errors: [] });
  const original = globalThis.fetch; globalThis.fetch = () => { throw new Error('Replay attempted network'); };
  try { const replayed = await replayArtifact(JSON.parse(JSON.stringify(artifact))); assert.equal(replayed.valid, true); assert.equal(digest(replayed.result), digest(artifact.result)); }
  finally { globalThis.fetch = original; }
  assert.equal(artifact.requests[0].response.answers.claim.noul, 0.95);
  assert.equal(artifact.budget.usage.costUsd, 'unknown');
  assert.deepEqual(artifact.events.filter(e => e.type === 'node_completed').map(e => e.nodeId), artifact.result.nodes.map(n => n.id));
});

test('integrity detects any byte-level semantic edit, while resealed linkage edits still fail', async () => {
  const artifact = await run();
  for (const mutate of [
    a => { a.input.present = false; },
    a => { a.circuit.nodes[1].policy.trueAt = 0.99; },
    a => { a.requests[0].response.answers.claim.noul = 0.01; },
    a => { a.result.outputs.result.truth = 'FALSE'; },
    a => { a.evidence[0].content = 'Changed text'; },
    a => { a.events[1].signal.truth = 'FALSE'; },
    a => { a.signals.claim.provider = 'fake-live-provider'; },
    a => { a.budget.usage.inputTokens = 999; },
    a => { a.requests[0].provenance = 'live-typesafe'; },
    a => { a.requests.push(a.requests[0]); },
    a => { a.model.actualModels = ['invented-model']; },
    a => { a.model.provider = 'invented-provider'; },
  ]) {
    const changed = structuredClone(artifact); mutate(changed);
    assert.equal((await verifyArtifact(changed)).valid, false);
    sealArtifact(changed);
    assert.equal((await verifyArtifact(changed)).valid, false, JSON.stringify(changed));
  }
});

test('strict import rejects executable values, unexpected fields, oversized traces and missing artifacts', async () => {
  const a = await run();
  for (const value of [null, {}, { ...a, injectedScript: 'eval()' }, { ...a, input: () => {} }]) assert.equal((await verifyArtifact(value)).valid, false);
  const bad = structuredClone(a); bad.requests[0].command = 'curl'; sealArtifact(bad);
  assert.equal((await replayArtifact(bad)).valid, false);
});

test('replay preserves actions as records without execution and requires verification evidence', async () => {
  const a = await run();
  a.actions = [{ schemaVersion: '1.0', operationId: 'op-1', target: 'sandbox', parametersDigest: digest({}), policyDigest: digest(policy), status: 'pending', toolKind: 'sandbox', receipt: { timedOut: true }, executionCount: 1 }];
  sealArtifact(a); assert.equal((await replayArtifact(a)).valid, true);
  a.actions[0].status = 'verified'; sealArtifact(a); assert.equal((await verifyArtifact(a)).valid, false);
  a.actions[0].verification = { passed: true, evidence: { healthy: true } }; sealArtifact(a); assert.equal((await verifyArtifact(a)).valid, true);
});

test('failed providers and provider absence replay as operational UNKNOWN, not assessment passed', async () => {
  for (const p of [undefined, { name: 'failing', model: 'none', evaluate: async () => { throw new Error('private-secret'); } }]) {
    const a = await run({ provider: p }); assert.equal(a.result.outputs.result.truth, 'UNKNOWN');
    assert.equal((await replayArtifact(a)).valid, true);
    assert.equal(a.assessment.status, 'not_evaluated');
    assert.ok(!JSON.stringify(a).includes('private-secret'));
  }
});

test('child run preserves immutable parent and requires rationale', async () => {
  const parent = await run(); const before = JSON.stringify(parent);
  await assert.rejects(run({ parentRunId: parent.runId }), /change reason/);
  const child = await run({ parentRunId: parent.runId, changeReason: 'New original evidence', input: { present: false } });
  assert.notEqual(child.runId, parent.runId); assert.equal(child.result.outputs.result.truth, 'FALSE');
  assert.equal(JSON.stringify(parent), before); assert.equal((await verifyArtifact(child)).valid, true);
});

test('versioned contracts reject invalid citations, unsupported passed assessment and missing destination proof', () => {
  const e = evidence(); assert.equal(validateEvidenceRecord(e).content, e.content);
  assert.throws(() => validateEvidenceRecord({ ...e, citations: [{ start: 1, end: 3, quote: 'not here' }] }), /Citation/);
  assert.throws(() => validateEvidenceRecord({ ...e, contentDigest: '0'.repeat(64) }), /digest/);
  assert.throws(() => validateAssessment({ schemaVersion: '1.0', status: 'passed', labelsVersion: null, splitVersion: null, applicableData: [], metrics: {}, sampleCount: 0, independentReview: false, notes: [] }), /labels/);
  assert.throws(() => validateGateSpec({}), /Missing/);
  assert.throws(() => validateActionRecord({ schemaVersion: '1.0', operationId: 'op', target: 'sandbox', parametersDigest: digest({}), policyDigest: digest({}), status: 'verified', toolKind: 'sandbox' }), /destination/);
});

test('multi-question batches verify independently of canonical JSON key order', async () => {
  const nodes = ['zebra', 'alpha', 'middle'].map(id => ({ id, kind: 'semantic', question, policy }));
  const a = await run({ circuit: { version: 1, name: 'unsorted-batch', nodes, outputs: ['zebra'] }, provider: new MockProvider(Object.fromEntries(nodes.map(n => [n.id, { type: 'noul', noul: 1 }]))) });
  assert.equal(a.requests.length, 1); assert.deepEqual(a.result.calls[0].questionIds, ['zebra', 'alpha', 'middle']);
  assert.equal((await replayArtifact(JSON.parse(JSON.stringify(a)))).valid, true);
  const forged = structuredClone(a); forged.result.calls[0].questionIds = ['alpha', 'alpha', 'zebra']; sealArtifact(forged);
  assert.equal((await verifyArtifact(forged)).valid, false);
});

test('resealed forged budget stop reasons cannot replace deterministic computations', async () => {
  const a = await run({ circuit: { version: 1, name: 'exact', nodes: [{ id: 'exact', kind: 'constant', value: 'TRUE' }], outputs: ['exact'] }, provider: undefined });
  for (const reason of ['call_budget_exhausted', 'node_budget_exhausted', 'time_budget_exhausted', 'token_budget_exhausted', 'cost_budget_exhausted', 'token_usage_unknown', 'cost_usage_unknown']) {
    const forged = structuredClone(a), signal = { truth: 'UNKNOWN', reason };
    forged.result.nodes[0].signal = signal; forged.result.signals.exact = signal; forged.result.outputs.exact = signal; forged.result.status = 'abstained';
    Object.assign(forged.signals.exact, { truth: 'UNKNOWN', reasonCode: reason }); forged.events.find(e => e.nodeId === 'exact').signal = signal;
    forged.budget.exhausted = [reason]; forged.workflow.status = 'budget_exhausted'; if (['time_budget_exhausted','node_budget_exhausted'].includes(reason)) forged.budget.usage.nodes = 0;
    sealArtifact(forged); assert.equal((await verifyArtifact(forged)).valid, false, reason);
  }
});

test('action records reject mismatched operation identity in destination receipts', async () => {
  const a = await run();
  a.actions = [{ schemaVersion: '1.0', operationId: 'expected', target: 'sandbox', parametersDigest: digest({}), policyDigest: digest({}), status: 'verified', toolKind: 'sandbox', queryResult: { operationId: 'other-operation' }, verification: { passed: true, evidence: { healthy: true } } }];
  sealArtifact(a); assert.equal((await verifyArtifact(a)).valid, false);
});

test('semantic evidence provenance only references actually selected matching source records', async () => {
  const one = evidence(), two = { ...evidence(), evidenceId: 'e2', sourceId: 's2' };
  const a = await run({ evidence: [one, two], input: { present: true, selected: { evidence: [one] } }, circuit: { ...circuit, nodes: circuit.nodes.map(n => n.id === 'claim' ? { ...n, input: '/selected' } : n) } });
  assert.deepEqual(a.signals.claim.evidenceIds, ['e1']); assert.equal((await verifyArtifact(a)).valid, true);
  const omitted = await run(); assert.deepEqual(omitted.signals.claim.evidenceIds, []);
});
