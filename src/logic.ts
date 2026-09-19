import type { Truth, LogicNode, Answer, Policy, Signal, Question } from './types.js';
import { validateCircuit } from './validation.js';
import { validateAnswer } from './providers/validation.js';

function assertTruths(values: readonly Truth[]): void {
  if (!Array.isArray(values) || !values.length || values.some(v => !['TRUE', 'FALSE', 'UNKNOWN'].includes(v))) throw new Error('Invalid truth values');
}

export function not(value: Truth): Truth {
  assertTruths([value]);
  return value === 'TRUE' ? 'FALSE' : value === 'FALSE' ? 'TRUE' : 'UNKNOWN';
}
export function and(values: readonly Truth[]): Truth {
  assertTruths(values);
  if (values.includes('FALSE')) return 'FALSE';
  return values.includes('UNKNOWN') ? 'UNKNOWN' : 'TRUE';
}
export function or(values: readonly Truth[]): Truth {
  assertTruths(values);
  if (values.includes('TRUE')) return 'TRUE';
  return values.includes('UNKNOWN') ? 'UNKNOWN' : 'FALSE';
}
export function kofn(values: readonly Truth[], k: number): Truth {
  assertTruths(values);
  if (!Number.isInteger(k) || k < 1 || k > values.length) throw new Error('Invalid k');
  const yes = values.filter(v => v === 'TRUE').length;
  const unknown = values.filter(v => v === 'UNKNOWN').length;
  return yes >= k ? 'TRUE' : yes + unknown < k ? 'FALSE' : 'UNKNOWN';
}
export function logic(op: LogicNode['op'], values: readonly Truth[], k?: number): Truth {
  if (!values.length || values.some(v => !['TRUE', 'FALSE', 'UNKNOWN'].includes(v))) throw new Error('Invalid logic inputs');
  switch (op) {
    case 'and': return and(values);
    case 'or': return or(values);
    case 'not': if (values.length !== 1) throw new Error('NOT needs one input'); return not(values[0]!);
    case 'nand': return not(and(values));
    case 'nor': return not(or(values));
    case 'xor': return values.includes('UNKNOWN') ? 'UNKNOWN' : values.filter(v => v === 'TRUE').length % 2 ? 'TRUE' : 'FALSE';
    case 'kofn': return kofn(values, k!);
    default: throw new Error('Unknown logic operator');
  }
}
/** These policies are caller-defined decision bands, not universal accuracy guarantees. */
export function applyPolicy(answer: Answer, policy: Policy): Signal {
  // This helper is public: preserve runCircuit's validation even when called directly.
  try {
    let question: Question;
    if (policy.type === 'noul') question = { type: 'noul', instructions: 'Validate policy input' };
    else if (policy.type === 'choice') question = { type: 'choice', instructions: 'Validate policy input', criteria: Object.fromEntries([...policy.trueLabels, ...policy.falseLabels, ...policy.unknownLabels].map(label => [label, null])) };
    else if (policy.type === 'score' && answer.type === 'score') {
      const legend = answer.legend;
      question = { type: 'score', instructions: 'Validate policy input', criteria: Array.from({ length: Object.keys(legend).length }, (_, i) => legend[String(i)]!) };
    } else return { truth: 'UNKNOWN', reason: 'answer_type_mismatch' };
    validateCircuit({ version: 1, name: 'policy-validation', nodes: [{ id: 'value', kind: 'semantic', question, policy }], outputs: ['value'] });
    answer = validateAnswer(answer, question);
  } catch { return { truth: 'UNKNOWN', reason: 'invalid_policy_or_answer' }; }
  if (answer.type !== policy.type) return { truth: 'UNKNOWN', reason: 'answer_type_mismatch' };
  let truth: Truth = 'UNKNOWN';
  let reason = 'within_abstention_band';
  if (answer.type === 'noul' && policy.type === 'noul') {
    truth = answer.noul >= policy.trueAt ? 'TRUE' : answer.noul <= policy.falseAt ? 'FALSE' : 'UNKNOWN';
  } else if (answer.type === 'score' && policy.type === 'score') {
    if (answer.confidence < policy.minConfidence) reason = 'insufficient_confidence';
    else truth = answer.score >= policy.trueAt ? 'TRUE' : answer.score <= policy.falseAt ? 'FALSE' : 'UNKNOWN';
  } else if (answer.type === 'choice' && policy.type === 'choice') {
    const selected = answer.probabilities[answer.choice]!;
    const runnerUp = Math.max(0, ...Object.entries(answer.probabilities).filter(([key]) => key !== answer.choice).map(([, p]) => p));
    if (policy.unknownLabels.includes(answer.choice)) reason = 'unknown_label';
    else if (selected < policy.minProbability || selected - runnerUp < policy.minMargin) reason = 'insufficient_choice_separation';
    else if (policy.trueLabels.includes(answer.choice)) truth = 'TRUE';
    else if (policy.falseLabels.includes(answer.choice)) truth = 'FALSE';
  }
  return { truth, reason: truth === 'UNKNOWN' ? reason : 'policy_matched', answer };
}
