import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fixtureMatrix } from './delivery-core.mjs';
import { compareDelivery, verifyDeliveryComparison } from './delivery-benchmark.mjs';
const [command = 'demo', filename = '.jev-runs/delivery/comparison.json', mode = 'fixture'] = process.argv.slice(2);
try {
  if (command === 'demo') {
    if (!['fixture', 'localjev'].includes(mode)) throw new Error('CLI demo only permits explicit fixture or localjev mode.');
    const scenario = JSON.parse(await readFile(new URL('../delivery-scenario.json', import.meta.url), 'utf8'));
    const matrix = fixtureMatrix(scenario.draft);
    const snapshot = { id: 'delivery-cli-fixture-matrix', draft: scenario.draft, matrix };
    const report = await compareDelivery(snapshot, { mode, events: scenario.events, thresholds: { falseAt: 0.2, trueAt: 0.8 }, prices: {} });
    await mkdir(dirname(resolve(filename)), { recursive: true }); await writeFile(filename, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ filename, mode, actual: report.actual, strategies: report.strategies.map(({ name, replans, modelRequests, modelQuestions, semanticMs, solverMs, totalMs, missedRefreshes, falseRefreshes, estimatedCostUsd, errors }) => ({ name, replans, modelRequests, modelQuestions, semanticMs, solverMs, totalMs, missedRefreshes, falseRefreshes, estimatedCostUsd, errors })), warnings: report.warnings }, null, 2));
  } else if (command === 'verify') {
    const text = await readFile(filename, 'utf8'); if (Buffer.byteLength(text) > 1024 * 1024) throw new Error('Report exceeds 1MiB.');
    console.log(JSON.stringify(await verifyDeliveryComparison(JSON.parse(text)), null, 2));
  } else throw new Error('Usage: delivery-research.mjs demo|verify [file] [fixture|localjev]');
} catch (error) { console.error(error.message); process.exitCode = 1; }
