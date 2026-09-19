/** UNKNOWN is a value, never a JavaScript false or a provider error disguised as false. */
export type Truth = 'TRUE' | 'FALSE' | 'UNKNOWN';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Question =
  | { type: 'noul'; instructions: string; criteria?: { true?: string; false?: string } }
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] };
export type Answer =
  | { type: 'noul'; noul: number }
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; probabilities: Record<string, number>; legend: Record<string, string>; confidence: number };
export interface EvaluationOptions { signal?: AbortSignal; /** Optional local capture. Never includes headers or credentials. */ onTransport?: (capture: { request: Json; response: Json }) => void }
export interface ProviderResponse {
  model: string;
  answers: Record<string, Answer>;
  usage?: { input_tokens: number; output_tokens: number };
  upstreamModel?: string;
}
export interface Provider {
  readonly name: string;
  readonly model: string;
  evaluate(state: Json, questions: Record<string, Question>, options?: EvaluationOptions): Promise<ProviderResponse>;
}
export type Policy =
  | { type: 'noul'; falseAt: number; trueAt: number }
  | { type: 'choice'; trueLabels: string[]; falseLabels: string[]; unknownLabels: string[]; minProbability: number; minMargin: number }
  | { type: 'score'; falseAt: number; trueAt: number; minConfidence: number };
export interface Signal {
  truth: Truth;
  reason: string;
  answer?: Answer;
}
export interface SemanticNode {
  id: string;
  kind: 'semantic';
  question: Question;
  policy: Policy;
  /** JSON Pointer into the original input; empty selects the whole input. */
  input?: string;
  /** Pass these advisory signals to the next JEV layer. */
  context?: string[];
  /** Only evaluate when this node is TRUE; FALSE and UNKNOWN remain distinct reasons. */
  when?: string;
}
export type RuleOperator = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists';
export interface RuleNode { id: string; kind: 'rule'; path: string; op: RuleOperator; value?: Json }
export interface LogicNode { id: string; kind: 'logic'; op: 'and' | 'or' | 'not' | 'xor' | 'nand' | 'nor' | 'kofn'; inputs: string[]; k?: number }
export interface ConstantNode { id: string; kind: 'constant'; value: Truth }
export type GateNode = SemanticNode | RuleNode | LogicNode | ConstantNode;
export interface Circuit { version: 1; name: string; nodes: GateNode[]; outputs: string[] }
export interface NodeTrace { id: string; kind: GateNode['kind']; signal: Signal; elapsedMs: number; requestDigest?: string }
export interface CallTrace { provider: string; requestedModel: string; model?: string; upstreamModel?: string; questionIds: string[]; requestDigest: string; elapsedMs: number; status: 'ok' | 'error'; error?: string; usage?: ProviderResponse['usage'] }
export interface RunResult {
  circuit: string; circuitDigest: string; inputDigest: string; status: 'evaluated' | 'abstained';
  signals: Record<string, Signal>; outputs: Record<string, Signal>; nodes: NodeTrace[]; calls: CallTrace[];
}
