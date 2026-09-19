import type { Answer, ProviderResponse, Question } from '../types.js';

/** Allow floating point/JSON rounding, without repairing a malformed distribution. */
const EPSILON = 1e-6;

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  // Do not include untrusted response text, labels, or state in diagnostics.
  throw new Error(`Invalid provider response: ${message}`);
}

function sameKeys(value: Record<string, unknown>, expected: string[], name: string): void {
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) {
    invalid(`${name} keys do not match the question`);
  }
}

function probability(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    invalid(`${name} must be a finite number from 0 to 1`);
  }
  return value;
}

function probabilities(raw: unknown, labels: string[]): Record<string, number> {
  if (!record(raw)) invalid('probabilities must be an object');
  sameKeys(raw, labels, 'probabilities');
  const entries = labels.map(label => [label, probability(raw[label], 'probability')] as const);
  if (Math.abs(entries.reduce((sum, [, p]) => sum + p, 0) - 1) > EPSILON) {
    invalid('probabilities must sum to 1');
  }
  return Object.fromEntries(entries);
}

/** Validate, copy, and retain only the documented answer fields. No confidence is invented. */
export function validateAnswer(raw: unknown, question: Question): Answer {
  if (!record(raw) || raw.type !== question.type) invalid('answer type does not match question');
  if (question.type === 'noul') return { type: 'noul', noul: probability(raw.noul, 'noul') };
  const confidence = probability(raw.confidence, 'confidence');
  if (question.type === 'choice') {
    const labels = Object.keys(question.criteria);
    const distribution = probabilities(raw.probabilities, labels);
    if (typeof raw.choice !== 'string' || !Object.hasOwn(distribution, raw.choice)) {
      invalid('choice is not one of the question labels');
    }
    const winning = distribution[raw.choice]!;
    if (Object.values(distribution).some(p => p > winning + EPSILON)) invalid('choice is not a highest-probability label');
    return { type: 'choice', choice: raw.choice, probabilities: distribution, confidence };
  }
  const labels = question.criteria.map((_, index) => String(index));
  const distribution = probabilities(raw.probabilities, labels);
  if (!record(raw.legend)) invalid('score legend must be an object');
  sameKeys(raw.legend, labels, 'legend');
  const legend = raw.legend;
  if (labels.some((label, index) => legend[label] !== question.criteria[index])) invalid('score legend differs from the rubric');
  if (typeof raw.score !== 'number' || !Number.isFinite(raw.score) || raw.score < 0 || raw.score > labels.length - 1) {
    invalid('score is outside the rubric range');
  }
  const expected = labels.reduce((sum, label, index) => sum + index * distribution[label]!, 0);
  if (Math.abs(raw.score - expected) > EPSILON * Math.max(1, labels.length - 1)) {
    invalid('score differs from the probability-weighted mean');
  }
  return { type: 'score', score: raw.score, probabilities: distribution,
    legend: Object.fromEntries(labels.map((label, index) => [label, question.criteria[index]!])), confidence };
}

export function validateResponse(raw: unknown, questions: Record<string, Question>): ProviderResponse {
  if (!record(raw) || typeof raw.model !== 'string' || !raw.model.trim()) invalid('model must be a nonempty string');
  if (!record(raw.answers)) invalid('answers must be an object');
  sameKeys(raw.answers, Object.keys(questions), 'answers');
  const rawAnswers = raw.answers;
  const result: ProviderResponse = { model: raw.model,
    answers: Object.fromEntries(Object.entries(questions).map(([id, question]) => [id, validateAnswer(rawAnswers[id], question)])) };
  if (raw.usage !== undefined) {
    if (!record(raw.usage) || !Number.isSafeInteger(raw.usage.input_tokens) || !Number.isSafeInteger(raw.usage.output_tokens)
      || (raw.usage.input_tokens as number) < 0 || (raw.usage.output_tokens as number) < 0) invalid('usage must contain nonnegative integer token counts');
    result.usage = { input_tokens: raw.usage.input_tokens as number, output_tokens: raw.usage.output_tokens as number };
  }
  // LocalJev 0.2 currently omits this metadata on evaluations. Accept explicit extensions.
  for (const key of ['upstream_model', 'upstreamModel']) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !(raw[key] as string).trim())) invalid('upstream model must be a nonempty string');
  }
  if (raw.upstream_model !== undefined && raw.upstreamModel !== undefined && raw.upstream_model !== raw.upstreamModel) {
    invalid('upstream model metadata is inconsistent');
  }
  const upstream = raw.upstream_model ?? raw.upstreamModel;
  if (typeof upstream === 'string') result.upstreamModel = upstream;
  return result;
}
