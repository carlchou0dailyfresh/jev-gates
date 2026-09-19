import { memo, useEffect, useMemo, useState } from 'react';
import { Background, Controls, Handle, Position, ReactFlow, applyNodeChanges, type Node, type NodeProps, type Connection, type ReactFlowInstance } from '@xyflow/react';
import type { Circuit, Signal } from './api';
import { dependencies } from './api';
import type { NodeExecution } from './execution';

export const kindLabels: Record<string, string> = { semantic: '語意判斷', logic: '程式邏輯', rule: '精確規則', constant: '固定值' };
export function TruthBadge({ truth }: { truth?: string }) {
  const words: Record<string, string> = { TRUE: '成立', FALSE: '不成立', UNKNOWN: '未知' };
  return <span className={`truth truth-${truth ?? 'idle'}`}>{truth === 'TRUE' ? '●' : truth === 'FALSE' ? '×' : truth === 'UNKNOWN' ? '?' : '○'} {truth ? `${words[truth] ?? truth} · ${truth}` : '尚未判斷'}</span>;
}
const Gate = memo(function Gate({ data, selected }: NodeProps) {
  return <div className={`gate ${selected ? 'selected' : ''}`}>
    <Handle type="target" position={Position.Left} aria-label="輸入連線" />
    <div className="gate-kicker">{String(data.kindLabel)}<span>{String(data.index)}</span></div>
    <strong>{String(data.label)}</strong>
    <p>{String(data.subtitle)}</p>
    {data.group ? <span className="group-count">已折疊 · {String(data.count)} 個節點</span> : <><TruthBadge truth={data.truth as string | undefined} /><span className={`graph-execution execution-${String(data.executionState)}`}>{String(data.executionLabel ?? '尚未執行')}</span></>}
    <Handle type="source" position={Position.Right} aria-label="輸出連線" />
  </div>;
});
const nodeTypes = { gate: Gate };
export default function Graph({ circuit, signals, executionStates, selected, onSelect, onConnect, folded, layoutKey, search }: {
  circuit: Circuit; signals: Record<string, Signal>; executionStates: Record<string, NodeExecution>; selected?: string; onSelect: (id: string) => void; onConnect: (connection: Connection) => void; folded: boolean; layoutKey: number; search: string;
}) {
  const [flow, setFlow] = useState<ReactFlowInstance | null>(null);
  const model = useMemo(() => {
    const depths = new Map<string, number>(); const columns = new Map<number, number>(); const visiting = new Set<string>();
    const byId = new Map(circuit.nodes.map(n => [n.id, n]));
    function depth(id: string): number { if (depths.has(id)) return depths.get(id)!; if (visiting.has(id)) return 0; visiting.add(id); const node = byId.get(id); const d = node ? Math.max(-1, ...dependencies(node).map(depth)) + 1 : 0; depths.set(id, d); visiting.delete(id); return d; }
    const groups = new Map<string, string[]>();
    for (const node of circuit.nodes) { const group = node.id.includes('.') ? node.id.split('.')[0] : node.kind; groups.set(group, [...(groups.get(group) ?? []), node.id]); }
    const groupFor = new Map([...groups.entries()].flatMap(([name, ids]) => ids.map(id => [id, name] as const)));
    const baseNodes: Node[] = folded ? [...groups].map(([name, ids], i) => ({ id: `group:${name}`, type: 'gate', position: { x: i * 290, y: 60 }, data: { label: kindLabels[name] ?? name, kindLabel: '視覺群組（不計算群組真值）', index: `G${i + 1}`, subtitle: ids.slice(0, 3).join(' · '), group: true, count: ids.length } })) : circuit.nodes.map((node, index) => {
      const d = depth(node.id); const row = columns.get(d) ?? 0; columns.set(d, row + 1);
      return { id: node.id, type: 'gate', position: { x: d * 300 + 24, y: row * 174 + 24 }, selected: selected === node.id, className: search && !node.id.toLowerCase().includes(search.toLowerCase()) ? 'dimmed' : '', data: { label: node.id, kindLabel: kindLabels[node.kind], index: String(index + 1).padStart(2, '0'), subtitle: node.kind === 'semantic' ? node.question.instructions : node.kind === 'logic' ? node.op.toUpperCase() : node.kind === 'rule' ? `${node.path} ${node.op}` : '由輸入契約固定', truth: signals[node.id]?.truth, executionState: executionStates[node.id]?.state, executionLabel: executionStates[node.id]?.label } };
    });
    const seen = new Set<string>();
    const edges = circuit.nodes.flatMap(node => dependencies(node).flatMap(source => {
      const from = folded ? `group:${groupFor.get(source)}` : source; const to = folded ? `group:${groupFor.get(node.id)}` : node.id;
      const id = `${from}->${to}`; if (from === to || seen.has(id)) return []; seen.add(id);
      return [{ id, source: from, target: to, type: 'smoothstep', style: { stroke: '#7d9693', strokeWidth: 1.5 }, animated: false }];
    }));
    return { nodes: baseNodes, edges };
  }, [circuit, signals, executionStates, selected, folded, search, layoutKey]);
  const [nodes, setNodes] = useState<Node[]>(model.nodes);
  useEffect(() => setNodes(model.nodes), [model.nodes]);
  useEffect(() => { if (flow) requestAnimationFrame(() => { void flow.fitView({ padding: 0.15, duration: 0 }); }); }, [flow, layoutKey, folded, circuit.name]);
  return <ReactFlow nodes={nodes} edges={model.edges} nodeTypes={nodeTypes} onNodesChange={changes => setNodes(ns => applyNodeChanges(changes, ns))} onNodeClick={(_, node) => onSelect(node.id)} onConnect={onConnect} onInit={setFlow} fitView minZoom={0.15} maxZoom={1.8} deleteKeyCode={null} nodesConnectable={!folded} aria-label="電路圖；下方節點清單提供完整鍵盤替代操作" proOptions={{ hideAttribution: false }}>
    <Background gap={22} size={1} color="#d4dcd6" /><Controls showInteractive={false} aria-label="圖形縮放控制" />
  </ReactFlow>;
}
