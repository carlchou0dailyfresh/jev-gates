import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir, platform, arch, cpus } from 'node:os';
import { resolve, join } from 'node:path';
import { chromium } from 'playwright';
import { startWorkbench } from '../../dist/workbench-server.js';
import { verifyArtifact, replayArtifact } from '../../dist/artifact.js';

const output = resolve('../output/playwright');
await mkdir(output, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), 'jev-ui-'));
// These tests deliberately use fixtures. No model service is required.
process.env.LOCALJEV_BASE_URL = 'http://127.0.0.1:1';
const app = await startWorkbench({ port: 0, dataDir: directory });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const failures = [], checks = [], performance = [], viewports = [];
let rejectingCorruptImport = false, expectedImportRejections = 0;
page.on('pageerror', error => failures.push(error.message));
page.on('console', message => { if (message.type() === 'error') { if (rejectingCorruptImport && message.location().url.endsWith('/api/import') && message.text().includes('400')) { expectedImportRejections++; return; } failures.push(message.text()); } });
const done = name => { checks.push(name); console.log('PASS ' + name); };
async function runButton() {
  const previousCount = (await app.store.list()).length;
  await page.getByRole('button', { name: /^(執行電路|執行新分支)$/ }).click();
  await page.getByRole('button', { name: '匯出執行包 ↓', exact: true }).waitFor();
  let saved;
  for (let i=0;i<100;i++) { const all=await app.store.list(); if(all.length>previousCount){ saved=all[0];break; } await new Promise(r=>setTimeout(r,50)); }
  assert.ok(saved, 'Run artifact was not saved');
  await page.locator('.change-reason').filter({hasText:saved.runId.slice(0,12)}).waitFor();
  return saved;
}
async function scenario(name) {
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await page.getByRole('button', { name: '執行電路', exact: true }).waitFor();
}
try {
  await page.goto(app.url);
  await page.getByRole('button', { name: '執行電路', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('.run-button')?.disabled && document.querySelectorAll('.react-flow__node').length > 0);
  const first = await runButton();
  assert.equal(first.mode, 'fixture');
  assert.equal(first.result.outputs.conclusion.truth, 'TRUE');
  assert.equal(first.result.outputs['claim-cost'].truth, 'FALSE');
  assert.equal(first.result.outputs['claim-freshness'].truth, 'UNKNOWN');
  await page.locator('.node-directory button').filter({ hasText: 'claim-freshness' }).click();
  assert.match(await page.locator('.desktop-inspector').innerText(), /需要補充的資料/);
  done('research TRUE/FALSE/UNKNOWN and inspector match saved core signals');

  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '匯出執行包 ↓', exact: true }).click();
  await (await downloading).saveAs(join(output, 'browser-export.json'));
  const exported = JSON.parse(await readFile(join(output, 'browser-export.json')));
  assert.equal((await verifyArtifact(exported)).valid, true);
  const savedFetch = globalThis.fetch; globalThis.fetch = () => { throw new Error('Offline replay must not call fetch'); };
  try { const replay = await replayArtifact(exported); assert.equal(replay.valid, true); assert.deepEqual(replay.result.outputs, exported.result.outputs); }
  finally { globalThis.fetch = savedFetch; }
  await page.getByRole('button', { name: '驗證完整性', exact: true }).click();
  await page.getByRole('button', { name: '離線重播', exact: true }).click();
  await page.getByRole('button', { name: '下一步 →', exact: true }).click();
  await page.getByRole('button', { name: '← 上一步', exact: true }).click();
  done('UI export → integrity verification → offline zero-fetch replay → next/back');

  await page.getByRole('button', { name: '編輯電路', exact: true }).click();
  const editor = page.getByRole('dialog', { name: '編輯完整電路' });
  const invalid = JSON.parse(await editor.getByRole('textbox').inputValue());
  invalid.nodes.push({ id: 'invalid_cycle', kind: 'logic', op: 'and', inputs: ['invalid_cycle'] });
  await editor.getByRole('textbox').fill(JSON.stringify(invalid));
  await editor.getByRole('button', { name: '驗證並套用' }).click();
  await editor.getByRole('alert').waitFor();
  assert.match(await editor.getByRole('alert').innerText(), /cycle/i);
  await editor.getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), '編輯電路');
  done('invalid DAG rejected immediately; dialog returns keyboard focus');

  await page.locator('.node-directory button').filter({ hasText: 'claim-accuracy' }).click();
  await page.locator('.desktop-inspector').getByRole('button', { name: '編輯節點', exact: true }).click();
  const nodeEditor = page.getByRole('dialog', { name: '編輯節點與政策' });
  const node = JSON.parse(await nodeEditor.getByRole('textbox').inputValue());
  node.policy.trueLabels = ['refute']; node.policy.falseLabels = ['support'];
  await nodeEditor.getByRole('textbox').fill(JSON.stringify(node));
  await nodeEditor.getByRole('button', { name: '驗證並套用' }).click();
  await nodeEditor.waitFor({state:'hidden'});
  await page.getByPlaceholder('例如：加入相反證據，重新檢查適用範圍').fill('Browser test: explicit policy reversal');
  const child = await runButton();
  assert.equal(child.parentRunId, first.runId);
  assert.equal(child.result.outputs.conclusion.truth, 'FALSE');
  assert.equal((await app.store.get(first.runId)).result.outputs.conclusion.truth, 'TRUE');
  await page.getByRole('button', { name: '比較分支', exact: true }).click();
  await page.getByRole('cell', { name: '節點已變更', exact: true }).waitFor();
  done('policy branch preserves original model response and displays comparison');

  await page.getByRole('button', { name: '01 電路工作台', exact: true }).click();
  await scenario('虛構服務事故');
  const incident = await runButton(); assert.equal(incident.scenarioId, 'incident');
  await page.getByRole('button', { name: '注入：修復成功但回應逾時', exact: true }).click();
  await page.locator('.action-record .tag').filter({ hasText: /^pending$/ }).waitFor();
  await page.getByRole('button', { name: '查詢 pending／復原', exact: true }).click();
  await page.locator('.action-record .tag').filter({ hasText: /^verified$/ }).waitFor();
  const recovered = (await app.store.list())[0]; assert.equal(recovered.actions[0].executionCount, 1);
  await page.reload();
  await page.getByRole('button', { name: '04 執行庫', exact: true }).click();
  await page.getByRole('button', { name: '開啟紀錄', exact: true }).first().click();
  await page.getByRole('button', { name: '查詢 pending／復原', exact: true }).click();
  assert.equal((await app.store.list())[0].actions[0].executionCount, 1);
  done('sandbox timeout → pending → destination recovery; reload does not duplicate action');

  await scenario('探測站有限規劃');
  await runButton();
  // Structured controls regenerate an independently solved input, preserving the old plan.
  await page.getByText('調整探測站資源與可用儀器', {exact:true}).click();
  await page.getByLabel('可用能源', { exact: true }).fill('3');
  await page.getByRole('button', { name: '套用限制／重新產生', exact: true }).click();
  await page.getByPlaceholder('例如：加入相反證據，重新檢查適用範圍').fill('Energy reduced to 3');
  const replanned = await runButton();
  assert.equal(replanned.result.outputs['resource-feasible'].truth, 'FALSE');
  done('planning constraint change recomputes feasibility and keeps parent plan');

  await scenario('未見規則迷你世界');
  await page.getByRole('combobox', { name: '路徑', exact: true }).selectOption('missing');
  const hidden = await runButton(); assert.equal(hidden.result.outputs.conclusion.truth, 'UNKNOWN');
  done('mini-world hidden-observation path runs end-to-end');

  for (const width of [360, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: join(output, `workbench-${width}.png`) });
    const metrics = await page.evaluate(() => ({ width: innerWidth, contentWidth: document.documentElement.scrollWidth, reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches }));
    assert.ok(metrics.contentWidth <= width, JSON.stringify(metrics));
    viewports.push(metrics);
    if (width < 1050) {
      await page.locator('.node-directory button').filter({ hasText: 'reachable' }).click();
      const inspector = page.getByRole('dialog', { name: '節點檢視器' });
      await inspector.getByRole('button', { name: '原文', exact: true }).click();
      await inspector.getByRole('button', { name: '關閉節點檢視器', exact: true }).click();
      assert.match(await page.evaluate(() => document.activeElement?.textContent), /reachable/);
    }
  }
  done('360/768/1440 no horizontal overflow; mobile paged inspector and focus return');

  await page.getByText('互動效能觀察 · 20 / 100 / 256 節點', { exact: true }).click();
  for (const size of [20, 100, 256]) {
    const started = Date.now();
    await page.getByRole('button', { name: `載入 ${size} 節點`, exact: true }).click();
    await page.waitForFunction(n => document.querySelectorAll('.node-directory li').length === n, size);
    await page.getByRole('searchbox', { name: '搜尋節點', exact: true }).fill('n1');
    await page.getByRole('searchbox', { name: '搜尋節點', exact: true }).fill('');
    performance.push({ nodes: size, loadAndSearchMs: Date.now() - started, displayedMeasurement: await page.locator('.performance-tools [role=status]').innerText() });
  }
  done('20/100/256 node load and search measurements captured without disabling core validation');

  await page.getByRole('button', { name: '04 執行庫', exact: true }).click();
  rejectingCorruptImport = true;
  await page.getByLabel('匯入執行包 JSON', { exact: true }).setInputFiles({ name: 'corrupt.json', mimeType: 'application/json', buffer: Buffer.from('{"schemaVersion":"invalid"}') });
  await page.getByRole('alert').waitFor();
  assert.match(await page.getByRole('alert').innerText(), /匯入紀錄損壞/);
  rejectingCorruptImport = false;
  assert.equal(expectedImportRejections,1);
  await page.getByLabel('匯入執行包 JSON', { exact: true }).setInputFiles(join(output, 'browser-export.json'));
  await page.getByRole('button', { name: '匯出執行包 ↓', exact: true }).waitFor();
  done('damaged import rejected; valid versioned run imported successfully');

  assert.deepEqual(failures, []);
  const report = { schemaVersion: '1.0', createdAt: new Date().toISOString(), status: 'passed', browser: browser.version(), device: { platform: platform(), architecture: arch(), cpu: cpus()[0]?.model }, checks, viewports, performance, limitations: ['Automated Chromium checks, not a manual screen-reader audit.', 'Performance is a single local browser observation, not a statistical benchmark.', 'All UI scenario executions in this suite are fixtures; live model evidence is separate.'] };
  await writeFile(join(output, 'browser-verification.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error('UI alerts:', await page.getByRole('alert').allTextContents());
  await page.screenshot({path:join(output,'failure.png'),fullPage:true});
  throw error;
} finally {
  await browser.close(); await app.close(); await rm(directory, { recursive: true, force: true });
}
