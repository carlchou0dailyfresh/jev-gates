#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { runCircuit } from './engine.js';
import { validateCircuit } from './validation.js';
import { toMermaid } from './compose.js';
import { LocalJevProvider, TypeSafeProvider, MockProvider } from './providers/index.js';
import { researchCommands, researchMain } from './research-cli.js';
import type { Provider } from './types.js';

const help = `jev-gates — composable semantic logic circuits

  jev-gates validate circuit.json
  jev-gates graph circuit.json
  jev-gates run circuit.json --input input.json --mock answers.json
  jev-gates run circuit.json --input input.json --provider localjev|typesafe

Research workbench:
  jev-gates research-demo [research|incident|planning|world] --variant normal --out artifact.json
  jev-gates verify-report artifact.json
  jev-gates replay artifact.json
  jev-gates evaluate --out evaluation.json
  jev-gates live-smoke localjev --out local-smoke.json
  jev-gates workbench
  npm run workbench

Options: --model ID --base-url URL (localjev) --trace FILE --max-calls N --timeout-ms N
Cloud calls require TYPESAFE_API_KEY. A provider must be selected explicitly.
Run exit codes: 0 = all outputs known (TRUE or FALSE), 2 = invalid input, 3 = UNKNOWN.
`;
const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'));
async function main() {
  const [command, path, ...args] = process.argv.slice(2);
  if (command === 'workbench') {
    if (path) throw new Error('workbench uses PORT and JEV_RUN_DIR environment options');
    const { startWorkbench } = await import('./workbench-server.js');
    const app = await startWorkbench(); console.log(`JEV 工作台 ${app.url}`);
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void app.close().then(() => process.exit(0)); });
    return;
  }
  if (command && researchCommands.includes(command)) { await researchMain(process.argv.slice(2)); return; }
  if (!command || command === '--help' || command === '-h') { console.log(help); return; }
  if (!['validate', 'graph', 'run'].includes(command) || !path) throw new Error('Expected a command and circuit file. Use --help.');
  const opts = new Map<string, string>();
  const allowed = ['--input', '--mock', '--provider', '--model', '--base-url', '--trace', '--max-calls', '--timeout-ms'];
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!allowed.includes(key) || !value || value.startsWith('--') || opts.has(key)) throw new Error('Invalid or duplicate CLI option');
    opts.set(key, value);
  }
  const circuit = validateCircuit(await readJson(path));
  if (command !== 'run' && opts.size) throw new Error('Options are only supported by run');
  if (command === 'validate') { console.log(JSON.stringify({ valid: true, circuit: circuit.name, nodes: circuit.nodes.length })); return; }
  if (command === 'graph') { process.stdout.write(toMermaid(circuit)); return; }
  if (!opts.has('--input')) throw new Error('--input is required');
  if (Number(opts.has('--mock')) + Number(opts.has('--provider')) !== 1) throw new Error('Choose exactly one: --mock or --provider');
  if (opts.has('--mock') && (opts.has('--model') || opts.has('--base-url'))) throw new Error('Mock fixtures do not accept network options');
  if (opts.has('--base-url') && opts.get('--provider') !== 'localjev') throw new Error('--base-url is only supported for localjev');
  const timeoutMs = opts.has('--timeout-ms') ? Number(opts.get('--timeout-ms')) : 30_000;
  const modelOptions = opts.has('--model') ? { model: opts.get('--model')! } : {};
  let provider: Provider;
  if (opts.has('--mock')) provider = new MockProvider(await readJson(opts.get('--mock')!));
  else if (opts.get('--provider') === 'localjev') provider = new LocalJevProvider({ ...modelOptions, timeoutMs, ...(opts.has('--base-url') ? { baseUrl: opts.get('--base-url')! } : {}) });
  else if (opts.get('--provider') === 'typesafe') {
    const apiKey = process.env.TYPESAFE_API_KEY;
    if (!apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
    provider = new TypeSafeProvider({ apiKey, ...modelOptions, timeoutMs });
  } else throw new Error('Unknown provider');
  const result = await runCircuit(circuit, await readJson(opts.get('--input')!), { provider, timeoutMs, ...(opts.has('--max-calls') ? { maxCalls: Number(opts.get('--max-calls')) } : {}) });
  if (opts.has('--trace')) {
    const target = opts.get('--trace')!;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(result, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'abstained') process.exitCode = 3;
}
main().catch(error => { console.error('jev-gates: ' + (error instanceof Error ? error.message : 'Command failed')); process.exitCode = 2; });
