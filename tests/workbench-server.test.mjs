import test from 'node:test';
import { request as httpRequest } from 'node:http';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWorkbench } from '../dist/workbench-server.js';

const json = async (app, path, value) => {
  const response = await fetch(app.url + path, value === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  return { status: response.status, value: await response.json() };
};
async function run(app, scenarioId = 'research', extra = {}) {
  const response = await json(app, '/api/runs', { scenarioId, variant: 'normal', seed: 42, mode: 'fixture', ...extra });
  assert.equal(response.status, 202, JSON.stringify(response));
  const id = response.value.jobId;
  for (let i = 0; i < 100; i++) {
    const job = (await json(app, '/api/jobs/' + id)).value;
    if (job.status !== 'running') { assert.equal(job.status, 'completed', job.error); return job.artifact; }
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error('Timed out waiting for fixture');
}
async function fixture(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'jev-workbench-'));
  const app = await startWorkbench({ port: 0, dataDir: dir });
  try { await fn(app, dir); } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
}
test('workbench serves genuine core events and immutable export/verify/replay, rejects tampering', async () => fixture(async app => {
  assert.equal((await json(app, '/api/scenarios')).value.length, 4);
  const artifact = await run(app);
  assert.ok(artifact.events.some(e => e.type === 'node_completed'));
  assert.equal((await json(app, '/api/verify', { artifact })).value.valid, true);
  const replay = (await json(app, '/api/replay', { artifact })).value;
  assert.equal(replay.valid, true, JSON.stringify(replay));
  assert.deepEqual(replay.result.outputs, artifact.result.outputs);
  assert.equal((await json(app, '/api/runs/' + artifact.runId)).value.integrity.digest, artifact.integrity.digest);
  const broken = structuredClone(artifact); broken.input = { altered: true };
  assert.equal((await json(app, '/api/import', { artifact: broken })).status, 400);
  assert.equal((await json(app, '/api/import', { artifact })).status, 200);
  const child = await run(app, 'research', { parentRunId: artifact.runId, changeReason: '測試修改來源', variant: 'missing' });
  assert.equal(child.parentRunId, artifact.runId);
  assert.notEqual(child.runId, artifact.runId);
  assert.equal((await json(app, '/api/runs/' + artifact.runId)).value.integrity.digest, artifact.integrity.digest);
  const capped = await run(app, 'research', { budget: { maxCostUsd: 0.25 } });
  assert.equal(capped.budget.limits.maxCostUsd, 0.25);
  assert.equal((await json(app, '/api/runs', { budget: { maxCostUsd: -0.1 } })).status, 400);
}));
test('loopback server rejects cross-origin, bad Host, executable/prototype input and cycles', async () => fixture(async app => {
  const foreign = await fetch(app.url + '/api/runs', { method: 'POST', headers: { origin: 'https://attacker.invalid', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(foreign.status, 403);
  const badHost = await new Promise(resolve => { httpRequest(app.url + '/api/scenarios', { headers: { host: 'attacker.invalid' } }, response => { response.resume(); resolve(response.statusCode); }).end(); }); assert.equal(badHost, 403);
  const prototype = await fetch(app.url + '/api/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"__proto__":{"polluted":true}}' }); assert.equal(prototype.status, 400);
  const deep = await fetch(app.url + '/api/import', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"x":' + '['.repeat(70) + '0' + ']'.repeat(70) + '}' }); assert.equal(deep.status, 400);
  const circuit = { version: 1, name: 'bad', nodes: [{ id: 'x', kind: 'logic', op: 'and', inputs: ['x'] }], outputs: ['x'] };
  assert.equal((await json(app, '/api/validate', { circuit })).value.valid, false);
  assert.equal((await json(app, '/api/runs', { scenarioId: 'research', circuit })).status, 400);
  assert.equal((await json(app, '/api/runs', { scenarioId: 'research', mode: 'arbitrary-cloud' })).status, 400);
}));
test('sandbox ambiguous completion stays pending, destination recovery and browser retry never resend', async () => fixture(async (app, dir) => {
  const artifact = await run(app, 'incident');
  const operation = (await json(app, `/api/runs/${artifact.runId}/action`, { kind: 'repair', fault: 'timeout-after-apply' })).value.artifact;
  assert.equal(operation.actions[0].status, 'pending');
  assert.equal(operation.actions[0].executionCount, 1);
  assert.equal((await json(app, '/api/runs/' + artifact.runId)).value.actions.length, 0);
  const recovered = (await json(app, `/api/runs/${operation.runId}/recover`, {})).value.artifact;
  assert.equal(recovered.actions[0].status, 'verified');
  assert.equal(recovered.actions[0].executionCount, 1);
  assert.equal((await json(app, `/api/runs/${recovered.runId}/recover`, {})).value.artifact.runId, recovered.runId);
  const retry = (await json(app, `/api/runs/${artifact.runId}/action`, { kind: 'repair', fault: 'none' })).value.artifact;
  assert.equal(retry.actions[0].operationId, operation.actions[0].operationId);
  assert.equal(retry.actions[0].executionCount, 1);
  const state = JSON.parse(await readFile(join(dir, 'sandbox', 'destination.json')));
  assert.equal(state.executionCount, 1);
  const second = await run(app, 'incident');
  const failed = (await json(app, `/api/runs/${second.runId}/action`, { kind: 'repair', fault: 'verification-failed' })).value.artifact;
  assert.equal(failed.actions[0].status, 'pending'); assert.equal(failed.actions[0].verification.passed, false);
  assert.equal((await json(app, `/api/runs/${failed.runId}/recover`, {})).value.artifact.actions[0].status, 'pending');
}));
test('run store uses private files, prevents a second server writer and detects corruption on reload', async () => fixture(async (app, dir) => {
  await assert.rejects(startWorkbench({ port: 0, dataDir: dir }), /locked/);
  const artifact = await run(app);
  const path = join(dir, artifact.runId + '.json'); assert.equal((await stat(path)).mode & 0o777, 0o600);
  await writeFile(path, '{}');
  assert.equal((await json(app, '/api/runs/' + artifact.runId)).status, 400);
}));
