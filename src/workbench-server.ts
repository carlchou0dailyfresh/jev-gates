import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, mkdir, open } from 'node:fs/promises';
import { join, resolve, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRunArtifact, sealArtifact, verifyArtifact, replayArtifact } from './artifact.js';
import { getScenario, listScenarios, normalizeScenarioInput } from './scenarios.js';
import { validateCircuit } from './validation.js';
import { canonical, digest } from './json.js';
import { RunStore } from './workbench-store.js';
import { selectProvider, workbenchConfig, type WorkbenchMode } from './workbench-provider.js';
import { SandboxService, type SandboxFault } from './sandbox.js';
import type { Circuit, Json } from './types.js';
import type { RunArtifact, RunEvent, RunBudgetLimits, ActionRecord, EvidenceRecord } from './workbench-types.js';

interface Job { jobId: string; status: 'running' | 'completed' | 'failed' | 'cancelled'; events: RunEvent[]; controller: AbortController; artifact?: RunArtifact; error?: string }
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const JSON_LIMIT = 8 * 1024 * 1024;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Content-Type must be application/json');
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > JSON_LIMIT) throw new Error('Import exceeds the 8 MiB limit');
    chunks.push(chunk as Buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  // Reject prototype traps, excessive nesting and non-JSON values before any interpretation.
  function depth(value: unknown, n = 0): void {
    if (n > 64) throw new Error('JSON nesting exceeds 64 levels');
    if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Reserved object key');
      depth(item, n + 1);
    }
  }
  depth(parsed); canonical(parsed);
  return object(parsed);
}
function respond(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
function string(value: unknown, fallback = ''): string { return typeof value === 'string' ? value : fallback; }
function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new Error(`Expected integer in [${min}, ${max}]`);
  return Number(value);
}
function budget(value: unknown): Partial<RunBudgetLimits> {
  if (value === undefined) return { maxCalls: 16, maxNodes: 256, maxTimeMs: 90_000, gateTimeoutMs: 35_000 };
  const v = object(value);
  if (v.maxCostUsd !== undefined && (typeof v.maxCostUsd !== 'number' || !Number.isFinite(v.maxCostUsd) || v.maxCostUsd < 0 || v.maxCostUsd > 100)) throw new Error('Expected cost in [0, 100] USD');
  return { maxCalls: boundedInteger(v.maxCalls, 16, 0, 64), maxNodes: boundedInteger(v.maxNodes, 256, 0, 256), maxTimeMs: boundedInteger(v.maxTimeMs, 90_000, 1, 180_000), gateTimeoutMs: boundedInteger(v.gateTimeoutMs, 35_000, 1, 60_000), ...(v.maxTokens === undefined ? {} : { maxTokens: boundedInteger(v.maxTokens, 0, 0, 1_000_000) }), ...(v.maxCostUsd === undefined ? {} : { maxCostUsd: v.maxCostUsd }) };
}
export function performanceCircuit(size: number): Circuit {
  if (![20, 100, 256].includes(size)) throw new Error('Only 20, 100, or 256 nodes');
  return { version: 1, name: `render-${size}`, nodes: Array.from({ length: size }, (_, n) => n < 10 ? { id: `n${n}`, kind: 'constant' as const, value: n % 3 === 0 ? 'UNKNOWN' as const : 'TRUE' as const } : { id: `n${n}`, kind: 'logic' as const, op: 'and' as const, inputs: [`n${n - 10}`, `n${n - 9}`] }), outputs: [`n${size - 1}`] };
}

export async function startWorkbench(options: { port?: number; dataDir?: string; uiDir?: string } = {}) {
  const store = new RunStore(options.dataDir ?? process.env.JEV_RUN_DIR ?? join(ROOT, '.jev-runs'));
  await store.lock();
  const jobs = new Map<string, Job>();
  const tasks = new Set<Promise<void>>();
  let admittingRun = false;
  const sandbox = new SandboxService(join(store.directory, 'sandbox', 'destination.json'));
  const actionBusy = new Set<string>();
  const uiDir = resolve(options.uiDir ?? join(ROOT, 'ui', 'dist'));
  let serverOrigin = '';
  async function childWithAction(parent: RunArtifact, action: ActionRecord, reason: string): Promise<RunArtifact> {
    const child = structuredClone(parent);
    child.runId = randomUUID(); child.parentRunId = parent.runId; child.changeReason = reason; child.createdAt = new Date().toISOString();
    child.actions = [...parent.actions.filter(a => a.operationId !== action.operationId), action];
    const sealed = sealArtifact(child); await store.save(sealed); return sealed;
  }
  async function act(runId: string, request: Record<string, unknown>, recover: boolean): Promise<RunArtifact> {
    if (actionBusy.has(runId)) throw new Error('This run already has an action in progress');
    actionBusy.add(runId);
    try {
      const parent = await store.get(runId);
      if (parent.scenarioId !== 'incident') throw new Error('Only the incident sandbox has an allowlisted action');
      if (recover) {
        const previous = parent.actions.find(a => a.status === 'pending');
        if (!previous) {
          if (parent.actions.some(a => a.status === 'verified')) return parent;
          throw new Error('No pending operation to query');
        }
        const query = await sandbox.query(previous.operationId);
        const passed = await sandbox.verify(query);
        return childWithAction(parent, { ...previous, status: passed ? 'verified' : 'pending', queryResult: query as unknown as Json, verification: { passed, evidence: { destinationHealth: await sandbox.health(), query } as unknown as Json }, executionCount: await sandbox.executionCount() }, '查詢目的端回執並驗證健康狀態；未重新送出動作');
      }
      if (parent.actions.length) throw new Error('This run already has an action; query pending operations instead');
      if (request.kind !== 'repair') throw new Error('Only the sandbox repair tool is allowed');
      // Models never authorize the tool. The user invokes this local simulation explicitly.
      const allowed = ['none', 'timeout-after-apply', 'timeout-after-applied', 'verification-failed', 'execute-failed'];
      const fault = string(request.fault, 'timeout-after-apply');
      if (!allowed.includes(fault)) throw new Error('Unknown sandbox fault');
      const intentDir = join(store.directory, 'operations'); await mkdir(intentDir, { recursive: true, mode: 0o700 });
      const intentPath = join(intentDir, `${parent.runId}.json`);
      let action: ActionRecord;
      try {
        const existing = JSON.parse(await readFile(intentPath, 'utf8')) as ActionRecord;
        // A browser retry/reload only queries a previously persisted operation.
        const query = await sandbox.query(existing.operationId), passed = await sandbox.verify(query);
        return childWithAction(parent, { ...existing, status: passed ? 'verified' : 'pending', queryResult: query as unknown as Json, verification: { passed, evidence: query as unknown as Json }, executionCount: await sandbox.executionCount() }, '恢復已持久化的操作；只查詢，不重送');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      action = { schemaVersion: '1.0', operationId: randomUUID(), target: 'local-simulated-service', parametersDigest: digest({ action: 'repair', target: 'local-simulated-service' }), policyDigest: digest({ allowlist: ['repair'], verification: 'destination-health-and-matching-receipt-v1' }), status: 'pending', toolKind: 'sandbox' };
      const file = await open(intentPath, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify(action)); await file.sync(); } finally { await file.close(); }
      try {
        const selectedFault = fault === 'timeout-after-apply' ? 'timeout-after-applied' : fault;
        const receipt = await sandbox.repair({ operationId: action.operationId, ...(selectedFault === 'none' ? {} : { fault: selectedFault as SandboxFault }), signal: AbortSignal.timeout(1000) });
        const passed = await sandbox.verify(receipt);
        action = { ...action, receipt: receipt as unknown as Json, status: passed ? 'verified' : 'pending', verification: { passed, evidence: receipt as unknown as Json } };
      } catch { /* An uncertain action remains pending until a separate destination query. */ }
      action.executionCount = await sandbox.executionCount();
      return childWithAction(parent, action, `使用者執行本機沙箱修復，故障注入：${fault}`);
    } finally { actionBusy.delete(runId); }
  }
  const server = createServer(async (req, res) => {
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('referrer-policy', 'no-referrer');
    res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      const url = new URL(req.url ?? '/', serverOrigin);
      const host = req.headers.host;
      if (host !== new URL(serverOrigin).host) { respond(res, 403, { error: 'Untrusted Host; open the printed loopback URL' }); return; }
      if (req.headers.origin && req.headers.origin !== serverOrigin) { respond(res, 403, { error: 'Cross-origin requests are not allowed' }); return; }
      if (req.method === 'GET' && url.pathname === '/api/config') { respond(res, 200, await workbenchConfig()); return; }
      if (req.method === 'GET' && url.pathname === '/api/scenarios') { respond(res, 200, listScenarios()); return; }
      const scenarioMatch = /^\/api\/scenarios\/([a-z-]+)$/.exec(url.pathname);
      if (req.method === 'GET' && scenarioMatch) { const scenario = getScenario(scenarioMatch[1]!, url.searchParams.get('variant') ?? 'normal', Number(url.searchParams.get('seed') ?? 42)); respond(res, 200, scenario); return; }
      const performanceMatch = /^\/api\/performance\/(20|100|256)$/.exec(url.pathname);
      if (req.method === 'GET' && performanceMatch) { respond(res, 200, { id: 'performance', title: '節點渲染量測', variant: performanceMatch[1], seed: 42, circuit: performanceCircuit(Number(performanceMatch[1])), input: {}, evidence: [], notes: ['合成效能電路；沒有模型準確率意義'], sourceKind: 'synthetic' }); return; }
      if (req.method === 'POST' && url.pathname === '/api/validate') {
        const value = await body(req); try { validateCircuit(value.circuit); respond(res, 200, { valid: true, errors: [] }); } catch (error) { respond(res, 200, { valid: false, errors: [(error as Error).message] }); } return;
      }
      if (req.method === 'POST' && url.pathname === '/api/scenario-preview') { const request = await body(req); respond(res, 200, getScenario(string(request.scenarioId, 'research'), string(request.variant, 'normal'), boundedInteger(request.seed, 42, 0, 0xFFFFFFFF), object(request.overrides ?? {}))); return; }
      if (req.method === 'GET' && url.pathname === '/api/runs') { respond(res, 200, await store.list()); return; }
      const runMatch = /^\/api\/runs\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
      if (req.method === 'GET' && runMatch) { respond(res, 200, await store.get(runMatch[1]!)); return; }
      if (req.method === 'POST' && url.pathname === '/api/runs') {
        if (admittingRun || [...jobs.values()].some(j => j.status === 'running')) throw new Error('另一個執行仍在進行；請先取消或等待完成。');
        admittingRun = true;
        try {
        const request = await body(req), id = string(request.scenarioId, 'research');
        const scenario = id === 'performance' ? { circuit: performanceCircuit(Number(request.variant)), input: {}, evidence: [] as EvidenceRecord[], answers: {}, providerFault: false } : getScenario(id, string(request.variant, 'normal'), boundedInteger(request.seed, 42, 0, 0xFFFFFFFF), request.overrides === undefined ? {} : object(request.overrides));
        const mode = string(request.mode, 'fixture') as WorkbenchMode;
        if (!['fixture', 'live-localjev', 'live-typesafe'].includes(mode)) throw new Error('Unknown run mode');
        const circuit = validateCircuit(request.circuit ?? scenario.circuit);
        const evidence = (request.evidence ?? scenario.evidence) as EvidenceRecord[];
        const input = normalizeScenarioInput(id, (request.input ?? scenario.input) as Json, evidence);
        const limits = budget(request.budget);
        const parentRunId = string(request.parentRunId), changeReason = string(request.changeReason);
        if (parentRunId) { await store.get(parentRunId); if (!changeReason.trim()) throw new Error('修改執行需要原因，原紀錄會保留。'); }
        const fixtureMatches = digest(input) === digest(normalizeScenarioInput(id, scenario.input, scenario.evidence)) && digest(evidence) === digest(scenario.evidence) && circuit.nodes.filter(n => n.kind === 'semantic').every(n => { const original = scenario.circuit.nodes.find(o => o.id === n.id); return original?.kind === 'semantic' && digest({ question: n.question, input: n.input ?? '', context: n.context ?? [] }) === digest({ question: original.question, input: original.input ?? '', context: original.context ?? [] }); });
        const provider = mode === 'fixture' && !fixtureMatches ? undefined : await selectProvider(mode, scenario.answers, scenario.providerFault);
        const job: Job = { jobId: randomUUID(), status: 'running', events: [], controller: new AbortController() };
        jobs.set(job.jobId, job);
        if (jobs.size > 64) { for (const [key, old] of jobs) if (old.status !== 'running' && key !== job.jobId) { jobs.delete(key); break; } }
        const task = createRunArtifact({ circuit, input, evidence, ...(provider ? { provider } : {}), mode, budget: limits, scenarioId: id, ...(parentRunId ? { parentRunId, changeReason } : {}), signal: job.controller.signal, onEvent: event => { job.events.push(event); } }).then(async artifact => {
          await store.save(artifact); job.artifact = artifact; job.status = job.controller.signal.aborted ? 'cancelled' : 'completed';
        }).catch(error => { job.status = 'failed'; job.error = error instanceof Error ? error.message : '執行失敗'; });
        tasks.add(task); void task.finally(() => tasks.delete(task));
        respond(res, 202, { jobId: job.jobId }); return;
        } finally { admittingRun = false; }
      }
      const jobMatch = /^\/api\/jobs\/([a-zA-Z0-9_-]+)(\/cancel)?$/.exec(url.pathname);
      if (jobMatch) {
        const job = jobs.get(jobMatch[1]!); if (!job) { respond(res, 404, { error: 'Job not found; saved runs remain in the library' }); return; }
        if (req.method === 'POST' && jobMatch[2]) { await body(req); job.controller.abort(); respond(res, 200, { cancelled: true, note: '取消不代表撤銷已執行的動作' }); return; }
        if (req.method === 'GET' && !jobMatch[2]) { const { controller: _, ...publicJob } = job; respond(res, 200, publicJob); return; }
      }
      const actionMatch = /^\/api\/runs\/([a-zA-Z0-9_-]+)\/(action|recover)$/.exec(url.pathname);
      if (req.method === 'POST' && actionMatch) { respond(res, 200, { artifact: await act(actionMatch[1]!, await body(req), actionMatch[2] === 'recover') }); return; }
      if (req.method === 'POST' && ['/api/verify', '/api/replay', '/api/import'].includes(url.pathname)) {
        const request = await body(req);
        if (url.pathname === '/api/replay') { respond(res, 200, await replayArtifact(request.artifact)); return; }
        const report = await verifyArtifact(request.artifact);
        if (url.pathname === '/api/verify') { respond(res, 200, report); return; }
        if (!report.valid) throw new Error(`匯入紀錄損壞：${report.errors.join('; ')}`);
        const artifact = request.artifact as RunArtifact;
        try { await store.save(artifact); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; const prior = await store.get(artifact.runId); if (prior.integrity.digest !== artifact.integrity.digest) throw new Error('An existing run ID has different contents'); }
        respond(res, 200, { artifact }); return;
      }
      if (url.pathname.startsWith('/api/')) { respond(res, 404, { error: 'Unknown endpoint' }); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') { respond(res, 405, { error: 'Method not allowed' }); return; }
      const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
      const target = resolve(uiDir, '.' + relative);
      if (!target.startsWith(uiDir + '/')) { respond(res, 404, { error: 'Not found' }); return; }
      let bytes: Buffer;
      try { bytes = await readFile(target); } catch { respond(res, 404, { error: 'UI not built. Run npm run workbench first.' }); return; }
      const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
      res.writeHead(200, { 'content-type': types[extname(target)] ?? 'application/octet-stream', 'cache-control': 'no-cache' }); res.end(req.method === 'HEAD' ? undefined : bytes);
    } catch (error) { respond(res, 400, { error: error instanceof Error ? error.message : 'Request failed' }); }
  });
  const port = options.port ?? Number(process.env.PORT ?? 4317);
  try {
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  } catch (error) { await store.close(); throw error; }
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No server address');
  serverOrigin = `http://127.0.0.1:${address.port}`;
  return { server, url: serverOrigin, store, async close() { for (const job of jobs.values()) job.controller.abort(); await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); await Promise.allSettled([...tasks]); await store.close(); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startWorkbench().then(app => {
    console.log(`JEV 工作台 ${app.url}\n執行紀錄：${app.store.directory}\n模型金鑰只讀取服務端環境；Ctrl+C 停止。`);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
