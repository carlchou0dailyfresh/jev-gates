import fs from 'node:fs/promises';
import path from 'node:path';
import { evaluateDraft, replayRun } from './api.mjs';

const [command, filename = '.jev-runs/research-demo.json'] = process.argv.slice(2);
try {
  if (command === 'demo') {
    const scenarios = JSON.parse(await fs.readFile(new URL('../scenarios.json', import.meta.url), 'utf8'));
    const runs = [];
    for (const scenario of scenarios) runs.push(await evaluateDraft(scenario.draft, 'fixture'));
    // A separately labelled threshold experiment demonstrates abstention.
    const uncertain = structuredClone(scenarios[0].draft);
    uncertain.title += ' · UNKNOWN 門檻實驗';
    uncertain.gates[1].fixture = 0.5;
    runs.push(await evaluateDraft(uncertain, 'fixture'));
    const report = { schemaVersion: 1, kind: 'synthetic-fixture-demo', note: 'Fixture/mock 驗證不代表真實 JEV 準確率；沒有呼叫任何模型。', runs };
    await fs.mkdir(path.dirname(path.resolve(filename)), { recursive: true });
    await fs.writeFile(filename, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ report: filename, mode: report.kind, note: report.note, results: runs.map(run => ({ scenario: run.draft.title, truth: run.truth, branch: run.branch.title })) }, null, 2));
  } else if (command === 'verify-report' || command === 'replay') {
    const contents = await fs.readFile(filename, 'utf8');
    if (Buffer.byteLength(contents) > 1024 * 1024) throw new Error('報告超過 1 MiB 限制。');
    const report = JSON.parse(contents);
    const runs = report.schemaVersion === 1 && report.kind === 'synthetic-fixture-demo' ? report.runs : [report];
    if (!Array.isArray(runs) || runs.length === 0 || runs.length > 100) throw new Error('報告執行清單無效。');
    const checks = [];
    for (const run of runs) checks.push({ id: run.id, ...(await replayRun(run)) });
    console.log(JSON.stringify({ command, report: filename, offline: true, passed: checks.length, checks }, null, 2));
  } else throw new Error('Usage: research.mjs demo|verify-report|replay [report.json]');
} catch (error) {
  console.error(error instanceof Error ? error.message : '研究驗證失敗。');
  process.exitCode = 1;
}
