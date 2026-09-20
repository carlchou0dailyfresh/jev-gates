import test from 'node:test';
import assert from 'node:assert/strict';
import { digest } from '../dist/json.js';
import { evidenceRequired, claimSupport, scopeMatch, handleConflict, freshness, constraints, uncertaintyRouting, counterexample, coverageCheck, temporalCondition, versionedSubcircuit, mountVersionedSubcircuit, semanticGateCatalog } from '../dist/semantic-gates.js';
function evidence(id = 'a', changes = {}) {
  return { schemaVersion: '1.0', evidenceId: id, sourceId: id, kind: 'synthetic', locator: `fixture:${id}`, retrievedAt: '2026-09-20T00:00:00.000Z', content: 'The constrained task was faster.', contentDigest: digest('The constrained task was faster.'), citations: [{ start: 0, end: 'The constrained task was faster.'.length, quote: 'The constrained task was faster.' }], scope: { task: 'bounded', subject: 'model A', conditions: ['16k'], metrics: ['latency'] }, freshness: { observedAt: '2026-09-20T00:00:00.000Z', version: 'v1' }, ...changes };
}

test('evidence location detects missing, invalid citations and does not imply claim support', () => {
  const e = evidence(); assert.equal(evidenceRequired([e], ['a']).truth, 'TRUE');
  assert.equal(evidenceRequired([e], ['a']).metadata.locatingTextDoesNotEstablishSupport, true);
  assert.equal(evidenceRequired([e], ['missing']).truth, 'UNKNOWN');
  assert.equal(evidenceRequired([{ ...e, citations: [] }], ['a']).truth, 'UNKNOWN');
  assert.equal(evidenceRequired([{ ...e, citations: [{ start: 0, end: 3, quote: 'wrong' }] }], ['a']).truth, 'UNKNOWN');
});

test('claim support retains supporting/refuting text references and does not assess source truthfulness', () => {
  const sources = [evidence('a'), evidence('b')], claim = 'Bounded task faster';
  const observation = (id, relation) => ({ claim, evidenceId: id, relation, citationIndex: 0 });
  assert.equal(claimSupport(claim, [observation('a', 'supports')], sources).truth, 'TRUE');
  assert.equal(claimSupport(claim, [observation('a', 'refutes')], sources).truth, 'FALSE');
  const mixed = claimSupport(claim, [observation('a', 'supports'), observation('b', 'refutes')], sources);
  assert.equal(mixed.truth, 'UNKNOWN'); assert.equal(mixed.reason, 'evidence_conflict'); assert.equal(mixed.metadata.sourceTruthfulnessAssessed, false);
  assert.equal(claimSupport(claim, [observation('c', 'supports')], sources).truth, 'UNKNOWN');
  assert.equal(claimSupport(claim, [observation('a', 'insufficient')], sources).truth, 'UNKNOWN');
  assert.throws(() => claimSupport('different claim', [observation('a', 'supports')], sources), /exact claim/);
});

test('scope checks task, subject, conditions and metrics separately', () => {
  const source = evidence(); assert.equal(scopeMatch(source.scope, source).truth, 'TRUE');
  for (const scope of [{ task: 'other' }, { subject: 'model B' }, { conditions: ['1M'] }, { metrics: ['accuracy'] }]) assert.equal(scopeMatch(scope, source).truth, 'FALSE');
  assert.equal(scopeMatch({ task: 'bounded' }, evidence('a', { scope: {} })).truth, 'UNKNOWN');
});

test('conflict policy is explicit and never resolves contradiction by counting votes', () => {
  assert.equal(handleConflict([evidence('a'), evidence('b')], [evidence('c')], { version: 'v1', mode: 'abstain' }).truth, 'UNKNOWN');
  assert.equal(handleConflict([], [evidence('a')], { version: 'v1', mode: 'request-more' }).truth, 'FALSE');
  assert.throws(() => handleConflict([], [], { version: '', mode: 'guess' }), /policy/);
});

test('freshness uses explicit timestamps and versions with no model date inference', () => {
  const now = '2026-09-20T00:00:10.000Z';
  assert.equal(freshness(evidence(), now, 10_000).truth, 'TRUE');
  assert.equal(freshness(evidence(), now, 9999).reason, 'evidence_stale');
  assert.equal(freshness(evidence(), now, 20_000, 'v2').truth, 'FALSE');
  assert.equal(freshness(evidence('a', { freshness: {} }), now, 20_000).reason, 'observation_time_missing');
  assert.equal(freshness(evidence(), '2026-09-19T23:59:59.000Z', 20_000).reason, 'observation_in_future');
});

test('deterministic veto has recorded precedence; UNKNOWN never permits action', () => {
  const values = [{ id: 'approval', truth: 'TRUE', priority: 3, veto: false, reason: 'approved' }, { id: 'safety', truth: 'FALSE', priority: 1, veto: true, reason: 'too much energy' }, { id: 'missing', truth: 'UNKNOWN', priority: 2, veto: false, reason: 'unobserved' }];
  const result = constraints(values); assert.equal(result.truth, 'FALSE'); assert.equal(result.reason, 'constraint_veto'); assert.deepEqual(result.metadata.precedence, ['safety', 'missing', 'approval']);
  assert.equal(constraints(values.filter(v => v.id !== 'safety')).truth, 'UNKNOWN');
});

test('uncertainty policy routing requires full provider/model/language/scenario identity', () => {
  const route = { nodeId: 'claim', provider: 'localjev', model: 'small', language: 'zh-TW', scenario: 'research' };
  const policy = { ...route, version: 'v1', policy: { type: 'noul', falseAt: .2, trueAt: .8 } };
  assert.deepEqual(uncertaintyRouting([policy], route), policy);
  assert.equal(uncertaintyRouting([policy], { ...route, provider: 'typesafe' }), null);
  assert.throws(() => uncertaintyRouting([policy, policy], route), /Ambiguous/);
});

test('failure to find a counterexample is UNKNOWN, never a proof', () => {
  assert.equal(counterexample([{ id: 'one', witness: 1 }], n => n > 10).truth, 'UNKNOWN');
  assert.equal(counterexample([{ id: 'eleven', witness: 11 }], n => n > 10).truth, 'FALSE');
});

test('structural coverage only checks requested dimensions and rejects missing node mappings', () => {
  const circuit = { version: 1, name: 'coverage', nodes: [{ id: 'n', kind: 'constant', value: 'TRUE' }], outputs: ['n'] };
  assert.equal(coverageCheck(['latency'], { latency: ['n'] }, circuit).truth, 'TRUE');
  assert.equal(coverageCheck(['latency', 'cost'], { latency: ['n'] }, circuit).truth, 'FALSE');
  assert.throws(() => coverageCheck(['latency'], { latency: ['missing'] }, circuit), /missing nodes/);
});

test('temporal contracts define boundaries, gaps, stale samples and missing data', () => {
  const contract = { version: 'v1', now: '2026-09-20T00:00:10.000Z', windowMs: 10_000, maxGapMs: 5000, minSamples: 2, mode: 'all' };
  const observations = [{ at: '2026-09-20T00:00:00.000Z', truth: 'TRUE', evidenceId: 'a' }, { at: '2026-09-20T00:00:05.000Z', truth: 'TRUE', evidenceId: 'b' }];
  assert.equal(temporalCondition(observations, contract).truth, 'TRUE');
  assert.equal(temporalCondition(observations.slice(0, 1), contract).reason, 'temporal_missing_samples');
  assert.equal(temporalCondition(observations, { ...contract, maxGapMs: 4000 }).reason, 'temporal_gap_or_stale');
  assert.equal(temporalCondition([observations[0], { ...observations[1], truth: 'FALSE' }], contract).truth, 'FALSE');
  assert.throws(() => temporalCondition([observations[0], observations[0]], contract), /Duplicate/);
});

test('subcircuit contracts verify namespace and require a new version on modification', () => {
  const input = { id: 'bounded', version: '1.0.0', inputSchema: { type: 'object' }, outputContract: { n: 'truth' }, circuit: { version: 1, name: 'sub', nodes: [{ id: 'n', kind: 'constant', value: 'TRUE' }], outputs: ['n'] }, testsDigest: digest(['test passed']) };
  const first = versionedSubcircuit(input); assert.equal(mountVersionedSubcircuit('mounted', first).nodes[0].id, 'mounted.n');
  assert.throws(() => versionedSubcircuit({ ...input, testsDigest: digest(['new tests']) }, first), /new version/);
  assert.equal(versionedSubcircuit({ ...input, version: '1.0.1', testsDigest: digest(['new tests']) }, first).version, '1.0.1');
  assert.equal(semanticGateCatalog.length, 11); assert.ok(semanticGateCatalog.every(g => g.calibrationVersion === null));
});
