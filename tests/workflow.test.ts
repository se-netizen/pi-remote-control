import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WorkflowScheduler, WorkerFailure, validateWorkflow, resolveModel, chooseThinkingLevel, MemoryWorkflowStore, FileWorkflowStore, GitWorkspaceManager, type WorkflowTask, type WorkflowPolicy, type WorkerResult, type WorkflowSnapshot, type WorkerRunner } from '../src/workflow/index.js';

const policy: WorkflowPolicy = { scope: ['src/'], tools: ['read', 'edit', 'write'], network: false, maxConcurrency: 2, maxAttempts: 2 };
const task = (id: string, overrides: Partial<WorkflowTask> = {}): WorkflowTask => ({ taskId: id, goal: `Implement ${id}`, scope: [`src/${id}.ts`], acceptanceCriteria: ['Artifact exists'], expectedArtifacts: [`src/${id}.ts`], ...overrides });
const result = (t: WorkflowTask, tokens = 1): WorkerResult => ({ summary: `Implemented ${t.taskId}`, files: t.expectedArtifacts ?? [], artifacts: (t.expectedArtifacts ?? []).map(path => ({ path, sha256: 'a'.repeat(64), size: 10 })), checks: [], acceptanceEvidence: t.acceptanceCriteria.map((_, criterion) => ({ criterion, evidence: 'Artifact verified by injected host runner' })), usage: { tokens, cost: 0 }, verified: true });
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }

test('rejects cycles, unknown dependencies, scope conflict, path traversal, policy escalation and absent evidence criteria', () => {
  const plan = (tasks: WorkflowTask[]) => ({ goal: 'Build project', tasks });
  assert.throws(() => validateWorkflow(plan([task('a', { dependsOn: ['b'] }), task('b', { dependsOn: ['a'] })]), policy), /cycle/);
  assert.throws(() => validateWorkflow(plan([task('a', { dependsOn: ['missing'] })]), policy), /Unknown dependency/);
  assert.throws(() => validateWorkflow(plan([task('a'), task('b', { scope: ['src/a.ts'], expectedArtifacts: ['src/a.ts'] })]), policy), /overlap/);
  assert.throws(() => validateWorkflow(plan([task('a', { scope: ['src/../secret'] })]), policy), /Unsafe scope/);
  assert.throws(() => validateWorkflow(plan([task('a', { scope: ['.env'] })]), policy), /parent file scope/);
  assert.throws(() => validateWorkflow(plan([task('a', { tools: ['bash'] })]), policy), /tool policy/);
  assert.throws(() => validateWorkflow(plan([task('a', { network: true })]), policy), /network policy/);
  assert.throws(() => validateWorkflow(plan([task('a', { checks: [['node', '--version']] })]), policy), /not authorized/);
  assert.throws(() => validateWorkflow(plan([task('a', { acceptanceCriteria: [] })]), policy), /acceptance criteria/);
  assert.throws(() => validateWorkflow(plan([task('a', { role: 'reviewer', tools: ['write'] })]), policy), /read-only/);
  assert.throws(() => validateWorkflow(plan([task('a')]), { ...policy, maxConcurrency: Infinity }), /must be/);
  assert.doesNotThrow(() => validateWorkflow(plan([task('b', { scope: ['src/a.ts'], expectedArtifacts: ['src/a.ts'], dependsOn: ['a'] }), task('a')]), policy));
});

test('role/complexity routing inherits host models and validates effort against model capabilities', () => {
  assert.equal(resolveModel({ role: 'planner' }).desiredThinkingLevel, 'high');
  assert.equal(resolveModel({ complexity: 'simple' }).desiredThinkingLevel, 'low');
  assert.equal(resolveModel({ complexity: 'complex' }).provider, undefined);
  const profiles = { worker: { provider: 'host', model: 'large' }, complexity: { simple: { provider: 'host', model: 'small', thinkingLevel: 'auto' as const } } };
  const models = [{ provider: 'host', id: 'small', reasoning: false }, { provider: 'host', id: 'large', thinkingLevels: ['off', 'low', 'high'] as const }];
  assert.equal(resolveModel({ complexity: 'simple' }, profiles, [models[0]!]).thinkingLevel, 'off');
  assert.equal(resolveModel({ complexity: 'complex' }, profiles).model, 'large');
  assert.throws(() => resolveModel({}, { worker: { provider: 'host' } }), /together/);
  assert.throws(() => resolveModel({}, { worker: { provider: 'host', model: 'small', thinkingLevel: 'high' } }, [models[0]!]), /unsupported/);
  assert.throws(() => resolveModel({}, { worker: { provider: 'missing', model: 'missing' } }, [models[0]!]), /unavailable/);
  assert.equal(chooseThinkingLevel('medium', ['off', 'low', 'high']), 'low');
  assert.equal(resolveModel({}, { worker: { thinkingLevel: 'inherit' } }).thinkingLevel, undefined);
});

test('enforces host concurrency across workflows and releases dependencies only after verified success', async () => {
  const gates = new Map<string, ReturnType<typeof deferred<WorkerResult>>>();
  const starts: string[] = [];
  let active = 0, maximum = 0;
  const scheduler = new WorkflowScheduler({ runner: async ({ task: t }) => {
    starts.push(t.taskId); active++; maximum = Math.max(maximum, active);
    const gate = deferred<WorkerResult>(); gates.set(t.taskId, gate);
    const value = await gate.promise; active--; return value;
  } });
  scheduler.submit({ workflowId: 'first', goal: 'Build', tasks: [task('child', { dependsOn: ['a'] }), task('a'), task('b')] }, policy);
  scheduler.submit({ workflowId: 'second', goal: 'Build more', tasks: [task('other')] }, policy);
  const first = scheduler.start('first'), second = scheduler.start('second');
  await tick(); assert.equal(starts.length, 2); assert.equal(starts.includes('child'), false); assert.equal(maximum, 2);
  gates.get('b')!.resolve(result(task('b'))); await tick();
  assert.equal(starts.includes('other'), true);
  gates.get('a')!.resolve(result(task('a'))); await tick();
  assert.equal(starts.includes('child'), true);
  gates.get('child')!.resolve(result(task('child'))); gates.get('other')!.resolve(result(task('other')));
  assert.equal((await first).status, 'succeeded'); assert.equal((await second).status, 'succeeded'); assert.equal(maximum, 2);
  await scheduler.close();
});

test('refuses unsupported result claims and blocks descendants without retrying possible side effects', async () => {
  let calls = 0;
  const scheduler = new WorkflowScheduler({ runner: async ({ task: t }) => { calls++; return { ...result(t), verified: false }; } });
  const flow = scheduler.submit({ goal: 'Build', tasks: [task('a', { maxAttempts: 2 }), task('child', { dependsOn: ['a'] })] }, policy);
  const ended = await scheduler.start(flow.workflowId);
  assert.equal(calls, 1); assert.equal(ended.status, 'indeterminate');
  assert.equal(ended.tasks.find(t => t.task.taskId === 'child')!.status, 'blocked');
  await scheduler.close();
});

test('only retries classified pre-effect failures within attempt bounds', async () => {
  let calls = 0;
  const scheduler = new WorkflowScheduler({ runner: async ({ task: t }) => { if (++calls === 1) throw new WorkerFailure('Temporary startup failure', 'none', true); return result(t); } });
  const flow = scheduler.submit({ goal: 'Build', tasks: [task('a', { maxAttempts: 2 })] }, policy);
  const ended = await scheduler.start(flow.workflowId);
  assert.equal(ended.status, 'succeeded'); assert.equal(ended.tasks[0]!.attempts.length, 2);
  assert.equal(ended.tasks[0]!.attempts[0]!.status, 'failed');
  await scheduler.close();
});

test('budget reservations precede dispatch and budget exhaustion blocks further work', async () => {
  const gates: Array<ReturnType<typeof deferred<WorkerResult>>> = [];
  let calls = 0;
  const scheduler = new WorkflowScheduler({ runner: async ({ task: t }) => { calls++; const gate = deferred<WorkerResult>(); gates.push(gate); await gate.promise; return result(t, 5); } });
  const tasks = [task('a', { estimatedTokens: 5 }), task('b', { estimatedTokens: 5 }), task('c', { estimatedTokens: 5 })];
  const flow = scheduler.submit({ goal: 'Build', tasks, budget: { maxTokens: 10 } }, policy);
  const done = scheduler.start(flow.workflowId); await tick();
  assert.equal(calls, 2); assert.equal(scheduler.get(flow.workflowId)!.budget.reservedTokens, 10);
  gates.forEach(g => g.resolve(result(task('a'))));
  const ended = await done;
  assert.equal(ended.status, 'failed'); assert.equal(ended.budget.usedTokens, 10); assert.equal(ended.budget.reservedTokens, 0);
  assert.equal(ended.tasks[2]!.status, 'blocked'); assert.equal(calls, 2);
  await scheduler.close();
});

test('cancels queued tasks and bounds uncooperative worker shutdown without claiming rollback', async () => {
  let calls = 0;
  const scheduler = new WorkflowScheduler({ runner: async () => { calls++; return new Promise(() => {}); }, maxHostConcurrency: 1, cancellationGraceMs: 5 });
  const flow = scheduler.submit({ goal: 'Build', tasks: [task('a'), task('b')] }, policy);
  const done = scheduler.start(flow.workflowId); await tick(); scheduler.cancel(flow.workflowId);
  const ended = await done;
  assert.equal(ended.status, 'cancelled'); assert.equal(calls, 1);
  assert.equal(ended.tasks[0]!.status, 'indeterminate'); assert.equal(ended.tasks[1]!.status, 'cancelled');
  await scheduler.close();
});

test('task timeout blocks dependents and never silently dispatches a new attempt', async () => {
  const scheduler = new WorkflowScheduler({ runner: async () => new Promise(() => {}), cancellationGraceMs: 5 });
  const flow = scheduler.submit({ goal: 'Build', tasks: [task('a', { timeoutMs: 5, maxAttempts: 2 }), task('child', { dependsOn: ['a'] })] }, policy);
  const ended = await scheduler.start(flow.workflowId);
  assert.equal(ended.status, 'indeterminate'); assert.equal(ended.tasks[0]!.attempts.length, 1); assert.match(ended.tasks[0]!.error!, /deadline/);
  await scheduler.close();
});

test('recovers persisted in-flight work as indeterminate and does not invoke workers', async () => {
  const store = new MemoryWorkflowStore();
  const seed = new WorkflowScheduler({ runner: async ({ task: t }) => result(t), store });
  const flow = seed.submit({ workflowId: 'restart', goal: 'Build', tasks: [task('a'), task('b', { dependsOn: ['a'] })] }, policy);
  flow.status = 'running'; flow.tasks[0]!.status = 'running'; flow.tasks[0]!.attempts = [{ attemptId: 'old-attempt', number: 1, startedAt: Date.now(), status: 'running' }]; store.save(flow);
  let calls = 0;
  const restored = new WorkflowScheduler({ runner: async ({ task: t }) => { calls++; return result(t); }, store });
  assert.equal(restored.get('restart')!.status, 'indeterminate'); assert.equal(restored.get('restart')!.tasks[0]!.status, 'indeterminate');
  await assert.rejects(() => restored.start('restart'), /no automatic replay/); assert.equal(calls, 0);
  await seed.close(); await restored.close();
});

test('durability failure halts dispatch and resolves outstanding status honestly', async () => {
  const store = new MemoryWorkflowStore(); let saves = 0, calls = 0;
  const originalSave = store.save.bind(store);
  store.save = (snapshot: WorkflowSnapshot) => { if (++saves === 3) throw new Error('Disk full'); originalSave(snapshot); };
  const scheduler = new WorkflowScheduler({ runner: async ({ task: t }) => { calls++; return result(t); }, store });
  const flow = scheduler.submit({ goal: 'Build', tasks: [task('a')] }, policy);
  const ended = await scheduler.start(flow.workflowId);
  assert.equal(ended.status, 'indeterminate'); assert.equal(calls, 0); assert.match(ended.error!, /persistence failed/);
  await scheduler.close();
});

test('file store reloads snapshots and rejects unsupported schema without overwriting it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-workflow-store-'));
  try {
    const store = new FileWorkflowStore(dir);
    const scheduler = new WorkflowScheduler({ store, runner: async ({ task: t }) => result(t) });
    scheduler.submit({ workflowId: 'saved', goal: 'Build', tasks: [task('a')] }, policy);
    assert.equal(new FileWorkflowStore(dir).load()[0]!.workflowId, 'saved');
    const path = join(dir, 'future.json'); await writeFile(path, JSON.stringify({ schemaVersion: 99, snapshot: {} }));
    assert.throws(() => new FileWorkflowStore(dir).load(), /Unsupported/);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).schemaVersion, 99);
    await scheduler.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('Git workspaces preserve dirty user files, collect real patches, and reject out-of-scope outputs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-workflow-git-'));
  const git = promisify(execFile);
  try {
    const repo = join(dir, 'repo'); await mkdir(repo); await git('git', ['init', '-q'], { cwd: repo });
    await writeFile(join(repo, 'README.md'), 'initial\n');
    await git('git', ['add', 'README.md'], { cwd: repo });
    await git('git', ['-c', 'user.name=Test', '-c', 'user.email=test@localhost', 'commit', '-qm', 'Initial'], { cwd: repo });
    await writeFile(join(repo, 'README.md'), 'user dirty work\n');
    await writeFile(join(repo, 'private-untracked.txt'), 'keep me');
    const manager = new GitWorkspaceManager(repo, join(dir, 'workers'));
    const a = await manager.create('flow', 'a');
    assert.equal(await readFile(join(a.path, 'README.md'), 'utf8'), 'initial\n');
    await writeFile(join(a.path, 'README.md'), 'worker update\n');
    const collected = await manager.collect(a, ['README.md'], ['README.md']);
    assert.match(collected.patch, /worker update/); assert.equal(collected.artifacts[0]!.sha256.length, 64);
    assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), 'user dirty work\n'); assert.equal(await readFile(join(repo, 'private-untracked.txt'), 'utf8'), 'keep me');
    const b = await manager.create('flow', 'b', [{ ...result(task('a')), ...collected, baseCommit: a.baseCommit, repositoryCommit: a.repositoryCommit }]);
    assert.equal(await readFile(join(b.path, 'README.md'), 'utf8'), 'worker update\n');
    await writeFile(join(b.path, 'unexpected.txt'), 'outside');
    await assert.rejects(() => manager.collect(b, ['README.md'], []), /outside declared scope/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('an uncooperative cancelled worker retains its host slot until the underlying runner exits', async () => {
  const gate = deferred<WorkerResult>(); let calls = 0;
  const scheduler = new WorkflowScheduler({ runner: async ({ task: t }) => { calls++; return t.taskId === 'old' ? gate.promise : result(t); }, maxHostConcurrency: 1, cancellationGraceMs: 5 });
  scheduler.submit({ workflowId: 'old-flow', goal: 'Old', tasks: [task('old')] }, policy);
  scheduler.submit({ workflowId: 'new-flow', goal: 'New', tasks: [task('new')] }, policy);
  const old = scheduler.start('old-flow'); await tick(); scheduler.cancel('old-flow'); await old;
  const next = scheduler.start('new-flow'); await tick();
  assert.equal(calls, 1, 'cancel must not free a process slot before the worker actually exits');
  gate.resolve(result(task('old')));
  assert.equal((await next).status, 'succeeded'); assert.equal(calls, 2);
  await scheduler.close();
});
