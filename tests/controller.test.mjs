import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller, FileCheckpointStore, controllerDefinitionDigest } from '../dist/controller.js';

const definition = () => ({
  id: 'report', version: '1', initial: 'export', maxSteps: 4,
  states: { export: { gate: 'ready', tool: 'export', next: 'done' }, done: { terminal: true } },
});
function setup(overrides = {}) {
  const calls = [];
  const options = {
    evaluate: async () => 'TRUE',
    tools: { export: {
      execute: async (snapshot, context) => { calls.push({ snapshot, context }); return { exists: true }; },
      verify: async receipt => receipt?.exists === true,
    } },
    ...overrides,
  };
  return { options, calls, controller: new Controller(definition(), options) };
}

test('TRUE executes an allowlisted tool and completes only after exact verification', async () => {
  const { controller, calls } = setup();
  const completed = await controller.step({ text: 'Report ready' });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.state, 'done');
  assert.equal(completed.steps, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].snapshot, { text: 'Report ready' });
  assert.equal(calls[0].context.state, 'export');
  assert.match(calls[0].context.operationId, /^[0-9a-f-]{36}$/);
  assert.ok(!JSON.stringify(completed).includes('Report ready'));
  await assert.rejects(controller.step({}), /completed/);
});

test('UNKNOWN pauses, never executes, and requires explicit review with a fresh snapshot', async () => {
  const snapshots = [];
  const { controller, calls } = setup({ evaluate: async (_gate, snapshot) => { snapshots.push(snapshot); return snapshot.ready ? 'TRUE' : 'UNKNOWN'; } });
  assert.equal((await controller.step({ ready: false })).status, 'paused');
  assert.equal(calls.length, 0);
  await assert.rejects(controller.step({ ready: true }), /paused/);
  await controller.resumeAfterReview();
  assert.equal((await controller.step({ ready: true })).status, 'completed');
  assert.deepEqual(snapshots, [{ ready: false }, { ready: true }]);
  assert.equal(calls.length, 1);
});

test('invalid evaluator output and exceptions never become TRUE', async () => {
  for (const evaluate of [async () => true, async () => { throw new Error('model unavailable'); }]) {
    const { controller, calls } = setup({ evaluate });
    assert.equal((await controller.step({})).status, 'paused');
    assert.equal(calls.length, 0);
  }
});

test('FALSE waits without tool execution and repeated waits consume the step budget', async () => {
  const { controller, calls } = setup({ evaluate: async () => 'FALSE' });
  for (let i = 1; i <= 4; i++) {
    const checkpoint = await controller.step({ iteration: i });
    assert.equal(checkpoint.steps, i);
    assert.equal(checkpoint.status, i === 4 ? 'exhausted' : 'waiting');
  }
  assert.equal(calls.length, 0);
  await assert.rejects(controller.step({}), /exhausted/);
});

test('FALSE can take an explicit nonterminal branch, but cannot claim completion', async () => {
  const def = definition();
  def.states.export.onFalse = 'retry';
  def.states.retry = { gate: 'retry-ready', tool: 'export', next: 'done' };
  const { options, calls } = setup({ evaluate: async gate => gate === 'ready' ? 'FALSE' : 'TRUE' });
  const controller = new Controller(def, options);
  assert.equal((await controller.step({})).state, 'retry');
  assert.equal(calls.length, 0);
  assert.equal((await controller.step({})).status, 'completed');
  def.states.export.onFalse = 'done';
  assert.throws(() => new Controller(def, options), /FALSE cannot complete/);
});

test('failed or throwing verification remains pending until external evidence is verified', async () => {
  for (const mode of ['false', 'throw', 'truthy']) {
    let executions = 0;
    const { controller } = setup({ tools: { export: {
      execute: async () => { executions++; return { exists: false }; },
      verify: async receipt => {
        if (receipt.exists) return true;
        if (mode === 'throw') throw new Error('missing file');
        return mode === 'truthy' ? 'yes' : false;
      },
    } } });
    const pending = await controller.step({});
    assert.equal(pending.status, 'pending');
    assert.equal(pending.reason, mode === 'throw' ? 'verification_error' : 'verification_failed');
    await assert.rejects(controller.step({}), /pending/);
    assert.equal((await controller.resolvePending({ exists: true })).status, 'completed');
    assert.equal(executions, 1);
  }
});

test('tool failure is ambiguous and never retried automatically after restore', async () => {
  let executions = 0;
  let saved;
  const store = { save: async checkpoint => { saved = structuredClone(checkpoint); }, load: async () => saved };
  const { options, controller } = setup({ store, tools: { export: {
    execute: async () => { executions++; throw new Error('connection lost after submission'); },
    verify: receipt => receipt.operationId === saved.pending.operationId,
  } } });
  assert.equal((await controller.step({ password: 'not persisted' })).reason, 'tool_error');
  const operationId = saved.pending.operationId;
  assert.ok(!JSON.stringify(saved).includes('password'));
  const restored = new Controller(definition(), { ...options, checkpoint: await store.load() });
  await assert.rejects(restored.step({}), /pending/);
  await assert.rejects(restored.resumeAfterReview(), /Only a paused/);
  assert.equal((await restored.resolvePending({ operationId })).status, 'completed');
  assert.equal(executions, 1);
});

test('pending is saved before execution and every intermediate checkpoint validates', async () => {
  const { options } = setup();
  const saved = [];
  const store = { load: async () => null, save: async checkpoint => {
    new Controller(definition(), { ...options, checkpoint });
    saved.push(structuredClone(checkpoint));
  } };
  const controller = new Controller(definition(), { ...options, store, tools: { export: {
    execute: async () => { assert.equal(saved.at(-1).status, 'pending'); return {}; }, verify: () => true,
  } } });
  await controller.step({ secret: 'never stored' });
  assert.deepEqual(saved.map(checkpoint => checkpoint.status), ['paused', 'pending', 'completed']);
  assert.ok(!JSON.stringify(saved).includes('secret'));
});

test('save failures before execution prevent actions; failures after execution retain pending', async () => {
  for (const failureAt of [1, 2, 3]) {
    let writes = 0;
    const store = { load: async () => null, save: async () => { if (++writes === failureAt) throw new Error('disk full'); } };
    const { controller, calls } = setup({ store });
    await assert.rejects(controller.step({}), /disk full/);
    assert.equal(calls.length, failureAt === 3 ? 1 : 0);
    if (failureAt === 3) assert.equal(controller.checkpoint.status, 'pending');
  }
});

test('last budgeted step can complete, and its intermediate checkpoint remains valid', async () => {
  const def = { ...definition(), maxSteps: 1 };
  const { options } = setup();
  const store = { load: async () => null, save: async checkpoint => { new Controller(def, { ...options, checkpoint }); } };
  const controller = new Controller(def, { ...options, store });
  assert.equal((await controller.step({})).status, 'completed');
});

test('instance rejects concurrent step and recovery calls', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { controller } = setup({ evaluate: async () => gate });
  const running = controller.step({});
  await assert.rejects(controller.step({}), /already running/);
  await assert.rejects(controller.resumeAfterReview(), /already running/);
  await assert.rejects(controller.resolvePending({}), /already running/);
  release('TRUE');
  assert.equal((await running).status, 'completed');
});

test('definition digest is order independent and rejects stale plans', async () => {
  const { options, controller } = setup();
  const def = definition();
  const reordered = { states: { done: def.states.done, export: def.states.export }, initial: def.initial, version: def.version, maxSteps: def.maxSteps, id: def.id };
  assert.equal(controllerDefinitionDigest(def), controllerDefinitionDigest(reordered));
  assert.throws(() => new Controller({ ...def, version: '2' }, { ...options, checkpoint: controller.checkpoint }), /digest mismatch/);
});

test('malformed checkpoints and missing allowlisted tools are rejected', async () => {
  const { options, controller } = setup();
  const valid = controller.checkpoint;
  for (const checkpoint of [
    null, {}, { ...valid, state: 'unknown' }, { ...valid, steps: -1 }, { ...valid, steps: 1.5 },
    { ...valid, status: 'completed' }, { ...valid, status: 'exhausted' }, { ...valid, pending: {} },
    { ...valid, snapshot: { secret: 'no' } }, { ...valid, status: 'pending', steps: 1, reason: 'awaiting_receipt', pending: {} },
    { ...valid, status: 'paused', reason: 'condition_unknown', steps: 4 },
  ]) assert.throws(() => new Controller(definition(), { ...options, checkpoint }), /Invalid controller data/);
  assert.throws(() => new Controller(definition(), { ...options, tools: {} }), /needs execute and verify/);
});

test('file checkpoint store atomically saves private JSON and supports validated restore', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jev-controller-'));
  try {
    const path = join(directory, 'nested', 'checkpoint.json');
    const store = new FileCheckpointStore(path);
    assert.equal(await store.load(), null);
    const { controller, options } = setup({ store });
    await controller.step({ text: 'private snapshot' });
    const saved = await store.load();
    assert.equal(new Controller(definition(), { ...options, checkpoint: saved }).checkpoint.status, 'completed');
    assert.ok(!(await readFile(path, 'utf8')).includes('private snapshot'));
    if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
