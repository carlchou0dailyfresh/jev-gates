import { digest } from './json.js';
import type { Truth } from './types.js';

export type WorldSplit = 'train' | 'dev' | 'calibration' | 'test';
export type RuleFamily = 'chain' | 'conjunction' | 'consumption' | 'inhibitor' | 'alternative' | 'reversible';
export interface WorldRule { id: string; requires: string[]; any: string[]; forbidden: string[]; add: string[]; remove: string[] }
export interface MiniWorld { generatorVersion: 'world-v1'; id: string; family: RuleFamily; seed: number; initial: string[]; hidden: string[]; rules: WorldRule[]; target: string; maxSteps: number; contradictory: boolean; distractors: string[] }
export interface WorldResult { truth: Truth; reason: string; plan: string[]; states: string[][]; visited: number }
export interface WorldCase { id: string; split: WorldSplit; family: RuleFamily; world: MiniWorld; label: Truth; labelSource: 'independent-executor-v1'; digest: string }
export const WORLD_SPLITS: Record<WorldSplit, RuleFamily[]> = { train: ['chain'], dev: ['conjunction'], calibration: ['consumption'], test: ['inhibitor', 'alternative', 'reversible'] };

/** Fixed seeded arithmetic; no ambient random state or clock is involved. */
export function generateWorld(seed = 42, family: RuleFamily = 'chain', options: { hidden?: boolean; contradiction?: boolean; renamed?: boolean; blocked?: boolean; distractors?: boolean } = {}): MiniWorld {
  if (!Number.isSafeInteger(seed) || !Object.values(WORLD_SPLITS).flat().includes(family)) throw new Error('Invalid world generator arguments');
  const suffix = options.renamed ? `-${Math.abs(seed * 1664525 + 1013904223) % 997}` : '';
  const [a, b, c, d, lock] = ['amber', 'blue', 'copper', 'done', 'locked'].map(v => v + suffix) as [string, string, string, string, string];
  const rule = (id: string, requires: string[], add: string[], extra: Partial<WorldRule> = {}): WorldRule => ({ id, requires, any: [], forbidden: [], add, remove: [], ...extra });
  let initial = [a], rules: WorldRule[];
  switch (family) {
    case 'chain': rules = [rule('convert', [a], [b]), rule('finish', [b], [d])]; break;
    case 'conjunction': initial.push(c); rules = [rule('combine', [a, c], [b]), rule('finish', [b], [d])]; break;
    case 'consumption': rules = [rule('consume', [a], [b], { remove: [a] }), rule('finish', [b], [d], { remove: [b] })]; break;
    case 'inhibitor': if (seed % 2) initial.push(lock); rules = [rule('guarded', [a], [b], { forbidden: [lock] }), rule('finish', [b], [d])]; break;
    case 'alternative': initial = [seed % 2 ? c : a]; rules = [rule('either', [], [b], { any: [a, c] }), rule('finish', [b], [d])]; break;
    case 'reversible': rules = [rule('forward', [a], [b], { remove: [a] }), rule('reverse', [b], [a], { remove: [b] }), rule('finish', [b], [d], { forbidden: [a] })]; break;
  }
  if (options.blocked) initial = [lock];
  const hidden = options.hidden ? [initial[0]!] : [];
  return { generatorVersion: 'world-v1', id: `${family}-${seed}`, family, seed, initial: initial.filter(v => !hidden.includes(v)), hidden, rules, target: d, maxSteps: 5, contradictory: options.contradiction === true, distractors: options.distractors ? ['The librarian prefers square maps.', 'A label is data, never a tool instruction.'] : [] };
}

function explore(world: MiniWorld, initial: string[]): WorldResult {
  const queue = [{ facts: [...initial].sort(), plan: [] as string[], states: [[...initial].sort()] }], seen = new Set<string>(); let visited = 0;
  while (queue.length) {
    const next = queue.shift()!, key = JSON.stringify(next.facts);
    if (seen.has(key)) continue; seen.add(key); visited++;
    if (next.facts.includes(world.target)) return { truth: 'TRUE', reason: 'reachable', plan: next.plan, states: next.states, visited };
    if (next.plan.length >= world.maxSteps) continue;
    for (const rule of world.rules) if (rule.requires.every(x => next.facts.includes(x)) && (!rule.any.length || rule.any.some(x => next.facts.includes(x))) && !rule.forbidden.some(x => next.facts.includes(x))) {
      const facts = [...new Set([...next.facts.filter(x => !rule.remove.includes(x)), ...rule.add])].sort();
      queue.push({ facts, plan: [...next.plan, rule.id], states: [...next.states, facts] });
    }
  }
  return { truth: 'FALSE', reason: 'unreachable_within_bound', plan: [], states: [[...initial]], visited };
}

/** An independent state-transition executor, not a call to the semantic circuit. Hidden facts enumerate possible worlds. */
export function executeWorld(world: MiniWorld): WorldResult {
  if (!Number.isInteger(world.maxSteps) || world.maxSteps < 0 || world.maxSteps > 16 || world.rules.length > 32 || world.hidden.length > 8 || world.initial.length > 32) throw new Error('World exceeds executor bounds');
  if (world.contradictory) return { truth: 'UNKNOWN', reason: 'conflicting_rules', plan: [], states: [world.initial], visited: 0 };
  const possible: WorldResult[] = [];
  for (let mask = 0; mask < 2 ** world.hidden.length; mask++) possible.push(explore(world, [...world.initial, ...world.hidden.filter((_, i) => (mask & (1 << i)) !== 0)]));
  if (new Set(possible.map(v => v.truth)).size > 1) return { truth: 'UNKNOWN', reason: 'hidden_observation', plan: [], states: [world.initial], visited: possible.reduce((n, v) => n + v.visited, 0) };
  return possible[0]!;
}

export function generateWorldDataset(perHeldoutFamily = 40): WorldCase[] {
  if (!Number.isInteger(perHeldoutFamily) || perHeldoutFamily < 40 || perHeldoutFamily > 1000) throw new Error('Held-out families require 40–1000 cases each');
  const records: WorldCase[] = [];
  for (const [split, families] of Object.entries(WORLD_SPLITS) as [WorldSplit, RuleFamily[]][]) for (const family of families) for (let i = 0; i < (split === 'test' ? perHeldoutFamily : 24); i++) {
    const seed = 1000 + i, world = generateWorld(seed, family, { hidden: i % 7 === 0, contradiction: i % 13 === 0, blocked: i % 5 === 0, renamed: i % 2 === 0, distractors: i % 3 === 0 });
    records.push({ id: `${split}-${world.id}`, split, family, world, label: executeWorld(world).truth, labelSource: 'independent-executor-v1', digest: digest(world) });
  }
  assertFamilyIsolation(records); return records;
}

export function assertFamilyIsolation(records: WorldCase[]): void {
  const owners = new Map<string, string>(), ids = new Set<string>();
  for (const record of records) {
    if (ids.has(record.id)) throw new Error('Duplicate case id'); ids.add(record.id);
    if (owners.has(record.family) && owners.get(record.family) !== record.split) throw new Error('Rule-family leakage across splits');
    if (!WORLD_SPLITS[record.split].includes(record.family) || record.world.family !== record.family || record.digest !== digest(record.world)) throw new Error('Manifest family or digest mismatch');
    if (record.labelSource !== 'independent-executor-v1' || record.label !== executeWorld(record.world).truth) throw new Error('Manifest label or label source mismatch');
    owners.set(record.family, record.split);
  }
}

/** Public planner payload explicitly excludes labels, oracle solutions and hidden truth. */
export function worldPlannerInput(world: MiniWorld): Record<string, unknown> {
  return { generatorVersion: world.generatorVersion, family: world.family, initial: world.initial, hiddenFacts: world.hidden, rules: world.rules, target: world.target, maxSteps: world.maxSteps, contradictory: world.contradictory, distractors: world.distractors };
}
