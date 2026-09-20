import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createApi, evaluateDraft, replayRun } from '../workbench/server/api.mjs';

const scenarios = JSON.parse(await readFile(new URL('../workbench/scenarios.json', import.meta.url), 'utf8'));
const draft = () => {
  const value = structuredClone(scenarios[0].draft);
  value.gates.forEach((gate, i) => { gate.fixture = i === 1 ? (gate.falseAt + gate.trueAt) / 2 : 1; });
  value.combination = 'and';
  return value;
};
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const readyFetch = async url => {
  assert.equal(String(url), 'http://127.0.0.1:8080/ready');
  return json({ status: 'ready', upstream_model: 'gemma3:27b' });
};
async function serverFor(t, options = {}) {
  const handler = createApi(options);
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, server, async request(path, body, extra = {}) {
    const response = await fetch(url + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...extra.headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'headers')) });
    return { status: response.status, body: await response.json() };
  } };
}
function canonical(value) { return Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value); }
function rehash(run) { const { digest, ...rest } = run; run.digest = createHash('sha256').update(canonical(rest)).digest('hex'); return run; }
function ollamaFetch(inspect = () => {}, response = { text: '提供的證據記錄試點觀察，仍需補充驗證。[E1]', citationIds: ['E1'] }) {
  return async (url, init) => {
    if (String(url).endsWith('/api/tags')) return json({ models: [{ name: 'gemma3:27b', capabilities: ['completion'] }, { name: 'remote:cloud', capabilities: ['completion'] }] });
    if (String(url).endsWith('/api/show')) return json({ details: { parameter_size: '27.4B', quantization_level: 'Q4_K_M' }, capabilities: ['completion'] });
    assert.equal(String(url), 'http://127.0.0.1:11434/api/chat');
    const body = JSON.parse(init.body); inspect(body, init);
    return json({ model: body.model, message: { role: 'assistant', content: JSON.stringify(response) }, done: true });
  };
}

test('workbench fixture exercises the original core and explicitly separates fixed values from text', async () => {
  for (const scenario of scenarios) {
    const run = await evaluateDraft(scenario.draft);
    assert.equal(run.result.calls.length, 1);
    assert.equal(run.result.calls[0].status, 'ok');
    assert.equal(run.result.outputs.decision.truth, run.truth);
    assert.deepEqual(run.branch, run.draft.branches[run.truth]);
    assert.equal(run.provenance.provider, 'mock');
    assert.equal(run.provenance.synthetic, true);
    assert.equal(run.provenance.calibrated, false);
    assert.match(run.template, /與輸入文字無關/);
    assert.match(run.digest, /^[a-f0-9]{64}$/);
  }
  const original = await evaluateDraft(draft());
  const edited = draft(); edited.task = '完全不同的文字'; edited.evidence[0].text = '不同證據';
  const changed = await evaluateDraft(edited);
  assert.equal(original.truth, changed.truth);
  assert.notEqual(original.result.inputDigest, changed.result.inputDigest);
  assert.equal(original.truth, 'UNKNOWN');
});

test('workbench rejects invalid circuit drafts and client-controlled transport/configuration', async t => {
  const api = await serverFor(t);
  const invalid = [
    d => { d.gates[0].trueAt = d.gates[0].falseAt; },
    d => { d.gates.forEach(g => { g.enabled = false; }); },
    d => { d.gates = Array.from({ length: 7 }, (_, i) => ({ ...d.gates[0], id: `g${i}` })); },
    d => { d.gates[1].id = d.gates[0].id; },
    d => { d.gates[0].id = 'decision'; },
    d => { d.evidence[0].text = 'x'.repeat(4001); },
    d => { d.evidence[0].id = 'https://attacker.test'; },
    d => { d.combination = 'kofn'; d.k = 4; },
    d => { d.baseUrl = 'https://attacker.test'; },
  ];
  for (const mutate of invalid) {
    const value = draft(); mutate(value);
    const result = await api.request('/api/run', { draft: value, mode: 'fixture' });
    assert.equal(result.status, 400); assert.equal(typeof result.body.error, 'string');
  }
  assert.equal((await api.request('/api/run', { draft: draft(), mode: 'fixture', apiKey: 'client-secret' })).status, 400);
  assert.equal((await api.request('/api/run', { draft: draft(), mode: 'random' })).status, 400);
});

test('workbench API rejects cross-origin requests, hostile hosts, wrong media types and oversized bodies', async t => {
  const api = await serverFor(t);
  const body = { draft: draft(), mode: 'fixture' };
  assert.equal((await api.request('/api/run', body, { headers: { origin: 'https://attacker.test' } })).status, 403);
  const hostileHostStatus = await new Promise((resolve, reject) => {
    const req = httpRequest(api.url + '/api/health', { headers: { host: 'attacker.test' } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(hostileHostStatus, 403);
  assert.equal((await api.request('/api/run', body, { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
  assert.equal((await api.request('/api/run', body, { headers: { 'content-type': 'text/plain' } })).status, 415);
  assert.equal((await api.request('/api/run', { excessive: 'x'.repeat(65536) })).status, 413);
  assert.equal((await api.request('/api/not-found')).status, 404);
  assert.equal((await api.request('/api/run')).status, 405);
  assert.equal((await api.request('/api/run', body, { headers: { origin: api.url } })).status, 200);
});

test('workbench health reports unavailable services honestly and filters remote and embedding-only models', async t => {
  const seen = [];
  const api = await serverFor(t, { env: { TYPESAFE_API_KEY: 'server-secret' }, fetch: async (url, init) => {
    seen.push(String(url)); assert.equal(init.redirect, 'error');
    return String(url).endsWith('/ready') ? json({ status: 'ready', upstream_model: 'gemma3:27b' }) : json({ models: [
      { name: 'gemma3:27b', capabilities: ['completion'] }, { name: 'qwen:cloud', capabilities: ['completion'] },
      { name: 'deepseek:671b-cloud', capabilities: ['completion'] }, { name: 'remote:latest', remote_model: 'hidden', capabilities: ['completion'] },
      { name: 'remote2', remote_host: 'https://example.test' }, { name: 'embed', capabilities: ['embedding'] },
      { name: 'nomic-embed-text:latest' }, { name: 'another:local', capabilities: ['completion', 'vision'] },
    ] });
  } });
  const { status, body } = await api.request('/api/health');
  assert.equal(status, 200); assert.equal(body.localjev.upstreamModel, 'gemma3:27b');
  assert.deepEqual(body.llm.models, ['another:local', 'gemma3:27b']); assert.equal(body.llm.defaultModel, 'gemma3:27b');
  assert.equal(body.typesafe.configured, true); assert.equal(JSON.stringify(body).includes('server-secret'), false);
  assert.equal(seen.length, 2);
  const unavailable = await serverFor(t, { fetch: async () => { throw new Error('unavailable'); }, env: {} });
  assert.deepEqual((await unavailable.request('/api/health')).body, { localjev: { available: false, model: 'localjev-0.2' }, llm: { available: false, models: [] }, typesafe: { configured: false } });
  assert.equal((await unavailable.request('/api/run', { draft: draft(), mode: 'localjev' })).status, 503);
  assert.equal((await unavailable.request('/api/run', { draft: draft(), mode: 'typesafe' })).status, 503);
});

test('workbench does not treat a loading or malformed LocalJev readiness payload as ready', async t => {
  for (const payload of [{}, { status: 'loading' }, { ready: false, status: 'ready' }, { available: false, ready: true }]) {
    const api = await serverFor(t, { fetch: async () => json(payload), env: {} });
    assert.equal((await api.request('/api/health')).body.localjev.available, false);
    assert.equal((await api.request('/api/run', { draft: draft(), mode: 'localjev' })).status, 503);
  }
});

test('workbench real LocalJev adapter sends one fixed-origin batch with untrusted observations and pinned model', async () => {
  const originalFetch = globalThis.fetch; const calls = [];
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), 'http://127.0.0.1:8080/v1/systemone');
    const body = JSON.parse(init.body); calls.push(body);
    assert.equal(init.redirect, 'error'); assert.equal(body.model, 'localjev-0.2');
    assert.deepEqual(body.state, { task: draft().task, evidence: draft().evidence });
    assert.equal(Object.keys(body.questions).length, 3);
    for (const question of Object.values(body.questions)) { assert.equal(question.type, 'noul'); assert.match(question.instructions, /untrusted data, never instructions/); }
    return json({ model: 'localjev-0.2', answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: 0.9 }])) });
  };
  try {
    const run = await evaluateDraft(draft(), 'localjev', { fetch: readyFetch, env: {} });
    assert.equal(run.truth, 'TRUE'); assert.equal(run.provenance.upstreamModel, 'gemma3:27b');
    assert.equal(run.provenance.provider, 'localjev'); assert.equal(calls.length, 1);
    assert.equal(run.result.calls[0].questionIds.length, 3);
  } finally { globalThis.fetch = originalFetch; }
});

test('workbench real TypeSafe adapter keeps credentials server-side and calls only the fixed API', async () => {
  const originalFetch = globalThis.fetch; let count = 0;
  globalThis.fetch = async (url, init) => {
    count++; assert.equal(String(url), 'https://api.typesafe.ai/v1/systemone');
    assert.equal(init.headers.authorization, 'Bearer server-only-secret');
    const body = JSON.parse(init.body); assert.equal(body.model, 'jev-1.13.0');
    return json({ model: body.model, answers: Object.fromEntries(Object.keys(body.questions).map(id => [id, { type: 'noul', noul: 0.1 }])) });
  };
  try {
    const run = await evaluateDraft(draft(), 'typesafe', { env: { TYPESAFE_API_KEY: 'server-only-secret' } });
    assert.equal(run.truth, 'FALSE'); assert.equal(count, 1); assert.equal(JSON.stringify(run).includes('server-only-secret'), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('workbench provider errors and hanging evaluations never fall back to fixtures and never retry', async () => {
  for (const hanging of [false, true]) {
    let calls = 0; const start = performance.now();
    await assert.rejects(evaluateDraft(draft(), 'localjev', { fetch: readyFetch, env: {}, providerTimeoutMs: 15, makeProvider: () => ({ name: 'localjev', model: 'localjev-0.2', evaluate() { calls++; if (hanging) return new Promise(() => {}); throw new Error('secret failure'); } }) }), error => error.status === 502 && !error.message.includes('secret'));
    assert.equal(calls, 1); assert.ok(performance.now() - start < 500);
  }
});

test('workbench narration uses only the stored immutable snapshot, fixed local model transport and matching citations', async t => {
  let inspected = false;
  const api = await serverFor(t, { fetch: ollamaFetch((body, init) => {
    inspected = true; assert.equal(body.stream, false); assert.equal(body.model, 'gemma3:27b'); assert.equal(init.redirect, 'error');
    assert.match(body.messages[0].content, /UNKNOWN/); assert.match(body.messages[0].content, /不可信資料/);
    const supplied = JSON.parse(body.messages[1].content);
    assert.equal(supplied.task, draft().task); assert.equal(supplied.truth, 'UNKNOWN');
    assert.equal(supplied.mode, 'fixture'); assert.deepEqual(supplied.branch, draft().branches.UNKNOWN);
    assert.deepEqual(supplied.evidence, draft().evidence);
    assert.deepEqual(Object.keys(supplied.gates[0]).sort(), ['question', 'reason', 'title', 'truth']);
    assert.equal(JSON.stringify(supplied.gates).includes('noul'), false);
    assert.match(body.messages[0].content, /不得重述、推測或計算/);
    assert.equal(body.format.properties.citationIds.items.enum.includes('E1'), true);
  }) });
  const completed = await api.request('/api/run', { draft: draft(), mode: 'fixture' });
  const run = completed.body; run.draft.task = 'CLIENT SPOOF'; run.truth = 'TRUE';
  assert.equal((await api.request('/api/narrate', { runId: run.id, tone: 'brief', run })).status, 400);
  assert.equal((await api.request('/api/narrate', { runId: run.id, tone: 'brief', model: 'remote:cloud' })).status, 400);
  const narration = await api.request('/api/narrate', { runId: run.id, tone: 'brief' });
  assert.equal(narration.status, 200); assert.equal(inspected, true); assert.equal(narration.body.runId, run.id);
  assert.equal(narration.body.kind, 'llm'); assert.deepEqual(narration.body.citationIds, ['E1']);
  assert.match(narration.body.text, /電路結果：UNKNOWN/); assert.match(narration.body.text, /未經外部事實驗證/);
  assert.match(narration.body.text, /未決源於設定門檻，不等同案件不符或缺特定文件/);
  assert.match(narration.body.text, /FALSE ≤/);
});

test('workbench rejects regenerated threshold numbers and internal gate IDs but preserves evidence counts', async t => {
  for (const text of ['damage分數0.95、resolution0.98皆高於0.8門檻。[E1]', '兩個節點皆高於 0.8 門檻。[E1]', 'causality 仍未決。[E1]']) {
    const api = await serverFor(t, { fetch: ollamaFetch(() => {}, { text, citationIds: ['E1'] }) });
    const run = (await api.request('/api/run', { draft: draft(), mode: 'fixture' })).body;
    assert.equal((await api.request('/api/narrate', { runId: run.id, tone: 'brief' })).status, 502);
  }
  for (const text of ['提供的證據描述改善觀察，但因果判斷仍未決。[E1]', '提供的證據記錄 100 件配送與 5 件客訴，後續驗證是建議。[E1]']) {
    const api = await serverFor(t, { fetch: ollamaFetch(() => {}, { text, citationIds: ['E1'] }) });
    const run = (await api.request('/api/run', { draft: draft(), mode: 'fixture' })).body;
    assert.equal((await api.request('/api/narrate', { runId: run.id, tone: 'brief' })).status, 200);
  }
});

test('workbench confirms local model details and refuses aliased remote models before chatting', async t => {
  for (const details of [
    { details: { parameter_size: '27B', quantization_level: 'Q4_K_M' }, capabilities: ['completion'], remote_model: 'cloud-model' },
    { details: { parameter_size: '27B', quantization_level: 'Q4_K_M', remote_host: 'https://remote.test' }, capabilities: ['completion'] },
    { details: { parameter_size: '27B', quantization_level: 'Q4_K_M' }, capabilities: ['embedding'] },
    {},
  ]) {
    let chats = 0;
    const api = await serverFor(t, { fetch: async (url, init) => {
      if (String(url).endsWith('/api/tags')) return json({ models: [{ name: 'ordinary-name:latest', capabilities: ['completion'] }] });
      if (String(url).endsWith('/api/show')) { assert.deepEqual(JSON.parse(init.body), { model: 'ordinary-name:latest' }); return json(details); }
      chats++; throw new Error('Must not chat with a remote or unsupported model');
    } });
    const run = (await api.request('/api/run', { draft: draft(), mode: 'fixture' })).body;
    assert.equal((await api.request('/api/narrate', { runId: run.id, tone: 'brief' })).status, 503);
    assert.equal(chats, 0);
  }
});

test('workbench refuses incomplete, truncated or differently attributed Ollama completions', async t => {
  for (const override of [{ done: false }, { model: 'different-model' }, { done_reason: 'length' }]) {
    const normal = ollamaFetch();
    const api = await serverFor(t, { fetch: async (url, init) => {
      const response = await normal(url, init);
      return String(url).endsWith('/api/chat') ? json({ ...await response.json(), ...override }) : response;
    } });
    const run = (await api.request('/api/run', { draft: draft(), mode: 'fixture' })).body;
    assert.equal((await api.request('/api/narrate', { runId: run.id, tone: 'brief' })).status, 502);
  }
});

test('workbench narration rejects invented evidence references and bounded service deadlines', async t => {
  const wrong = await serverFor(t, { fetch: ollamaFetch(() => {}, { text: '已知結果。[E9]', citationIds: ['E9'] }) });
  const run = (await wrong.request('/api/run', { draft: draft(), mode: 'fixture' })).body;
  assert.equal((await wrong.request('/api/narrate', { runId: run.id, tone: 'analysis' })).status, 502);
  const stalled = await serverFor(t, { narrationTimeoutMs: 15, fetch: async url => String(url).endsWith('/api/tags') ? json({ models: [{ name: 'gemma3:27b' }] }) : String(url).endsWith('/api/show') ? json({ details: { parameter_size: '27.4B', quantization_level: 'Q4_K_M' }, capabilities: ['completion'] }) : new Promise(() => {}) });
  const stalledRun = (await stalled.request('/api/run', { draft: draft(), mode: 'fixture' })).body;
  const start = performance.now();
  assert.equal((await stalled.request('/api/narrate', { runId: stalledRun.id, tone: 'brief' })).status, 504);
  assert.ok(performance.now() - start < 500);
});

test('workbench offline replay recomputes core semantics and detects alteration even with a recomputed checksum', async () => {
  const run = await evaluateDraft(draft()); const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('Replay must never use network'); };
  try {
    assert.equal((await replayRun(run)).valid, true);
    const altered = structuredClone(run); altered.truth = 'TRUE';
    await assert.rejects(replayRun(altered), error => error.status === 422);
    rehash(altered);
    await assert.rejects(replayRun(altered), error => error.status === 422);
    const alteredSignal = structuredClone(run); alteredSignal.result.signals.causality.truth = 'TRUE'; rehash(alteredSignal);
    await assert.rejects(replayRun(alteredSignal), error => error.status === 422);
    const alteredDraft = structuredClone(run); alteredDraft.draft.gates[0].trueAt = 0.99; rehash(alteredDraft);
    await assert.rejects(replayRun(alteredDraft), error => error.status === 422);
    const changedInput = structuredClone(run); changedInput.draft.evidence[0].text = 'tampered'; rehash(changedInput);
    await assert.rejects(replayRun(changedInput), error => error.status === 422);
  } finally { globalThis.fetch = originalFetch; }
});

test('workbench API replay works with an imported run without server history', async t => {
  const run = await evaluateDraft(draft());
  const api = await serverFor(t, { fetch: () => { throw new Error('No network allowed'); } });
  const result = await api.request('/api/replay', { run });
  assert.equal(result.status, 200); assert.equal(result.body.valid, true); assert.equal(result.body.truth, 'UNKNOWN');
  assert.match(result.body.checks.join('\n'), /不證明來源真實/);
  assert.equal((await api.request('/api/narrate', { runId: run.id, tone: 'brief' })).status, 404);
});

test('workbench can replay its own expanded envelope when a valid input nearly fills 64 KiB', async t => {
  const api = await serverFor(t, { fetch: () => { throw new Error('No service calls for fixtures or replay'); } });
  const large = draft();
  large.task = 'x'.repeat(4000);
  large.evidence = Array.from({ length: 12 }, (_, i) => ({ id: `E${i + 1}`, title: 'synthetic evidence', text: 'x'.repeat(4000) }));
  large.gates = Array.from({ length: 6 }, (_, i) => ({ ...large.gates[0], id: `g${i}`, question: 'x'.repeat(1200) }));
  for (const branch of Object.values(large.branches)) branch.instruction = 'x'.repeat(2000);
  const body = { draft: large, mode: 'fixture' };
  for (let i = large.evidence.length - 1; Buffer.byteLength(JSON.stringify(body)) > 64000 && i >= 0; i--) {
    const excess = Buffer.byteLength(JSON.stringify(body)) - 64000;
    large.evidence[i].text = large.evidence[i].text.slice(0, Math.max(1, large.evidence[i].text.length - excess));
  }
  assert.ok(Buffer.byteLength(JSON.stringify(body)) <= 65536);
  const run = await api.request('/api/run', body);
  assert.equal(run.status, 200);
  assert.ok(Buffer.byteLength(JSON.stringify({ run: run.body })) > 65536);
  assert.equal((await api.request('/api/replay', { run: run.body })).status, 200);
  assert.equal((await api.request('/api/replay', { excessive: 'x'.repeat(262144) })).status, 413);
});

test('workbench retains at most 100 immutable run snapshots for narration', async t => {
  const api = await serverFor(t, { fetch: ollamaFetch() }); let first; let latest;
  for (let i = 0; i < 101; i++) { const result = await api.request('/api/run', { draft: draft(), mode: 'fixture' }); assert.equal(result.status, 200); first ??= result.body.id; latest = result.body.id; }
  assert.equal((await api.request('/api/narrate', { runId: first, tone: 'brief' })).status, 404);
  assert.equal((await api.request('/api/narrate', { runId: latest, tone: 'brief' })).status, 200);
});

test('workbench body deadline bounds incomplete JSON uploads', async t => {
  const api = await serverFor(t, { bodyTimeoutMs: 15 });
  const received = await new Promise((resolve, reject) => {
    const req = httpRequest(api.url + '/api/run', { method: 'POST', headers: { 'content-type': 'application/json' } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => { req.end(); resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }); });
    });
    req.on('error', reject); req.write('{');
  });
  assert.equal(received.status, 408); assert.match(received.body, /逾時/);
});
