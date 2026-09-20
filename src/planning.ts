/** Deterministic, bounded reference solver. It receives no provider output or labels. */
export interface StationTask { id: string; energy: number; minutes: number; instrument: string; requires: string[]; produces: string[] }
export interface StationProblem { energy: number; minutes: number; instruments: string[]; initial: string[]; goals: string[]; tasks: StationTask[] }
export interface StationPlan { feasible: boolean; steps: string[]; energyUsed: number; minutesUsed: number; facts: string[]; reason: string; visited: number }

export function validateStation(problem: StationProblem): void {
  const strings = (value: unknown): value is string[] => Array.isArray(value) && value.length <= 256 && value.every(v => typeof v === 'string' && v.length > 0 && v.length <= 128) && new Set(value).size === value.length;
  if (!problem || !Number.isFinite(problem.energy) || problem.energy < 0 || !Number.isFinite(problem.minutes) || problem.minutes < 0) throw new Error('Invalid resource budget');
  if (!Array.isArray(problem.tasks) || problem.tasks.length > 16 || !strings(problem.instruments) || !strings(problem.initial) || !strings(problem.goals) || !problem.goals.length) throw new Error('Station requires bounded tasks and unique string facts with at least one goal');
  const ids = new Set<string>();
  for (const task of problem.tasks) {
    if (!task || typeof task.id !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(task.id) || ids.has(task.id) || !Number.isFinite(task.energy) || task.energy < 0 || !Number.isFinite(task.minutes) || task.minutes < 0 || typeof task.instrument !== 'string' || !task.instrument || !strings(task.requires) || !strings(task.produces)) throw new Error('Invalid station task');
    ids.add(task.id);
  }
}

/** Independently verifies a proposed sequence; neither a model nor a solver receipt is trusted. */
export function verifyStationPlan(problem: StationProblem, steps: string[]): StationPlan {
  validateStation(problem);
  let energyUsed = 0, minutesUsed = 0;
  const facts = new Set(problem.initial), completed = new Set<string>();
  const fail = (reason: string): StationPlan => ({ feasible: false, steps: [...steps], energyUsed, minutesUsed, facts: [...facts].sort(), reason, visited: 0 });
  if (!Array.isArray(steps) || steps.length > problem.tasks.length) return fail('invalid_plan_length');
  for (const id of steps) {
    const task = problem.tasks.find(task => task.id === id);
    if (!task || completed.has(id)) return fail('unknown_or_duplicate_task');
    if (!problem.instruments.includes(task.instrument)) return fail('instrument_unavailable');
    if (!task.requires.every(fact => facts.has(fact))) return fail('prerequisite_missing');
    energyUsed += task.energy; minutesUsed += task.minutes;
    if (energyUsed > problem.energy || minutesUsed > problem.minutes) return fail('resource_exceeded');
    completed.add(id); task.produces.forEach(fact => facts.add(fact));
  }
  return { feasible: problem.goals.every(goal => facts.has(goal)), steps: [...steps], energyUsed, minutesUsed, facts: [...facts].sort(), reason: problem.goals.every(goal => facts.has(goal)) ? 'verified_goals' : 'goal_missing', visited: 0 };
}

/** Exhaustive subset search is complete for these non-consuming, one-shot station tasks. */
export function solveStation(problem: StationProblem): StationPlan {
  validateStation(problem);
  const queue: string[][] = [[]], seen = new Set<string>(); let visited = 0;
  while (queue.length) {
    const steps = queue.shift()!;
    const key = JSON.stringify([...steps].sort());
    if (seen.has(key)) continue;
    seen.add(key); visited++;
    const checked = verifyStationPlan(problem, steps);
    if (checked.feasible) return { ...checked, visited };
    if (checked.reason !== 'goal_missing') continue;
    for (const task of problem.tasks) if (!steps.includes(task.id) && problem.instruments.includes(task.instrument) && task.requires.every(f => checked.facts.includes(f)) && checked.energyUsed + task.energy <= problem.energy && checked.minutesUsed + task.minutes <= problem.minutes) queue.push([...steps, task.id]);
  }
  return { feasible: false, steps: [], energyUsed: 0, minutesUsed: 0, facts: [...problem.initial], reason: 'constraints_unsatisfiable', visited };
}

export function stationFixture(variant = 'normal', overrides: Record<string, unknown> = {}): StationProblem {
  const problem: StationProblem = {
    energy: variant === 'low-energy' || variant === 'conflict' ? 3 : 12,
    minutes: variant === 'short-window' ? 3 : 20,
    instruments: variant === 'instrument-off' ? ['radio', 'camera'] : ['spectrometer', 'radio', 'camera'], initial: ['station-ready'], goals: ['report-sent'],
    tasks: [
      { id: 'spectral-sample', energy: 5, minutes: 6, instrument: 'spectrometer', requires: ['station-ready'], produces: ['sample'] },
      { id: 'photo-sample', energy: 3, minutes: 8, instrument: 'camera', requires: ['station-ready'], produces: ['sample'] },
      { id: 'analyse', energy: 2, minutes: 4, instrument: 'radio', requires: ['sample'], produces: ['analysis'] },
      { id: 'transmit', energy: 2, minutes: 2, instrument: 'radio', requires: ['analysis'], produces: ['report-sent'] },
    ],
  };
  if (variant === 'no-radio') problem.instruments = ['camera', 'spectrometer'];
  if (variant === 'missing') problem.initial = [];
  if (variant === 'extra-goal') problem.goals.push('water-found');
  if (variant === 'ample-budget') problem.energy = 30;
  if (variant === 'exact-budget') problem.energy = 7;
  for (const key of ['energy', 'minutes'] as const) if (typeof overrides[key] === 'number') problem[key] = overrides[key];
  if (Array.isArray(overrides.instruments) && overrides.instruments.every(v => typeof v === 'string')) problem.instruments = overrides.instruments as string[];
  validateStation(problem); return problem;
}
