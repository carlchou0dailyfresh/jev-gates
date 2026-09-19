import type { Answer, EvaluationOptions, Json, Provider, ProviderResponse, Question } from '../types.js';
import { nonempty, PROVIDER_LIMITS, validateQuestions } from './http.js';
import { validateResponse } from './validation.js';

/** Deterministic test fixtures. This provider does not evaluate the meaning of input. */
export class MockProvider implements Provider {
  readonly name = 'mock';
  readonly model: string;
  private readonly fixtures: Record<string, Answer>;
  constructor(answers: Record<string, Answer>, options: { model?: string } = {}) {
    this.model = nonempty(options.model ?? 'mock-fixtures-v1', 'Mock model');
    this.fixtures = structuredClone(answers);
  }
  async evaluate(_state: Json, questions: Record<string, Question>, options: EvaluationOptions = {}): Promise<ProviderResponse> {
    if (options.signal?.aborted) throw new Error('Provider request aborted');
    validateQuestions(questions, PROVIDER_LIMITS.typesafe);
    const answers = Object.fromEntries(Object.keys(questions).map(id => {
      if (!Object.hasOwn(this.fixtures, id)) throw new Error('Mock fixture is missing a requested answer');
      return [id, this.fixtures[id]];
    }));
    return validateResponse({ model: this.model, answers }, questions);
  }
}
