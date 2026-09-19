import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest } from './json.js';

export type SandboxFault = 'timeout-after-applied' | 'verification-failed' | 'execute-failed';
export interface SandboxReceipt { operationId: string; applied: boolean; healthy: boolean; executionCount: number; status: 'pending' | 'applied' | 'failed'; parametersDigest: string; target: 'local-simulated-service' }
interface SandboxState { schemaVersion: 1; healthy: boolean; executionCount: number; operations: Record<string, SandboxReceipt> }

/** This adapter affects one JSON file only. The lock prevents two writers, including separate processes. */
export class SandboxService {
  constructor(readonly path: string) {}
  private async load(): Promise<SandboxState> {
    try {
      const state = JSON.parse(await readFile(this.path, 'utf8')) as SandboxState;
      if (state.schemaVersion !== 1 || typeof state.healthy !== 'boolean' || !Number.isSafeInteger(state.executionCount) || state.executionCount < 0 || !state.operations || typeof state.operations !== 'object') throw new Error('Invalid sandbox state');
      return state;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, healthy: false, executionCount: 0, operations: {} }; throw error; }
  }
  private async save(state: SandboxState): Promise<void> {
    const temp = `${this.path}.${randomUUID()}.tmp`, file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(state)); await file.sync(); await file.close(); await rename(temp, this.path); }
    catch (error) { await file.close().catch(() => undefined); await unlink(temp).catch(() => undefined); throw error; }
  }
  async repair(request: { operationId: string; fault?: SandboxFault; signal?: AbortSignal }): Promise<SandboxReceipt> {
    if (!/^[A-Za-z0-9_.-]{1,128}$/.test(request.operationId) || ['__proto__', 'constructor', 'prototype'].includes(request.operationId)) throw new Error('Invalid operation id');
    if (request.signal?.aborted) throw new Error('Repair cancelled before execution');
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = await open(`${this.path}.lock`, 'wx', 0o600).catch((error: NodeJS.ErrnoException) => { if (error.code === 'EEXIST') throw new Error('Sandbox writer is busy; query existing operation before retrying'); throw error; });
    try {
      const state = await this.load(), parametersDigest = digest({ action: 'repair', target: 'local-simulated-service' });
      if (Object.hasOwn(state.operations, request.operationId)) return structuredClone(state.operations[request.operationId]!);
      const receipt: SandboxReceipt = { operationId: request.operationId, applied: false, healthy: state.healthy, executionCount: state.executionCount, status: 'pending', parametersDigest, target: 'local-simulated-service' };
      state.operations[request.operationId] = receipt;
      // Persist intent before any action. A crash here leaves pending; do not silently apply it again.
      await this.save(state);
      if (request.fault === 'execute-failed') { receipt.status = 'failed'; await this.save(state); throw new Error('Injected sandbox execution failure'); }
      state.executionCount++; state.healthy = request.fault !== 'verification-failed';
      Object.assign(receipt, { applied: true, healthy: state.healthy, executionCount: state.executionCount, status: 'applied' });
      // In this simulation the destination mutation and its receipt share one atomic file replacement.
      await this.save(state);
      if (request.fault === 'timeout-after-applied') throw new Error('Injected timeout: destination may have applied; query the same operation id');
      return structuredClone(receipt);
    } finally { await lock.close(); await unlink(`${this.path}.lock`); }
  }
  async query(operationId: string): Promise<SandboxReceipt | null> { const state = await this.load(); return Object.hasOwn(state.operations, operationId) ? structuredClone(state.operations[operationId]!) : null; }
  async health(): Promise<{ healthy: boolean; executionCount: number }> { const state = await this.load(); return { healthy: state.healthy, executionCount: state.executionCount }; }
  async executionCount(): Promise<number> { return (await this.load()).executionCount; }
  async verify(receipt: unknown): Promise<boolean> {
    if (!receipt || typeof receipt !== 'object' || !('operationId' in receipt) || typeof receipt.operationId !== 'string') return false;
    const actual = await this.query(receipt.operationId), health = await this.health();
    return actual !== null && actual.applied && actual.status === 'applied' && actual.healthy && health.healthy && digest(actual) === digest(receipt);
  }
}
