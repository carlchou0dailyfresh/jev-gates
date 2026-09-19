import { validateCircuit } from './validation.js';
import type { Circuit, GateNode } from './types.js';

/** Mount a reusable subcircuit into a larger DAG with namespaced references. */
export function mountCircuit(prefix: string, raw: Circuit): { nodes: GateNode[]; outputs: string[] } {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(prefix)) throw new Error('Invalid circuit prefix');
  const circuit = validateCircuit(raw), id = (value: string) => `${prefix}.${value}`;
  const nodes = circuit.nodes.map((node): GateNode => {
    if (node.kind === 'logic') return { ...node, id: id(node.id), inputs: node.inputs.map(id) };
    if (node.kind === 'semantic') return { ...node, id: id(node.id), ...(node.context ? { context: node.context.map(id) } : {}), ...(node.when ? { when: id(node.when) } : {}) };
    return { ...node, id: id(node.id) };
  });
  const mounted = { version: 1 as const, name: circuit.name, nodes, outputs: circuit.outputs.map(id) };
  validateCircuit(mounted);
  return { nodes, outputs: mounted.outputs };
}
export function toMermaid(raw: Circuit): string {
  const circuit = validateCircuit(raw);
  const ids = new Map(circuit.nodes.map((node, i) => [node.id, `n${i}`]));
  const lines = ['flowchart TD'];
  for (const node of circuit.nodes) {
    const label = `${node.id} · ${node.kind === 'semantic' ? 'JEV ' + node.question.type : node.kind === 'logic' ? node.op.toUpperCase() : node.kind}`;
    lines.push(`  ${ids.get(node.id)}["${label}"]`);
    if (node.kind === 'logic') for (const input of node.inputs) lines.push(`  ${ids.get(input)} --> ${ids.get(node.id)}`);
    if (node.kind === 'semantic') {
      for (const input of node.context ?? []) lines.push(`  ${ids.get(input)} -->|context| ${ids.get(node.id)}`);
      if (node.when) lines.push(`  ${ids.get(node.when)} -.->|when TRUE| ${ids.get(node.id)}`);
    }
  }
  for (const output of circuit.outputs) lines.push(`  style ${ids.get(output)} stroke:#10b981,stroke-width:3px`);
  return lines.join('\n') + '\n';
}
