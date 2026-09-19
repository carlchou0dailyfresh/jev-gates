import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { LocalJevProvider, TypeSafeProvider, MockProvider, validateAnswer, validateResponse } from '../dist/providers/index.js';

const noul = { type: 'noul', instructions: 'Does the text explicitly request help?' };
const choice = { type: 'choice', instructions: 'Which state?', criteria: { ready: 'Ready', unknown: null } };
const score = { type: 'score', instructions: 'How severe?', criteria: ['Minor', 'Major', 'Blocking'] };
const questions = { help: noul, state: choice, severity: score };
const answers = {
  help: { type: 'noul', noul: 0.95 },
  state: { type: 'choice', choice: 'ready', probabilities: { ready: 0.9, unknown: 0.1 }, confidence: 0.53 },
  severity: { type: 'score', score: 1.6, probabilities: { 0: 0.1, 1: 0.2, 2: 0.7 }, legend: { 0: 'Minor', 1: 'Major', 2: 'Blocking' }, confidence: 0.27 },
};
const response = () => ({ model: 'localjev-0.2', answers: structuredClone(answers), usage: { input_tokens: 30, output_tokens: 12 } });

async function server(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

function json(res, body) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

test('LocalJev sends the actual wire protocol and preserves validated answers and usage', async t => {
  let observed;
  const baseUrl = await server(t, async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    observed = { url: req.url, method: req.method, auth: req.headers.authorization, body: JSON.parse(body) };
    json(res, response());
  });
  const provider = new LocalJevProvider({ baseUrl, apiKey: 'local-test-token', upstreamModel: 'operator-declared-model' });
  const result = await provider.evaluate({ text: 'Help' }, questions);
  assert.equal(provider.name, 'localjev');
  assert.equal(provider.model, 'localjev-0.2');
  assert.deepEqual(observed, { url: '/v1/systemone', method: 'POST', auth: 'Bearer local-test-token', body: { state: { text: 'Help' }, model: 'localjev-0.2', questions } });
  assert.deepEqual(result, { ...response(), upstreamModel: 'operator-declared-model' });
  assert.equal(Object.hasOwn(result.answers.help, 'confidence'), false);
});

test('LocalJev scalar state is explicitly wrapped and /v1 base URLs are supported', async t => {
  let body;
  const baseUrl = await server(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks).toString());
    json(res, { model: 'localjev-0.2', answers: { help: answers.help } });
  });
  await new LocalJevProvider({ baseUrl: `${baseUrl}/v1/` }).evaluate(false, { help: noul });
  assert.deepEqual(body.state, { value: false });
});

test('TypeSafe pins the model and uses authorization without redirect or retry behavior', async t => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    request = { url: String(url), init };
    return Response.json({ model: 'jev-1.13.0', answers: { help: answers.help } });
  });
  const provider = new TypeSafeProvider({ apiKey: 'test-never-sent' });
  await provider.evaluate('Need help', { help: noul });
  assert.equal(request.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(request.init.redirect, 'error');
  assert.equal(request.init.headers.authorization, 'Bearer test-never-sent');
  assert.equal(JSON.parse(request.init.body).model, 'jev-1.13.0');
  assert.equal(provider.name, 'typesafe');
});

test('HTTP error text is redacted and rate limits are not retried', async t => {
  let calls = 0;
  const baseUrl = await server(t, (_req, res) => {
    calls++;
    res.writeHead(429, { 'retry-after': '0' });
    res.end('SECRET customer and credential content');
  });
  await assert.rejects(new LocalJevProvider({ baseUrl }).evaluate('sensitive input', { help: noul }), { message: 'Provider HTTP 429' });
  assert.equal(calls, 1);
});

test('redirects do not forward credentials or silently switch endpoints', async t => {
  let targetCalls = 0;
  const target = await server(t, (_req, res) => { targetCalls++; json(res, response()); });
  const baseUrl = await server(t, (_req, res) => { res.writeHead(307, { location: `${target}/v1/systemone` }); res.end(); });
  await assert.rejects(new LocalJevProvider({ baseUrl, apiKey: 'private-token' }).evaluate('text', questions), { message: 'Provider transport failed' });
  assert.equal(targetCalls, 0);
});

test('deadline covers a response body that stalls after successful headers', async t => {
  const baseUrl = await server(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"model":"localjev-0.2",');
  });
  const start = Date.now();
  await assert.rejects(new LocalJevProvider({ baseUrl, timeoutMs: 50 }).evaluate('text', questions), { message: 'Provider request timed out' });
  assert.ok(Date.now() - start < 2000);
});

test('external abort stops a stalled response and redacts its reason', async t => {
  const controller = new AbortController();
  const baseUrl = await server(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
    controller.abort(new Error('private state in cancellation reason'));
  });
  await assert.rejects(new LocalJevProvider({ baseUrl }).evaluate('text', questions, { signal: controller.signal }), { message: 'Provider request aborted' });
});

test('an already aborted signal makes no network request', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('should not happen'); });
  await assert.rejects(new LocalJevProvider().evaluate('text', questions, { signal: AbortSignal.abort('secret') }), /aborted/);
  assert.equal(calls, 0);
});

test('rejects oversized streamed response bodies', async t => {
  const baseUrl = await server(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write(' ');
    res.end(' '.repeat(1024 * 1024));
  });
  await assert.rejects(new LocalJevProvider({ baseUrl }).evaluate('text', questions), { message: 'Provider response exceeds 1 MiB' });
});

test('rejects oversized content-length before reading the body', async t => {
  const baseUrl = await server(t, (_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': 2 * 1024 * 1024 });
    res.write(' ');
  });
  await assert.rejects(new LocalJevProvider({ baseUrl }).evaluate('text', questions), { message: 'Provider response exceeds 1 MiB' });
});

test('malformed JSON bodies have safe errors', async t => {
  const baseUrl = await server(t, (_req, res) => { res.end('PRIVATE INPUT: malformed'); });
  await assert.rejects(new LocalJevProvider({ baseUrl }).evaluate('text', questions), { message: 'Provider response is not valid UTF-8 JSON' });
});

test('remote LocalJev needs explicit HTTPS and URLs cannot hide credentials or paths', () => {
  assert.equal(new LocalJevProvider().model, 'localjev-0.2');
  assert.doesNotThrow(() => new LocalJevProvider({ baseUrl: 'https://private.example' }));
  assert.doesNotThrow(() => new LocalJevProvider({ baseUrl: 'http://[::1]:8080' }));
  for (const baseUrl of ['http://remote.example', 'http://localhost.evil.test', 'ftp://127.0.0.1', 'https://user:secret@example.test', 'http://127.0.0.1:8080/path', 'http://127.0.0.1?key=secret']) {
    assert.throws(() => new LocalJevProvider({ baseUrl }));
  }
  for (const timeoutMs of [0, -1, NaN, Infinity, 1.2, 600001]) assert.throws(() => new LocalJevProvider({ timeoutMs }));
  assert.throws(() => new TypeSafeProvider({ apiKey: '' }));
  assert.throws(() => new TypeSafeProvider({ apiKey: 'token\nheader' }));
});

test('invalid or oversized input and provider-specific outcome caps reject before transport', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('should not happen'); });
  const local = new LocalJevProvider();
  await assert.rejects(local.evaluate('鮮'.repeat(22000), { help: noul }), /64 KiB/);
  await assert.rejects(local.evaluate(NaN, { help: noul }), /finite, acyclic JSON/);
  const cycle = {}; cycle.self = cycle;
  await assert.rejects(local.evaluate(cycle, { help: noul }), /finite, acyclic JSON/);
  await assert.rejects(local.evaluate('text', {}), /questions/);
  await assert.rejects(local.evaluate('text', Object.fromEntries(Array.from({ length: 17 }, (_, index) => [String(index), noul]))), /1–16/);
  const many = { ...choice, criteria: Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`c${index}`, null])) };
  await assert.rejects(local.evaluate('text', { many }), /2–128/);
  const half = { ...choice, criteria: Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`c${index}`, null])) };
  await assert.rejects(local.evaluate('text', { a: half, b: half }), /128 total outcomes/);
  await assert.rejects(local.evaluate('text', { one: { ...score, criteria: Array(11).fill('Level') } }), /2–10/);
  assert.equal(calls, 0);
});

test('MockProvider uses explicit immutable fixtures, returns fresh answers, and never infers', async () => {
  const fixtures = structuredClone(answers);
  const provider = new MockProvider(fixtures);
  fixtures.help.noul = 0;
  const first = await provider.evaluate({ arbitrary: true }, { help: noul });
  assert.deepEqual(first, { model: 'mock-fixtures-v1', answers: { help: answers.help } });
  first.answers.help.noul = 0;
  assert.equal((await provider.evaluate('opposite input', { help: noul })).answers.help.noul, 0.95);
  await assert.rejects(provider.evaluate('', { missing: noul }), /fixture is missing/);
});

test('noul validation rejects invalid scalar probabilities and invents no confidence', () => {
  for (const value of [-0.1, 1.1, NaN, Infinity, '0.9', null, undefined]) {
    assert.throws(() => validateAnswer({ type: 'noul', noul: value }, noul));
  }
  assert.deepEqual(validateAnswer({ type: 'noul', noul: 1, confidence: 0.9 }, noul), { type: 'noul', noul: 1 });
});

test('choice validation requires the exact complete distribution, valid confidence and an argmax', () => {
  assert.deepEqual(validateAnswer(answers.state, choice), answers.state);
  for (const edit of [
    { probabilities: { ready: 0.4, unknown: 0.1 } },
    { probabilities: { ready: 1 } },
    { probabilities: { ready: 0.8, unknown: 0.1, extra: 0.1 } },
    { probabilities: { ready: NaN, unknown: 0.1 } },
    { probabilities: { ready: Infinity, unknown: 0 } },
    { probabilities: { ready: 0.1, unknown: 0.9 } },
    { choice: 'nonexistent' }, { confidence: -1 }, { confidence: undefined }, { type: 'noul' },
  ]) assert.throws(() => validateAnswer({ ...answers.state, ...edit }, choice));
  assert.doesNotThrow(() => validateAnswer({ ...answers.state, probabilities: { ready: 0.5, unknown: 0.5 }, confidence: 0 }, choice));
});

test('score validation enforces zero-based levels, the exact rubric, range and weighted mean', () => {
  assert.deepEqual(validateAnswer(answers.severity, score), answers.severity);
  for (const edit of [
    { score: -1 }, { score: 3 }, { score: NaN }, { score: 1.9 },
    { probabilities: { 1: 0.1, 2: 0.2, 3: 0.7 } },
    { legend: { 0: 'Minor', 1: 'Changed', 2: 'Blocking' } },
    { legend: { 0: 'Minor', 1: 'Major' } }, { confidence: Infinity },
  ]) assert.throws(() => validateAnswer({ ...answers.severity, ...edit }, score));
});

test('response validation rejects partial/extra answers, missing model, and invalid usage', () => {
  for (const edit of [
    { model: '' }, { model: '   ' }, { model: undefined },
    { answers: { help: answers.help } },
    { answers: { ...answers, extra: answers.help } },
    { usage: { input_tokens: -1, output_tokens: 0 } },
    { usage: { input_tokens: 1.5, output_tokens: 0 } },
    { usage: { input_tokens: 1 } },
    { usage: null },
    { upstream_model: '' }, { upstreamModel: 42 },
    { upstreamModel: 'one', upstream_model: 'two' },
  ]) assert.throws(() => validateResponse({ ...response(), ...edit }, questions));
  assert.equal(validateResponse({ ...response(), upstream_model: 'served-model' }, questions).upstreamModel, 'served-model');
  assert.equal(validateResponse({ ...response(), upstreamModel: 'served-model' }, questions).upstreamModel, 'served-model');
  assert.equal(Object.hasOwn(validateResponse(response(), questions), 'upstreamModel'), false);
});

test('hostile object keys are preserved without prototype mutation', () => {
  const q = JSON.parse('{"__proto__":{"type":"noul","instructions":"Question?"}}');
  const r = JSON.parse('{"model":"mock","answers":{"__proto__":{"type":"noul","noul":1}}}');
  const result = validateResponse(r, q);
  assert.equal(Object.hasOwn(result.answers, '__proto__'), true);
  assert.equal(result.answers.__proto__.noul, 1);
  assert.equal(Object.getPrototypeOf(result.answers), Object.prototype);
});
