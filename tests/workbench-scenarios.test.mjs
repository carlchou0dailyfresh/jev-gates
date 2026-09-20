import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { evaluateDraft, replayRun } from '../workbench/server/api.mjs';

const scenarios = JSON.parse(await fs.readFile(new URL('../workbench/scenarios.json', import.meta.url), 'utf8'));
const offline = { fetch: async () => { throw new Error('Fixture execution must not use network'); } };

test('all shipped scenarios have executable fixtures and offline-consistent branches', async () => {
  const expected = { research: 'FALSE', support: 'TRUE', incident: 'TRUE', planning: 'FALSE' };
  for (const scenario of scenarios) {
    const run = await evaluateDraft(scenario.draft, 'fixture', offline);
    assert.equal(run.truth, expected[scenario.id]);
    assert.equal(run.branch.title, scenario.draft.branches[run.truth].title);
    assert.equal(run.provenance.calibrated, false);
    assert.equal((await replayRun(JSON.parse(JSON.stringify(run)))).valid, true);
  }
});

test('the same research input reaches distinct branches through explicit threshold experiments', async () => {
  const draft = structuredClone(scenarios[0].draft);
  for (const [value, expected] of [[0.12, 'FALSE'], [0.5, 'UNKNOWN'], [0.92, 'TRUE']]) {
    draft.gates[1].fixture = value;
    const run = await evaluateDraft(draft, 'fixture', offline);
    assert.equal(run.truth, expected);
    assert.equal(run.result.status, expected === 'UNKNOWN' ? 'abstained' : 'evaluated');
  }
});

test('AND, OR and quorum honor enabled gates and preserve UNKNOWN', async () => {
  const draft = structuredClone(scenarios[0].draft);
  draft.gates[1].fixture = 0.5;
  draft.combination = 'and';
  assert.equal((await evaluateDraft(draft, 'fixture', offline)).truth, 'UNKNOWN');
  draft.combination = 'or';
  assert.equal((await evaluateDraft(draft, 'fixture', offline)).truth, 'TRUE');
  draft.combination = 'kofn'; draft.k = 3;
  assert.equal((await evaluateDraft(draft, 'fixture', offline)).truth, 'UNKNOWN');
  draft.k = 2;
  assert.equal((await evaluateDraft(draft, 'fixture', offline)).truth, 'TRUE');
  draft.gates[0].enabled = false;
  assert.equal((await evaluateDraft(draft, 'fixture', offline)).truth, 'UNKNOWN');
});

test('editing task text changes input provenance without pretending fixtures understand language', async () => {
  const draft = structuredClone(scenarios[1].draft);
  const before = await evaluateDraft(draft, 'fixture', offline);
  draft.task = 'This entirely different task must not change a fixed fixture.';
  const after = await evaluateDraft(draft, 'fixture', offline);
  assert.equal(before.truth, after.truth);
  assert.notEqual(before.result.inputDigest, after.result.inputDigest);
  assert.notEqual(before.digest, after.digest);
  assert.equal(before.draft.task, scenarios[1].draft.task);
});
