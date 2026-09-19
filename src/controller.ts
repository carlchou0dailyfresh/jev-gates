import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Json, Truth } from './types.js';

export type ControllerState = { terminal: true } | {
  gate: string;
  tool: string;
  next: string;
  /** Omit to wait in the same state. FALSE cannot transition to a terminal state. */
  onFalse?: string;
};
export interface ControllerDefinition {
  id: string;
  /** Bump when external gate policies, tools, or verification semantics change. */
  version: string;
  initial: string;
  maxSteps: number;
  states: Record<string, ControllerState>;
}
export interface ActionContext { state: string; tool: string; operationId: string; step: number }
export interface ControllerTool<Snapshot = Json> {
  execute(snapshot: Snapshot, context: ActionContext): Promise<unknown>;
  /** Must check actual evidence deterministically; only the boolean true advances. */
  verify(receipt: unknown, context: ActionContext): boolean | Promise<boolean>;
}
export type ControllerStatus = 'ready' | 'waiting' | 'paused' | 'pending' | 'completed' | 'exhausted';
export type ControllerReason = 'condition_unknown' | 'condition_error' | 'condition_false'
  | 'awaiting_receipt' | 'tool_error' | 'verification_failed' | 'verification_error' | 'budget_exhausted';
export interface ControllerCheckpoint {
  schemaVersion: 1;
  definitionDigest: string;
  state: string;
  steps: number;
  status: ControllerStatus;
  reason?: ControllerReason;
  pending?: ActionContext & { next: string };
}
export interface CheckpointStore {
  save(checkpoint: ControllerCheckpoint): Promise<void>;
  /** Pass the returned value to Controller's checkpoint option for validation. */
  load(): Promise<unknown | null>;
}
export interface ControllerOptions<Snapshot = Json> {
  evaluate(gate: string, snapshot: Snapshot, context: { state: string; step: number }): Truth | Promise<Truth>;
  tools: Record<string, ControllerTool<Snapshot>>;
  store?: CheckpointStore;
  checkpoint?: unknown;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid controller data: ${message}`);
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  assert(Object.keys(value).every(key => allowed.includes(key)), 'unexpected fields');
}
function name(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 256; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function validateDefinition(value: unknown): asserts value is ControllerDefinition {
  assert(record(value), 'definition must be an object');
  keys(value, ['id', 'version', 'initial', 'maxSteps', 'states']);
  assert(name(value.id) && name(value.version) && name(value.initial), 'id, version and initial are required');
  assert(Number.isSafeInteger(value.maxSteps) && Number(value.maxSteps) > 0, 'maxSteps must be a positive safe integer');
  assert(record(value.states) && Object.keys(value.states).length > 0, 'states are required');
  const states = value.states;
  for (const [id, state] of Object.entries(states)) {
    assert(name(id) && record(state), 'invalid state');
    if (state.terminal === true) { keys(state, ['terminal']); continue; }
    keys(state, ['gate', 'tool', 'next', 'onFalse']);
    assert(name(state.gate) && name(state.tool) && name(state.next), `invalid transition in ${id}`);
    assert(Object.hasOwn(states, state.next), `missing next state in ${id}`);
    if (Object.hasOwn(state, 'onFalse')) {
      assert(name(state.onFalse) && Object.hasOwn(states, state.onFalse), `missing FALSE state in ${id}`);
      assert((states[state.onFalse] as Record<string, unknown>).terminal !== true, 'FALSE cannot complete a workflow');
    }
  }
  assert(Object.hasOwn(states, value.initial), 'initial state does not exist');
  assert((states[value.initial] as Record<string, unknown>).terminal !== true, 'initial state cannot be terminal');
}

export function controllerDefinitionDigest(definition: ControllerDefinition): string {
  validateDefinition(definition);
  return createHash('sha256').update(canonical(definition)).digest('hex');
}

function validateCheckpoint(value: unknown, definition: ControllerDefinition, digest: string): asserts value is ControllerCheckpoint {
  assert(record(value), 'checkpoint must be an object');
  keys(value, ['schemaVersion', 'definitionDigest', 'state', 'steps', 'status', 'reason', 'pending']);
  assert(value.schemaVersion === 1 && value.definitionDigest === digest, 'checkpoint definition digest mismatch');
  assert(name(value.state) && Object.hasOwn(definition.states, value.state), 'checkpoint state is unknown');
  assert(Number.isSafeInteger(value.steps) && Number(value.steps) >= 0 && Number(value.steps) <= definition.maxSteps, 'invalid step count');
  const status = value.status;
  assert(['ready', 'waiting', 'paused', 'pending', 'completed', 'exhausted'].includes(String(status)), 'invalid status');
  const state = definition.states[value.state]!;
  assert(('terminal' in state) === (status === 'completed'), 'terminal state/status mismatch');
  const reasons: Record<string, readonly unknown[]> = {
    ready: [undefined], waiting: ['condition_false'], paused: ['condition_unknown', 'condition_error'],
    pending: ['awaiting_receipt', 'tool_error', 'verification_failed', 'verification_error'],
    completed: [undefined], exhausted: ['budget_exhausted'],
  };
  assert(reasons[String(status)]!.includes(value.reason), 'invalid reason for status');
  if (status !== 'ready') assert(Number(value.steps) > 0, 'status requires a consumed step');
  if (status === 'exhausted') assert(value.steps === definition.maxSteps, 'exhausted without consuming budget');
  if (['ready', 'waiting', 'paused'].includes(String(status))) assert(Number(value.steps) < definition.maxSteps, 'runnable state exceeds budget');
  if (status === 'pending') {
    assert(record(value.pending) && !('terminal' in state), 'pending receipt is required');
    keys(value.pending, ['state', 'tool', 'operationId', 'step', 'next']);
    const p = value.pending;
    assert(p.state === value.state && p.tool === state.tool && p.next === state.next && p.step === value.steps, 'pending operation does not match transition');
    assert(typeof p.operationId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(p.operationId), 'invalid operation id');
  } else assert(!Object.hasOwn(value, 'pending'), 'unexpected pending operation');
}

/** An application-controlled state machine. It never contains browser, shell or eval execution. */
export class Controller<Snapshot = Json> {
  private readonly definition: ControllerDefinition;
  private readonly options: ControllerOptions<Snapshot>;
  private current: ControllerCheckpoint;
  private busy = false;

  constructor(definition: ControllerDefinition, options: ControllerOptions<Snapshot>) {
    const digest = controllerDefinitionDigest(definition);
    this.definition = structuredClone(definition);
    assert(typeof options.evaluate === 'function' && record(options.tools), 'evaluate and tools registry are required');
    const tools: Record<string, ControllerTool<Snapshot>> = Object.create(null) as Record<string, ControllerTool<Snapshot>>;
    for (const state of Object.values(this.definition.states)) {
      if ('terminal' in state) continue;
      const tool = Object.hasOwn(options.tools, state.tool) ? options.tools[state.tool] : undefined;
      assert(tool && typeof tool.execute === 'function' && typeof tool.verify === 'function', `tool ${state.tool} needs execute and verify`);
      tools[state.tool] = { execute: tool.execute, verify: tool.verify };
    }
    this.options = { ...options, tools };
    this.current = { schemaVersion: 1, definitionDigest: digest, state: definition.initial, steps: 0, status: 'ready' };
    if (options.checkpoint !== undefined) {
      validateCheckpoint(options.checkpoint, this.definition, digest);
      this.current = structuredClone(options.checkpoint);
    }
  }

  get checkpoint(): ControllerCheckpoint { return structuredClone(this.current); }

  private async exclusive(action: () => Promise<ControllerCheckpoint>): Promise<ControllerCheckpoint> {
    if (this.busy) throw new Error('Controller is already running; concurrent calls are rejected');
    this.busy = true;
    try { return await action(); } finally { this.busy = false; }
  }
  private async persist(next: ControllerCheckpoint): Promise<ControllerCheckpoint> {
    // Update memory only after durable save. A failed post-action save leaves pending intact.
    if (this.options.store) await this.options.store.save(structuredClone(next));
    this.current = structuredClone(next);
    return this.checkpoint;
  }
  private base(state = this.current.state): ControllerCheckpoint {
    return { schemaVersion: 1, definitionDigest: this.current.definitionDigest, state, steps: this.current.steps, status: 'ready' };
  }
  private async stop(status: 'waiting' | 'paused', reason: ControllerReason, state = this.current.state): Promise<ControllerCheckpoint> {
    const next = this.base(state);
    if (next.steps >= this.definition.maxSteps) { next.status = 'exhausted'; next.reason = 'budget_exhausted'; }
    else { next.status = status; next.reason = reason; }
    return this.persist(next);
  }

  /** Each invocation uses the supplied fresh snapshot; it consumes one step even when FALSE. */
  async step(snapshot: Snapshot): Promise<ControllerCheckpoint> {
    return this.exclusive(async () => {
      if (!['ready', 'waiting'].includes(this.current.status)) throw new Error(`Cannot step a ${this.current.status} controller`);
      const state = this.definition.states[this.current.state]!;
      if ('terminal' in state) throw new Error('Cannot execute a terminal state');
      // The count is saved before evaluation; no raw snapshot or model text is retained.
      const started = { ...this.base(), steps: this.current.steps + 1 };
      // Interrupted evaluations also require review; every on-disk state is resumable.
      if (started.steps >= this.definition.maxSteps) { started.status = 'exhausted'; started.reason = 'budget_exhausted'; }
      else { started.status = 'paused'; started.reason = 'condition_unknown'; }
      await this.persist(started);
      let truth: Truth;
      try { truth = await this.options.evaluate(state.gate, snapshot, { state: this.current.state, step: this.current.steps }); }
      catch { return this.stop('paused', 'condition_error'); }
      if (truth === 'FALSE') return this.stop('waiting', 'condition_false', state.onFalse ?? this.current.state);
      if (truth !== 'TRUE') return this.stop('paused', 'condition_unknown');
      const pending = { state: this.current.state, tool: state.tool, operationId: randomUUID(), step: this.current.steps, next: state.next };
      // A crash after this save requires an external receipt. Never automatically replay.
      await this.persist({ ...this.base(), status: 'pending', reason: 'awaiting_receipt', pending });
      let receipt: unknown;
      try { receipt = await this.options.tools[state.tool]!.execute(snapshot, { ...pending }); }
      catch { return this.persist({ ...this.current, reason: 'tool_error' }); }
      return this.verifyPending(receipt);
    });
  }

  private async verifyPending(receipt: unknown): Promise<ControllerCheckpoint> {
    const pending = this.current.pending!;
    let verified: boolean;
    try { verified = await this.options.tools[pending.tool]!.verify(receipt, { ...pending }); }
    catch { return this.persist({ ...this.current, reason: 'verification_error' }); }
    if (verified !== true) return this.persist({ ...this.current, reason: 'verification_failed' });
    const next = this.base(pending.next);
    if ('terminal' in this.definition.states[pending.next]!) next.status = 'completed';
    else if (next.steps >= this.definition.maxSteps) { next.status = 'exhausted'; next.reason = 'budget_exhausted'; }
    return this.persist(next);
  }

  /** Recover by checking external evidence for the same operation, without executing it again. */
  async resolvePending(receipt: unknown): Promise<ControllerCheckpoint> {
    return this.exclusive(async () => {
      if (this.current.status !== 'pending') throw new Error('No pending operation to resolve');
      return this.verifyPending(receipt);
    });
  }

  /** Explicit acknowledgement after a human/planner reviews UNKNOWN or evaluation failure. */
  async resumeAfterReview(): Promise<ControllerCheckpoint> {
    return this.exclusive(async () => {
      if (this.current.status !== 'paused') throw new Error('Only a paused controller can resume after review');
      return this.persist(this.base());
    });
  }
}

/** Single-writer local checkpoint storage. Atomic replacement is not cross-process locking. */
export class FileCheckpointStore implements CheckpointStore {
  constructor(readonly path: string) {}
  async load(): Promise<unknown | null> {
    try { return JSON.parse(await readFile(this.path, 'utf8')) as unknown; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  async save(checkpoint: ControllerCheckpoint): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
      await file.sync();
      await file.close();
      await rename(temporary, this.path);
    } catch (error) {
      await file.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
