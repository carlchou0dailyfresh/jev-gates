/** Offline, reproducible engineering harness. No provider service is constructed here. */
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { EVAL_PROTOCOL, EVAL_PROTOCOL_DIGEST, evaluateComparisons, runEngineeringEvaluation } from '../dist/evaluation.js';
import { generateWorldDataset, WORLD_SPLITS } from '../dist/mini-world.js';
import { digest } from '../dist/json.js';

const out = fileURLToPath(new URL('./', import.meta.url));
await mkdir(join(out, 'reports'), { recursive: true });
// The protocol is serialized before dataset enumeration and any evaluation.
await writeFile(join(out, 'protocol.json'), JSON.stringify({ ...EVAL_PROTOCOL, protocolDigest: EVAL_PROTOCOL_DIGEST }, null, 2) + '\n');
const records = generateWorldDataset();
await writeFile(join(out, 'world-cases.jsonl'), records.map(r => JSON.stringify(r)).join('\n') + '\n');
await writeFile(join(out, 'manifest.json'), JSON.stringify({ schemaVersion: '1.0', generatorVersion: 'world-v1', labelsVersion: 'independent-executor-v1', splitVersion: 'family-isolated-v1', protocolDigest: EVAL_PROTOCOL_DIGEST, sourceKind: 'synthetic', language: 'zh-TW', families: WORLD_SPLITS, datasetDigest: digest(records), cases: records.map(({ world, ...record }) => record), limitations: ['Families are structurally isolated, not merely different seeds.', 'Within-family topology repeats. 120 heldout records are not 120 independent task families.', 'Labels are deterministic executor outcomes, not independently reviewed human judgments.'] }, null, 2) + '\n');
const engineering = await runEngineeringEvaluation();
await writeFile(join(out, 'reports', 'engineering.json'), JSON.stringify(engineering, null, 2) + '\n');
const comparisons = await evaluateComparisons({ maxCases: 48, ablations: ['none', 'no-second-layer', 'no-memory', 'no-counterexample'] });
const { artifacts, rows, ...summary } = comparisons;
await writeFile(join(out, 'reports', 'fixture-comparisons.json'), JSON.stringify({ ...summary, rowCount: rows.length, rowsDigest: digest(rows), artifactsOmittedFromSummary: artifacts.length, reproduction: 'npm run build && node eval/run.mjs', note: 'Run evaluateComparisons() through the library to retain all per-arm artifacts; this compact checked-in report is a fixture engineering summary, not model-quality evidence.' }, null, 2) + '\n');
console.log(JSON.stringify({ engineering: engineering.status, variants: engineering.cases.length, worldCases: records.length, heldout: records.filter(r => r.split === 'test').length, comparisonRows: rows.length, modelQuality: comparisons.modelQuality, protocolDigest: EVAL_PROTOCOL_DIGEST }));
if (engineering.status !== 'passed') process.exitCode = 1;
