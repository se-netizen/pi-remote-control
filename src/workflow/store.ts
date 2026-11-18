import { mkdirSync, readdirSync, readFileSync, renameSync, openSync, closeSync, writeFileSync, fsyncSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { WorkflowSnapshot, WorkflowStore } from './types.js';

export class MemoryWorkflowStore implements WorkflowStore {
  private values = new Map<string, WorkflowSnapshot>();
  load(): WorkflowSnapshot[] { return [...this.values.values()].map(value => structuredClone(value)); }
  save(snapshot: WorkflowSnapshot): void { this.values.set(snapshot.workflowId, structuredClone(snapshot)); }
}
/** One atomically replaced, fsynced snapshot per workflow; effects interrupted by restart stay indeterminate. */
export class FileWorkflowStore implements WorkflowStore {
  constructor(readonly directory: string) { mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700); }
  load(): WorkflowSnapshot[] {
    return readdirSync(this.directory).filter(name => /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\.json$/.test(name)).sort().map(name => {
      const value = JSON.parse(readFileSync(join(this.directory, name), 'utf8')) as { schemaVersion: number; snapshot: WorkflowSnapshot };
      if (value.schemaVersion !== 1 || !value.snapshot || !Array.isArray(value.snapshot.tasks) || value.snapshot.workflowId !== name.slice(0, -5)) throw new Error(`Unsupported/corrupt workflow state: ${name}`);
      return value.snapshot;
    });
  }
  save(snapshot: WorkflowSnapshot): void {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(snapshot.workflowId)) throw new Error('Unsafe workflowId');
    const destination = join(this.directory, `${snapshot.workflowId}.json`);
    const temporary = join(this.directory, `.${snapshot.workflowId}.${randomUUID()}.tmp`);
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ schemaVersion: 1, snapshot })); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, destination);
    const directoryFd = openSync(this.directory, 'r');
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  }
}
