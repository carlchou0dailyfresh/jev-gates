import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunStore } from '../dist/workbench-store.js';

test('research CLI writes evaluation summaries outside the immutable run library', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'jev-research-cli-')));
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  try {
    const result = await promisify(execFile)(process.execPath, [cli, 'evaluate'], { cwd: directory });
    const output = JSON.parse(result.stdout);
    assert.equal(output.report.status, 'passed');
    assert.ok(output.file.startsWith(join(directory, '.jev-runs', 'reports') + '/'));
    assert.equal(JSON.parse(await readFile(output.file, 'utf8')).scope, 'deterministic-engineering-only');
    assert.deepEqual(await new RunStore(join(directory, '.jev-runs')).list(), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
