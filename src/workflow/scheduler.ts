import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { validateWorkflow, WorkflowValidationError, pathInScope } from './policy.js';
import { resolveModel } from './models.js';
import { MemoryWorkflowStore } from './store.js';
import type { AvailableModel, ModelProfiles, TaskSnapshot, WorkerResult, WorkerRunner, WorkflowPolicy, WorkflowSnapshot, WorkflowStore } from './types.js';

export class WorkerFailure extends Error {
  constructor(message: string, readonly sideEffects: 'none' | 'possible' = 'possible', readonly retryable = false) { super(message); this.name = 'WorkerFailure'; }
}
const terminalTask = (task: TaskSnapshot): boolean => ['succeeded', 'failed', 'cancelled', 'indeterminate', 'blocked'].includes(task.status);
const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
interface SchedulerOptions {
  runner: WorkerRunner;
  store?: WorkflowStore;
  profiles?: ModelProfiles;
  models?: AvailableModel[];
  now?: () => number;
  maxHostConcurrency?: number;
  cancellationGraceMs?: number;
}
interface ActiveTask { controller: AbortController; workflowId: string; taskId: string }
/** Host-level deterministic scheduler: models produce results but cannot grant tools, spawn slots, or budgets. */
export class WorkflowScheduler extends EventEmitter {
  private snapshots = new Map<string, WorkflowSnapshot>();
  private running = new Map<string, ActiveTask>();
  private quarantined = new Set<string>();
  private deadlines = new Map<string, ReturnType<typeof setTimeout>>();
  private waiters = new Map<string, Array<(value: WorkflowSnapshot) => void>>();
  private pumping = false;
  private stopped = false;
  private healthError?: Error;
  private readonly store: WorkflowStore;
  private readonly now: () => number;
  private readonly hostConcurrency: number;
  private readonly cancellationGraceMs: number;
  constructor(private readonly options: SchedulerOptions) {
    super();
    this.store = options.store ?? new MemoryWorkflowStore();
    this.now = options.now ?? Date.now;
    this.hostConcurrency = options.maxHostConcurrency ?? 2;
    this.cancellationGraceMs = options.cancellationGraceMs ?? 2_000;
    if (!Number.isInteger(this.hostConcurrency) || this.hostConcurrency < 1 || this.hostConcurrency > 32) throw new WorkflowValidationError('Invalid maxHostConcurrency');
    for (const value of this.store.load()) {
      const snapshot = structuredClone(value);
      if (snapshot.status === 'running') {
        snapshot.status = 'indeterminate'; snapshot.error = 'Scheduler restarted; reconcile worker effects before starting another attempt'; snapshot.updatedAt = this.now();
        for (const task of snapshot.tasks) {
          if (['running', 'reviewing'].includes(task.status)) {
            task.status = 'indeterminate'; task.error = snapshot.error;
            const attempt = task.attempts.at(-1); if (attempt) { attempt.status = 'indeterminate'; attempt.endedAt = this.now(); attempt.error = snapshot.error; }
          } else if (!terminalTask(task)) { task.status = 'blocked'; task.error = 'Workflow requires reconciliation after restart'; }
        }
        this.store.save(snapshot);
      }
      this.snapshots.set(snapshot.workflowId, snapshot);
    }
  }
  submit(planInput: unknown, policyInput: WorkflowPolicy): WorkflowSnapshot {
    this.assertHealthy();
    const { plan, policy } = validateWorkflow(planInput, policyInput);
    const workflowId = plan.workflowId ?? randomUUID();
    if (this.snapshots.has(workflowId)) throw new WorkflowValidationError(`Workflow already exists: ${workflowId}`);
    const now = this.now();
    const deadline = Math.min(plan.deadline ?? Number.MAX_SAFE_INTEGER, now + policy.maxDurationMs!);
    if (deadline <= now) throw new WorkflowValidationError('Workflow deadline has expired');
    const snapshot: WorkflowSnapshot = {
      workflowId, goal: plan.goal, status: 'proposed', createdAt: now, updatedAt: now, deadline,
      maxConcurrency: plan.maxConcurrency!, policy,
      budget: { ...plan.budget, reservedTokens: 0, reservedCost: 0, usedTokens: 0, usedCost: 0, telemetryComplete: true },
      tasks: plan.tasks.map(task => ({ task, status: 'proposed', attempts: [], model: resolveModel(task, this.options.profiles, this.options.models) })),
    };
    this.commit(snapshot); this.snapshots.set(workflowId, snapshot);
    return structuredClone(snapshot);
  }
  get(workflowId: string): WorkflowSnapshot | undefined { const value = this.snapshots.get(workflowId); return value && structuredClone(value); }
  list(): WorkflowSnapshot[] { return [...this.snapshots.values()].map(value => structuredClone(value)); }
  hasActiveWorkers(): boolean { return this.running.size + this.quarantined.size > 0; }
  async start(workflowId: string): Promise<WorkflowSnapshot> {
    this.assertHealthy();
    const snapshot = this.required(workflowId);
    if (snapshot.status !== 'proposed') throw new WorkflowValidationError(`Workflow ${workflowId} is ${snapshot.status}; no automatic replay or retry`);
    snapshot.status = 'running';
    this.commit(snapshot);
    const completion = new Promise<WorkflowSnapshot>(resolve => this.waiters.set(workflowId, [...(this.waiters.get(workflowId) ?? []), resolve]));
    const remaining = snapshot.deadline - this.now();
    if (remaining <= 0) this.expire(snapshot);
    else {
      this.deadlines.set(workflowId, setTimeout(() => { this.expire(snapshot); this.pump(); }, Math.min(remaining, 2_147_483_647)));
      this.pump();
    }
    return completion;
  }
  cancel(workflowId: string): WorkflowSnapshot {
    const snapshot = this.required(workflowId);
    if (['succeeded', 'failed', 'cancelled', 'indeterminate'].includes(snapshot.status)) return structuredClone(snapshot);
    snapshot.status = 'cancelled'; snapshot.error = 'Cancelled by owner; completed external effects are retained';
    for (const task of snapshot.tasks) if (!terminalTask(task) && !['running', 'reviewing'].includes(task.status)) { task.status = 'cancelled'; task.error = snapshot.error; }
    for (const active of this.running.values()) if (active.workflowId === workflowId) active.controller.abort(new WorkerFailure('Workflow cancelled; effects may already have occurred', 'possible'));
    this.commit(snapshot); this.finish(snapshot); this.pump();
    return structuredClone(snapshot);
  }
  /** Stop scheduling and request cooperative cancellation; owned process cleanup belongs to the runner. */
  async close(): Promise<void> {
    this.stopped = true;
    for (const snapshot of this.snapshots.values()) if (snapshot.status === 'running') this.cancel(snapshot.workflowId);
    for (const deadline of this.deadlines.values()) clearTimeout(deadline);
    this.deadlines.clear();
    if (!this.running.size) return;
    await new Promise<void>(resolve => {
      const listener = () => { if (!this.running.size) { this.off('change', listener); clearTimeout(timer); resolve(); } };
      const timer = setTimeout(() => { this.off('change', listener); resolve(); }, this.cancellationGraceMs + 100);
      this.on('change', listener);
    });
  }
  private assertHealthy(): void { if (this.healthError) throw this.healthError; if (this.stopped) throw new Error('Scheduler is closed'); }
  private required(id: string): WorkflowSnapshot { const snapshot = this.snapshots.get(id); if (!snapshot) throw new WorkflowValidationError(`Unknown workflow ${id}`); return snapshot; }
  private commit(snapshot: WorkflowSnapshot): void {
    snapshot.updatedAt = this.now();
    try { this.store.save(snapshot); }
    catch (error) {
      this.healthError = new Error(`Workflow persistence failed; dispatch halted: ${errorMessage(error)}`);
      for (const active of this.running.values()) active.controller.abort(this.healthError);
      // With durability unavailable, report uncertainty in memory and unblock API callers; never dispatch more work.
      for (const current of [snapshot, ...this.snapshots.values()]) {
        if (!['running', 'proposed'].includes(current.status)) continue;
        current.status = 'indeterminate'; current.error = this.healthError.message;
        for (const task of current.tasks) if (!terminalTask(task)) { task.status = ['running', 'reviewing'].includes(task.status) ? 'indeterminate' : 'blocked'; task.error = this.healthError.message; }
        const timer = this.deadlines.get(current.workflowId); if (timer) clearTimeout(timer); this.deadlines.delete(current.workflowId);
        for (const resolve of this.waiters.get(current.workflowId) ?? []) resolve(structuredClone(current));
        this.waiters.delete(current.workflowId);
        this.emit('change', structuredClone(current));
      }
      throw this.healthError;
    }
    this.emit('change', structuredClone(snapshot));
  }
  private expire(snapshot: WorkflowSnapshot): void {
    if (snapshot.status !== 'running') return;
    snapshot.error = 'Workflow deadline exhausted';
    for (const task of snapshot.tasks) if (!terminalTask(task) && !['running', 'reviewing'].includes(task.status)) { task.status = 'blocked'; task.error = snapshot.error; }
    for (const active of this.running.values()) if (active.workflowId === snapshot.workflowId) active.controller.abort(new WorkerFailure('Workflow deadline exhausted', 'possible'));
    this.commit(snapshot); this.finish(snapshot);
  }
  private pump(): void {
    if (this.pumping || this.healthError) return;
    this.pumping = true;
    try {
      for (const snapshot of this.snapshots.values()) {
        if (snapshot.status !== 'running') continue;
        if (this.now() >= snapshot.deadline) { this.expire(snapshot); continue; }
        for (const task of snapshot.tasks) {
          if (!['proposed', 'ready'].includes(task.status)) continue;
          const dependencies = task.task.dependsOn!.map(id => snapshot.tasks.find(candidate => candidate.task.taskId === id)!);
          if (dependencies.some(parent => ['failed', 'cancelled', 'indeterminate', 'blocked'].includes(parent.status))) { task.status = 'blocked'; task.error = 'Dependency did not succeed'; this.commit(snapshot); continue; }
          if (!dependencies.every(parent => parent.status === 'succeeded')) continue;
          task.status = 'ready';
          if (this.stopped || this.running.size + this.quarantined.size >= this.hostConcurrency || [...this.running.values()].filter(active => active.workflowId === snapshot.workflowId).length >= snapshot.maxConcurrency) continue;
          if (snapshot.tasks.some(t => t.status === 'indeterminate')) { task.status = 'blocked'; task.error = 'Uncertain worker effects require reconciliation'; this.commit(snapshot); continue; }
          const tokens = task.task.estimatedTokens ?? 0, cost = task.task.estimatedCost ?? 0;
          if ((snapshot.budget.maxTokens !== undefined && snapshot.budget.usedTokens + snapshot.budget.reservedTokens + tokens > snapshot.budget.maxTokens) || (snapshot.budget.maxCost !== undefined && snapshot.budget.usedCost + snapshot.budget.reservedCost + cost > snapshot.budget.maxCost)) { if (snapshot.budget.reservedTokens || snapshot.budget.reservedCost) continue; task.status = 'blocked'; task.error = 'Workflow budget exhausted'; this.commit(snapshot); continue; }
          snapshot.budget.reservedTokens += tokens; snapshot.budget.reservedCost += cost;
          const attemptId = randomUUID(), controller = new AbortController();
          task.status = 'running'; task.attempts.push({ attemptId, number: task.attempts.length + 1, startedAt: this.now(), status: 'running' });
          this.commit(snapshot); // durable reservation + running state precede every worker invocation
          this.running.set(attemptId, { controller, workflowId: snapshot.workflowId, taskId: task.task.taskId });
          void this.execute(snapshot, task, controller, attemptId);
        }
        this.finish(snapshot);
      }
    } catch (error) {
      this.healthError ??= error instanceof Error ? error : new Error(String(error));
      this.emit('scheduler_error', this.healthError);
    } finally { this.pumping = false; }
  }
  private async execute(snapshot: WorkflowSnapshot, task: TaskSnapshot, controller: AbortController, attemptId: string): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let abortDeadline: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    let failure: unknown;
    let workerSettled = false;
    try {
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => { abortDeadline = setTimeout(() => reject(controller.signal.reason ?? new WorkerFailure('Worker did not stop after cancellation', 'possible')), this.cancellationGraceMs); };
        controller.signal.addEventListener('abort', onAbort, { once: true });
      });
      timeout = setTimeout(() => controller.abort(new WorkerFailure('Task deadline exhausted; effects may have occurred', 'possible')), task.task.timeoutMs!);
      const workerPromise = Promise.resolve().then(() => { if (controller.signal.aborted) throw new WorkerFailure('Cancelled before worker dispatch', 'none'); return this.options.runner({ workflowId: snapshot.workflowId, attemptId, task: structuredClone(task.task), model: structuredClone(task.model), policy: structuredClone(snapshot.policy), dependencies: this.dependencyResults(snapshot, task), signal: controller.signal }); });
      const settled = () => { workerSettled = true; if (this.quarantined.delete(attemptId)) this.pump(); };
      void workerPromise.then(settled, settled);
      const result = await Promise.race([workerPromise, aborted]);
      if (controller.signal.aborted) throw controller.signal.reason;
      this.validateResult(task, result);
      task.result = structuredClone(result);
      if (result.appliedModel) task.model = { ...task.model, ...result.appliedModel };
      task.status = 'succeeded';
      if (result.usage?.tokens === undefined || result.usage?.cost === undefined) snapshot.budget.telemetryComplete = false;
      snapshot.budget.usedTokens += result.usage?.tokens ?? task.task.estimatedTokens ?? 0;
      snapshot.budget.usedCost += result.usage?.cost ?? task.task.estimatedCost ?? 0;
    } catch (error) {
      failure = error;
      const safeFailure = error instanceof WorkerFailure && error.sideEffects === 'none';
      task.error = errorMessage(error);
      if (snapshot.status === 'cancelled' && safeFailure) task.status = 'cancelled';
      else task.status = safeFailure ? 'failed' : 'indeterminate';
      snapshot.budget.telemetryComplete = false;
      // A failed/uncertain attempt can consume its full reservation; never refund an unobserved model bill.
      snapshot.budget.usedTokens += task.task.estimatedTokens ?? 0;
      snapshot.budget.usedCost += task.task.estimatedCost ?? 0;
    } finally {
      if (timeout) clearTimeout(timeout);
      if (abortDeadline) clearTimeout(abortDeadline);
      if (onAbort) controller.signal.removeEventListener('abort', onAbort);
      if (!workerSettled) this.quarantined.add(attemptId); // Occupied host slot remains reserved until an uncooperative runner actually exits.
      this.running.delete(attemptId);
      snapshot.budget.reservedTokens -= task.task.estimatedTokens ?? 0;
      snapshot.budget.reservedCost -= task.task.estimatedCost ?? 0;
      const attempt = task.attempts.at(-1)!; attempt.status = task.status; attempt.endedAt = this.now(); if (task.error) attempt.error = task.error;
      if (failure instanceof WorkerFailure && failure.sideEffects === 'none' && failure.retryable && snapshot.status === 'running' && task.attempts.length < task.task.maxAttempts! && !controller.signal.aborted) { task.status = 'ready'; delete task.error; }
      try { this.commit(snapshot); this.finish(snapshot); this.pump(); }
      catch (error) { this.emit('scheduler_error', error); }
    }
  }
  private dependencyResults(snapshot: WorkflowSnapshot, target: TaskSnapshot): WorkerResult[] {
    const ids = new Set<string>();
    const visit = (task: TaskSnapshot) => { for (const id of task.task.dependsOn!) { if (ids.has(id)) continue; const dependency = snapshot.tasks.find(t => t.task.taskId === id)!; visit(dependency); ids.add(id); } };
    visit(target);
    return [...ids].map(id => snapshot.tasks.find(t => t.task.taskId === id)!.result!);
  }
  private validateResult(task: TaskSnapshot, value: WorkerResult): void {
    if (!value || value.verified !== true || typeof value.summary !== 'string' || !value.summary.trim() || !Array.isArray(value.files) || !Array.isArray(value.artifacts) || !Array.isArray(value.checks) || !Array.isArray(value.acceptanceEvidence)) throw new WorkerFailure('Runner did not provide verified result and evidence', 'possible');
    if (value.files.some(file => !pathInScope(file, task.task.scope))) throw new WorkerFailure('Worker changed files outside task scope', 'possible');
    for (const artifact of value.artifacts) if (!pathInScope(artifact.path, task.task.scope) || !/^[a-f0-9]{64}$/.test(artifact.sha256) || !Number.isInteger(artifact.size) || artifact.size < 0) throw new WorkerFailure('Invalid artifact evidence', 'possible');
    for (const artifact of task.task.expectedArtifacts!) if (!value.artifacts.some(a => a.path === artifact)) throw new WorkerFailure(`Expected artifact missing: ${artifact}`, 'possible');
    for (const command of task.task.checks!) if (!value.checks.some(check => JSON.stringify(check.command) === JSON.stringify(command) && check.exitCode === 0)) throw new WorkerFailure(`Required check failed or missing: ${command.join(' ')}`, 'possible');
    if (value.checks.some(check => check.exitCode !== 0)) throw new WorkerFailure('Host verification checks failed', 'possible');
    for (let i = 0; i < task.task.acceptanceCriteria.length; i++) if (!value.acceptanceEvidence.some(e => e.criterion === i && typeof e.evidence === 'string' && e.evidence.trim())) throw new WorkerFailure(`Acceptance criterion ${i + 1} lacks independently collected evidence`, 'possible');
    for (const number of [value.usage?.tokens, value.usage?.cost]) if (number !== undefined && (!Number.isFinite(number) || number < 0)) throw new WorkerFailure('Invalid usage telemetry', 'possible');
  }
  private finish(snapshot: WorkflowSnapshot): void {
    if ([...this.running.values()].some(active => active.workflowId === snapshot.workflowId)) return;
    if (snapshot.status === 'running' && snapshot.tasks.every(terminalTask)) {
      snapshot.status = snapshot.tasks.some(t => t.status === 'indeterminate') ? 'indeterminate' : snapshot.tasks.every(t => t.status === 'succeeded') ? 'succeeded' : 'failed';
      this.commit(snapshot);
    }
    if (snapshot.status !== 'running' && snapshot.status !== 'proposed') {
      const timer = this.deadlines.get(snapshot.workflowId); if (timer) clearTimeout(timer); this.deadlines.delete(snapshot.workflowId);
      for (const resolve of this.waiters.get(snapshot.workflowId) ?? []) resolve(structuredClone(snapshot));
      this.waiters.delete(snapshot.workflowId);
    }
  }
}
