import { mkdir, open, readFile, readdir, unlink, link } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { verifyArtifact } from './artifact.js';
import type { RunArtifact } from './workbench-types.js';

/** A single local writer, with immutable files and verified reads. */
export class RunStore {
  readonly directory: string;
  private releaseLock?: () => Promise<void>;
  constructor(directory: string) { this.directory = resolve(directory); }
  async lock(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const path = join(this.directory, 'writer.lock');
    let file;
    try { file = await open(path, 'wx', 0o600); }
    catch { throw new Error('Run directory is locked by another writer. Stop that process before starting; after a crash, verify the recorded PID before removing writer.lock.'); }
    await file.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
    await file.sync(); await file.close();
    this.releaseLock = async () => { await unlink(path).catch(() => undefined); };
  }
  async close(): Promise<void> { await this.releaseLock?.(); delete this.releaseLock; }
  private path(id: string): string {
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('Invalid run ID');
    return join(this.directory, `${id}.json`);
  }
  async save(artifact: RunArtifact): Promise<void> {
    const verified = await verifyArtifact(artifact);
    if (!verified.valid) throw new Error(`Invalid artifact: ${verified.errors.join('; ')}`);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.path(artifact.runId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(JSON.stringify(artifact, null, 2) + '\n'); await file.sync(); await file.close();
      await link(temporary, target); // Atomic publication, fails if the immutable target already exists.
    } finally { await file.close().catch(() => undefined); await unlink(temporary).catch(() => undefined); }
  }
  async get(id: string): Promise<RunArtifact> {
    const raw: unknown = JSON.parse(await readFile(this.path(id), 'utf8'));
    const verified = await verifyArtifact(raw);
    if (!verified.valid) throw new Error('Stored run failed integrity verification');
    return raw as RunArtifact;
  }
  async list(): Promise<RunArtifact[]> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const runs: RunArtifact[] = [];
    for (const filename of await readdir(this.directory)) {
      if (!/^[a-zA-Z0-9_-]{1,100}\.json$/.test(filename)) continue;
      runs.push(await this.get(filename.slice(0, -5)));
    }
    return runs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
