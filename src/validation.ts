import { canonical, jsonCopy, validPointer } from './json.js';
import type { Circuit, GateNode } from './types.js';

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function object(value: unknown): asserts value is Record<string, any> { assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected object'); }
function keys(value: Record<string, unknown>, allowed: string[]) { assert(Object.keys(value).every(key => allowed.includes(key)), 'Unexpected field: ' + Object.keys(value).filter(key => !allowed.includes(key)).join(', ')); }
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(text) && new Set(value).size === value.length; }
function finite(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }
function probability(value: unknown): value is number { return finite(value) && value >= 0 && value <= 1; }
const safeId = (id: unknown): id is string => typeof id === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(id) && !['constructor', 'prototype', '__proto__'].includes(id);
export function dependencies(node: GateNode): string[] {
  return node.kind === 'logic' ? node.inputs : node.kind === 'semantic' ? [...new Set([...(node.context ?? []), ...(node.when ? [node.when] : [])])] : [];
}
export function validateCircuit(raw: unknown): Circuit {
  canonical(raw);
  object(raw); keys(raw, ['version', 'name', 'nodes', 'outputs']);
  assert(raw.version === 1 && text(raw.name), 'Circuit requires version: 1 and a name');
  assert(Array.isArray(raw.nodes) && raw.nodes.length > 0 && raw.nodes.length <= 256, 'Circuit requires 1–256 nodes');
  assert(strings(raw.outputs) && raw.outputs.length > 0, 'Circuit requires unique outputs');
  const ids = new Set<string>();
  for (const node of raw.nodes) {
    object(node); assert(safeId(node.id) && !ids.has(node.id), 'Invalid or duplicate node id'); ids.add(node.id);
    if (node.kind === 'constant') {
      keys(node, ['id', 'kind', 'value']); assert(['TRUE', 'FALSE', 'UNKNOWN'].includes(node.value), 'Invalid constant');
    } else if (node.kind === 'logic') {
      keys(node, ['id', 'kind', 'op', 'inputs', 'k']);
      assert(['and', 'or', 'not', 'xor', 'nand', 'nor', 'kofn'].includes(node.op), 'Unknown logic operator');
      assert(strings(node.inputs) && node.inputs.length > 0, 'Logic requires unique input ids');
      if (node.op === 'not') assert(node.inputs.length === 1, 'NOT requires one input');
      if (node.op === 'kofn') assert(Number.isInteger(node.k) && node.k >= 1 && node.k <= node.inputs.length, 'Invalid k-of-n threshold');
      else assert(node.k === undefined, 'k is only valid for kofn');
    } else if (node.kind === 'rule') {
      keys(node, ['id', 'kind', 'path', 'op', 'value']); assert(validPointer(node.path), 'Invalid JSON Pointer');
      assert(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'exists'].includes(node.op), 'Unknown rule operator');
      if (node.op === 'exists') assert(!Object.hasOwn(node, 'value'), 'exists does not accept value');
      else assert(Object.hasOwn(node, 'value'), 'Rule requires value');
      if (['gt', 'gte', 'lt', 'lte'].includes(node.op)) assert(finite(node.value), 'Numeric rule requires a finite numeric value');
    } else if (node.kind === 'semantic') {
      keys(node, ['id', 'kind', 'question', 'policy', 'input', 'context', 'when']);
      assert(node.input === undefined || validPointer(node.input), 'Invalid semantic input pointer');
      assert(node.context === undefined || strings(node.context), 'Invalid context');
      assert(node.when === undefined || safeId(node.when), 'Invalid when dependency');
      const q = node.question, p = node.policy; object(q); object(p);
      keys(q, ['type', 'instructions', 'criteria']); assert(text(q.instructions), 'Question requires instructions');
      assert(q.type === p.type, 'Question and policy types must match');
      if (q.type === 'noul') {
        if (q.criteria !== undefined) { object(q.criteria); keys(q.criteria, ['true', 'false']); assert(Object.values(q.criteria).every(text), 'Invalid noul criteria'); }
        keys(p, ['type', 'falseAt', 'trueAt']); assert(probability(p.falseAt) && probability(p.trueAt) && p.falseAt < p.trueAt, 'Noul requires 0 <= falseAt < trueAt <= 1');
      } else if (q.type === 'choice') {
        object(q.criteria); const labels = Object.keys(q.criteria);
        assert(labels.length >= 2 && labels.length <= 128 && labels.every(text) && Object.values(q.criteria).every(v => v === null || typeof v === 'string'), 'Invalid choice criteria');
        keys(p, ['type', 'trueLabels', 'falseLabels', 'unknownLabels', 'minProbability', 'minMargin']);
        assert(strings(p.trueLabels) && strings(p.falseLabels) && strings(p.unknownLabels) && p.unknownLabels.length > 0, 'Choice requires disjoint labels and explicit unknownLabels');
        const partition = [...p.trueLabels, ...p.falseLabels, ...p.unknownLabels];
        assert(new Set(partition).size === partition.length && partition.length === labels.length && partition.every(label => labels.includes(label)), 'Choice labels must partition all criteria');
        assert(probability(p.minProbability) && probability(p.minMargin), 'Invalid choice thresholds');
      } else if (q.type === 'score') {
        assert(Array.isArray(q.criteria) && q.criteria.length >= 2 && q.criteria.length <= 10 && q.criteria.every(text), 'Score requires 2–10 levels');
        keys(p, ['type', 'falseAt', 'trueAt', 'minConfidence']);
        assert(finite(p.falseAt) && finite(p.trueAt) && p.falseAt >= 0 && p.trueAt <= q.criteria.length - 1 && p.falseAt < p.trueAt && probability(p.minConfidence), 'Invalid score policy');
      } else throw new Error('Unknown question type');
    } else throw new Error('Unknown node kind');
  }
  const circuit = raw as unknown as Circuit;
  for (const node of circuit.nodes) for (const dep of dependencies(node)) assert(ids.has(dep), `Missing dependency: ${dep}`);
  for (const output of circuit.outputs) assert(ids.has(output), `Missing output: ${output}`);
  const pending = [...circuit.nodes], visited = new Set<string>();
  while (pending.length) {
    const index = pending.findIndex(node => dependencies(node).every(id => visited.has(id)));
    assert(index >= 0, 'Circuit contains a dependency cycle');
    visited.add(pending.splice(index, 1)[0]!.id);
  }
  return jsonCopy(circuit);
}
