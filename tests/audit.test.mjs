import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRunArtifact, verifyArtifact } from '../dist/artifact.js';
import { LocalJevProvider } from '../dist/providers/index.js';
import { startWorkbench } from '../dist/workbench-server.js';
import { getScenario } from '../dist/scenarios.js';

const post = async (app, path, value) => {
  const response = await fetch(app.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { status: response.status, value: await response.json() };
};
async function serverFixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'jev-independent-audit-'));
  const app = await startWorkbench({ port: 0, dataDir: dir });
  try { await fn(app); } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
}
async function completed(app, jobId) {
  for (let i = 0; i < 100; i++) {
    const response = await fetch(app.url + '/api/jobs/' + jobId), job = await response.json();
    if (job.status !== 'running') { assert.equal(job.status, 'completed', job.error); return job.artifact; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  throw new Error('Fixture did not finish');
}

test('edited evidence register is also the evidence used by research source gates and semantic claims', async () => serverFixture(async app => {
  const scenario = getScenario('research');
  const response = await post(app, '/api/runs', { scenarioId: 'research', mode: 'fixture', input: scenario.input, evidence: [] });
  assert.equal(response.status, 202);
  const artifact = await completed(app, response.value.jobId);
  assert.deepEqual(artifact.input.evidence, [], 'Removed source must not remain available to exact gates');
  for (const claim of Object.values(artifact.input.claims)) assert.deepEqual(claim.evidence, [], 'Removed source must not remain in semantic request input');
  assert.notEqual(artifact.result.signals['evidence-ready'].truth, 'TRUE');
}));

test('a provider echoing the API credential in normalized model fields cannot retain it in artifacts', async () => {
  const secret = 'audit-placeholder-credential', original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ model: secret, upstream_model: secret, answers: { check: { type: 'noul', noul: 1 } } }), { status: 200 });
  try {
    const artifact = await createRunArtifact({ circuit: { version: 1, name: 'secret-echo', nodes: [{ id: 'check', kind: 'semantic', question: { type: 'noul', instructions: 'Is it true?' }, policy: { type: 'noul', falseAt: .2, trueAt: .8 } }], outputs: ['check'] }, input: {}, provider: new LocalJevProvider({ apiKey: secret }), mode: 'live-localjev' });
    assert.equal(JSON.stringify(artifact).includes(secret), false, 'Redaction must include normalized response, call trace and DecisionSignal metadata');
    assert.equal((await verifyArtifact(artifact)).valid, true);
  } finally { globalThis.fetch = original; }
});

test('two simultaneous live starts cannot bypass the one-active-run admission guard', async () => {
  const bridge = createServer(async (req, res) => {
    if (req.url === '/ready') { await new Promise(resolve => setTimeout(resolve, 40)); res.end(JSON.stringify({ upstream_model: 'audit-fixture-model' })); return; }
    let text = ''; for await (const chunk of req) text += chunk;
    const request = JSON.parse(text); await new Promise(resolve => setTimeout(resolve, 80));
    res.end(JSON.stringify({ model: 'audit-fixture-bridge', answers: Object.fromEntries(Object.keys(request.questions).map(id => [id, { type: 'choice', choice: 'insufficient', probabilities: { support: 0, refute: 0, insufficient: 1, mixed: 0 }, confidence: 1 }])) }));
  });
  await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
  const oldBase = process.env.LOCALJEV_BASE_URL;
  process.env.LOCALJEV_BASE_URL = `http://127.0.0.1:${bridge.address().port}`;
  try { await serverFixture(async app => {
    const responses = await Promise.all([post(app, '/api/runs', { scenarioId: 'incident', mode: 'live-localjev' }), post(app, '/api/runs', { scenarioId: 'incident', mode: 'live-localjev' })]);
    assert.deepEqual(responses.map(response => response.status).sort(), [202, 400], 'Exactly one start may enter provider readiness/evaluation');
  }); } finally {
    if (oldBase === undefined) delete process.env.LOCALJEV_BASE_URL; else process.env.LOCALJEV_BASE_URL = oldBase;
    await new Promise(resolve => bridge.close(resolve));
  }
});

test('station rejects delimiter-containing task IDs before subset search can collide', async () => {
  const { solveStation, verifyStationPlan } = await import('../dist/planning.js');
  const problem = { energy: 2, minutes: 2, instruments: ['tool'], initial: [], goals: ['fa', 'fb'], tasks: [
    { id: 'a', energy: 1, minutes: 1, instrument: 'tool', requires: [], produces: ['fa'] },
    { id: 'b', energy: 1, minutes: 1, instrument: 'tool', requires: [], produces: ['fb'] },
    { id: 'a|b', energy: 2, minutes: 2, instrument: 'tool', requires: [], produces: ['unrelated'] },
  ] };
  assert.throws(() => verifyStationPlan(problem, ['a', 'b']), /Invalid station task/);
  assert.throws(() => solveStation(problem), /Invalid station task/);
});

test('world manifest validation rejects a changed independent label even if source world is intact', async () => {
  const { generateWorldDataset, assertFamilyIsolation } = await import('../dist/mini-world.js');
  const records = generateWorldDataset();
  records[0].label = records[0].label === 'TRUE' ? 'FALSE' : 'TRUE';
  assert.throws(() => assertFamilyIsolation(records), /label|executor|manifest/i);
});

test('counterexample ablation removes stale derived conflict evidence as well as source text', async () => {
  const { comparisonFixture } = await import('../dist/evaluation.js');
  const fixture = comparisonFixture(getScenario('research', 'conflict'), 'atomic-program', 'no-counterexample');
  assert.equal(fixture.input.gates.conflictResolved, true);
  assert.deepEqual(fixture.input.gateDecisions.conflict.metadata.refute ?? [], []);
  assert.equal(JSON.stringify(fixture.input).includes('synthetic-counterexample'), false);
});

test('quality sample sufficiency is assessed per live stratum rather than across comparison arms', async () => {
  const { evaluateComparisons } = await import('../dist/evaluation.js');
  const providerFactory = () => ({ name: 'audit-provider', model: 'audit-fixture-v1', evaluate: async (_state, questions) => ({ model: 'audit-fixture-v1', answers: Object.fromEntries(Object.entries(questions).map(([id, question]) => {
    const labels = Object.keys(question.criteria), choice = labels[0];
    return [id, { type: 'choice', choice, probabilities: Object.fromEntries(labels.map(label => [label, label === choice ? 1 : 0])), confidence: 1 }];
  })) }) });
  const report = await evaluateComparisons({ providerFactory, scenarioIds: ['incident'], maxCases: 8 });
  assert.ok(report.rows.length >= 30);
  assert.ok(Object.values(report.strata).every(metrics => metrics.n < 30));
  assert.equal(report.qualityGate, 'insufficient_samples');
});
