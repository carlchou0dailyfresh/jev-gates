import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cases } from '../research/medication/data.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = path.join(root, 'research/medication/results/2026-09-22-gemma3-ab');
const data = JSON.parse(fs.readFileSync(path.join(dir, 'observations.json'), 'utf8'));
const summary = JSON.parse(fs.readFileSync(path.join(dir, 'analysis.json'), 'utf8'));
const python = process.env.PYTHON || 'python3';
const available = spawnSync(python, ['--version']).status === 0;
const script = path.join(root, 'research/medication/review_results.py');

test('imported reference labels are exactly the original eight synthetic dev cases', () => {
  assert.deepEqual(data.cases, cases.filter(c => c.split === 'dev'));
  assert.equal(data.observations.length, 16);
  assert.equal(summary.unique_cases, 8);
});
test('independent Python audit recomputes the committed summary without model calls', {skip: !available}, () => {
  const run = spawnSync(python, [script, '--input', path.join(dir, 'observations.json'), '--check', path.join(dir, 'analysis.json')], {encoding: 'utf8'});
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), summary);
});
test('recorded success is routing-only and does not hide English drafts or citation failures', () => {
  for (const arm of ['A', 'B']) {
    assert.equal(summary.arms[arm].raw_correct, 8);
    assert.equal(summary.arms[arm].emergency_n, 1);
    assert.equal(summary.arms[arm].drafts_without_any_han_character, 8);
    assert.equal(summary.arms[arm].professional_factuality_score, null);
  }
  assert.equal(summary.arms.A.citation_namespace_errors, 1);
  assert.equal(summary.arms.B.responses_with_valid_nonempty_citations, 7);
  assert.equal(summary.comparison.generalizable_effect_interval, null);
  assert.equal(summary.claims.laya_or_jev_evaluated, false);
});
test('independent review rejects duplicates, mock substitution, mismatched model and negative latency', {skip: !available}, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'med-import-review-'));
  try {
    const edits = [
      d => { d.observations[1] = structuredClone(d.observations[0]); },
      d => { d.observations[0].mode = 'fixture'; },
      d => { d.observations[0].returned_model = 'other-model'; },
      d => { d.observations[0].wall_ms = -1; },
    ];
    for (const edit of edits) {
      const changed = structuredClone(data); edit(changed);
      const input = path.join(temp, 'observations.json'); fs.writeFileSync(input, JSON.stringify(changed));
      const run = spawnSync(python, [script, '--input', input], {encoding: 'utf8'});
      assert.notEqual(run.status, 0);
    }
  } finally { fs.rmSync(temp, {recursive: true, force: true}); }
});
test('editing an otherwise well-formed observation cannot silently retain the old published summary', {skip: !available}, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'med-import-summary-'));
  try {
    const changed = structuredClone(data); changed.observations[0].wall_ms += 1;
    const input = path.join(temp, 'observations.json'); fs.writeFileSync(input, JSON.stringify(changed));
    const run = spawnSync(python, [script, '--input', input, '--check', path.join(dir, 'analysis.json')], {encoding: 'utf8'});
    assert.notEqual(run.status, 0);
  } finally { fs.rmSync(temp, {recursive: true, force: true}); }
});
