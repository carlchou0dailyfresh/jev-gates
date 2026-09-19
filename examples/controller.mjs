// Local simulation: the condition fixture is NOT a live JEV call or browser workflow.
// Run: npm run build && node examples/controller.mjs
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Controller, FileCheckpointStore } from '../dist/controller.js';

const directory = await mkdtemp(join(tmpdir(), 'jev-gates-report-'));
const reportPath = join(directory, 'report.csv');
const definition = {
  id: 'verified-report-export', version: 'fixture-v1', initial: 'export', maxSteps: 3,
  states: {
    export: { gate: 'export-ready', tool: 'write-csv', next: 'complete' },
    complete: { terminal: true },
  },
};
const controller = new Controller(definition, {
  store: new FileCheckpointStore(join(directory, 'checkpoint.json')),
  // Replace this fixture with a circuit's output truth. Each step receives a fresh snapshot.
  evaluate: async (_gate, snapshot) => snapshot.status === 'ready' ? 'TRUE' : 'UNKNOWN',
  tools: {
    'write-csv': {
      execute: async (_snapshot, context) => {
        await writeFile(reportPath, 'date,total\n2026-09-01,42\n', { flag: 'wx', mode: 0o600 });
        return { path: reportPath, operationId: context.operationId };
      },
      verify: async (receipt, context) => {
        if (receipt?.path !== reportPath || receipt?.operationId !== context.operationId) return false;
        const content = await readFile(reportPath, 'utf8');
        const rows = content.trim().split('\n');
        return rows[0] === 'date,total' && rows.length > 1
          && rows.slice(1).every(row => /^\d{4}-\d{2}-\d{2},\d+(?:\.\d+)?$/.test(row));
      },
    },
  },
});
const checkpoint = await controller.step({ status: 'ready' });
console.log(JSON.stringify({ simulation: true, status: checkpoint.status, reportPath, checkpointPath: join(directory, 'checkpoint.json') }, null, 2));
