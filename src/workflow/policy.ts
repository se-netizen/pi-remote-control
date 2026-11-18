import { posix } from 'node:path';
import type { BuiltinTool, WorkflowPlan, WorkflowPolicy, WorkflowTask } from './types.js';

export class WorkflowValidationError extends Error {
  readonly code = 'invalid_workflow';
  constructor(message: string) { super(message); this.name = 'WorkflowValidationError'; }
}
const fail = (message: string): never => { throw new WorkflowValidationError(message); };
const TOOLS: BuiltinTool[] = ['read', 'grep', 'find', 'ls', 'edit', 'write', 'bash'];
const READ_TOOLS: BuiltinTool[] = ['read', 'grep', 'find', 'ls'];
const ROLES = ['planner', 'worker', 'reviewer', 'integrator'];
const COMPLEXITY = ['simple', 'standard', 'complex'];
const finite = (value: unknown, min: number, max: number, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) fail(`${label} must be between ${min} and ${max}`);
  return value as number;
};
const integer = (value: unknown, min: number, max: number, label: string): number => {
  const n = finite(value, min, max, label);
  if (!Number.isInteger(n)) fail(`${label} must be an integer`);
  return n;
};
function strings(value: unknown, label: string, max = 100): string[] {
  if (!Array.isArray(value) || value.length > max || value.some(x => typeof x !== 'string' || !x.trim() || x.length > 65536)) fail(`${label} must be an array of non-empty strings`);
  return value as string[];
}
function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}
export function normalizeScope(input: string): string {
  if (input === '**' || input === '.' || input === './') return '**';
  if (!input || input.includes('\\') || input.includes('\0') || posix.isAbsolute(input) || input.split('/').includes('..') || /^[A-Za-z]:/.test(input)) fail(`Unsafe scope: ${input}`);
  const prefix = input.replace(/\/\*\*$/, '/');
  if (prefix.includes('*') || prefix.includes('?') || prefix.includes('[')) fail(`Only directory/** scope patterns are supported: ${input}`);
  const directory = prefix.endsWith('/');
  const normalized = posix.normalize(prefix).replace(/^\.\//, '').replace(/\/$/, '');
  if (!normalized || normalized === '.' || normalized.split('/').includes('.git')) fail(`Unsafe scope: ${input}`);
  return normalized + (directory ? '/' : '');
}
export function scopeContains(parent: string, child: string): boolean {
  const p = normalizeScope(parent), c = normalizeScope(child);
  return p === '**' || p === c || (p.endsWith('/') && c.startsWith(p));
}
export function pathInScope(path: string, scope: string[]): boolean {
  if (path === '**' || path.endsWith('/')) return false;
  const normalized = normalizeScope(path);
  return scope.some(parent => scopeContains(parent, normalized));
}
export function effectiveTools(task: WorkflowTask, policy: WorkflowPolicy): BuiltinTool[] {
  return task.tools ?? ((task.role === 'planner' || task.role === 'reviewer') ? policy.tools.filter(tool => READ_TOOLS.includes(tool)) : policy.tools);
}
export function isWritingTask(task: WorkflowTask, policy: WorkflowPolicy): boolean {
  return effectiveTools(task, policy).some(tool => ['edit', 'write', 'bash'].includes(tool));
}
/** Runtime validation is intentionally independent from language-model output and TypeScript types. */
export function validateWorkflow(input: unknown, parentInput: WorkflowPolicy): { plan: WorkflowPlan; policy: WorkflowPolicy } {
  const raw = record(input, 'plan');
  const parent = record(parentInput, 'policy');
  const policy: WorkflowPolicy = {
    scope: strings(parent.scope, 'policy.scope').map(normalizeScope),
    tools: strings(parent.tools, 'policy.tools') as BuiltinTool[],
    network: parent.network === true,
    maxConcurrency: integer(parent.maxConcurrency ?? 2, 1, 32, 'policy.maxConcurrency'),
    maxTasks: integer(parent.maxTasks ?? 100, 1, 1000, 'policy.maxTasks'),
    maxAttempts: integer(parent.maxAttempts ?? 1, 1, 10, 'policy.maxAttempts'),
    maxTaskTimeoutMs: integer(parent.maxTaskTimeoutMs ?? 300_000, 1, 86_400_000, 'policy.maxTaskTimeoutMs'),
    maxDurationMs: integer(parent.maxDurationMs ?? 3_600_000, 1, 604_800_000, 'policy.maxDurationMs'),
    allowChecks: parent.allowChecks === true,
    ...(parent.maxTokens === undefined ? {} : { maxTokens: integer(parent.maxTokens, 1, Number.MAX_SAFE_INTEGER, 'policy.maxTokens') }),
    ...(parent.maxCost === undefined ? {} : { maxCost: finite(parent.maxCost, 0.000001, Number.MAX_SAFE_INTEGER, 'policy.maxCost') }),
  };
  if (!policy.scope.length || policy.tools.some(t => !TOOLS.includes(t))) fail('Parent policy requires a non-empty scope and known tools');
  if (typeof raw.goal !== 'string' || !raw.goal.trim() || raw.goal.length > 65536) fail('plan.goal is required');
  if (raw.workflowId !== undefined && (typeof raw.workflowId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(raw.workflowId))) fail('Invalid workflowId');
  if (!Array.isArray(raw.tasks) || !raw.tasks.length || raw.tasks.length > policy.maxTasks!) fail(`plan.tasks requires 1..${policy.maxTasks} tasks`);
  const tasks: WorkflowTask[] = (raw.tasks as unknown[]).map((value, index): WorkflowTask => {
    const task = record(value, `tasks[${index}]`);
    if (typeof task.taskId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(task.taskId)) fail(`Invalid taskId at ${index}`);
    const id = task.taskId as string;
    if (typeof task.goal !== 'string' || !task.goal.trim() || task.goal.length > 65536) fail(`Task ${id} needs a goal`);
    const scope = strings(task.scope, `${id}.scope`).map(normalizeScope);
    if (!scope.length || scope.some(s => !policy.scope.some(p => scopeContains(p, s)))) fail(`Task ${id} exceeds parent file scope`);
    const acceptanceCriteria = strings(task.acceptanceCriteria, `${id}.acceptanceCriteria`);
    if (!acceptanceCriteria.length) fail(`Task ${id} needs acceptance criteria`);
    const role = task.role ?? 'worker', complexity = task.complexity ?? 'standard';
    if (!ROLES.includes(role as string) || !COMPLEXITY.includes(complexity as string)) fail(`Task ${id} has an invalid role or complexity`);
    if (task.network !== undefined && typeof task.network !== 'boolean') fail(`Task ${id}.network must be boolean`);
    if (task.network === true && !policy.network) fail(`Task ${id} exceeds parent network policy`);
    const tools = task.tools === undefined ? undefined : strings(task.tools, `${id}.tools`) as BuiltinTool[];
    if (tools?.some(t => !TOOLS.includes(t) || !policy.tools.includes(t))) fail(`Task ${id} exceeds parent tool policy`);
    if ((role === 'planner' || role === 'reviewer') && tools?.some(t => !READ_TOOLS.includes(t))) fail(`${role} ${id} must use read-only tools; host checks require separate approval`);
    const expectedArtifacts = task.expectedArtifacts === undefined ? [] : strings(task.expectedArtifacts, `${id}.expectedArtifacts`);
    if (expectedArtifacts.some(p => !pathInScope(p, scope))) fail(`Task ${id} expects artifacts outside scope`);
    let checks: string[][] = [];
    if (task.checks !== undefined) {
      if (!policy.allowChecks || !Array.isArray(task.checks)) fail(`Host checks are not authorized for ${id}`);
      checks = (task.checks as unknown[]).map((check, n) => {
        const args = strings(check, `${id}.checks[${n}]`, 100);
        if (!args.length) fail('Empty check command');
        return args;
      });
    }
    const result: WorkflowTask = {
      taskId: id, goal: task.goal as string, role: role as WorkflowTask['role'], complexity: complexity as WorkflowTask['complexity'],
      scope, acceptanceCriteria, expectedArtifacts, checks,
      dependsOn: task.dependsOn === undefined ? [] : strings(task.dependsOn, `${id}.dependsOn`),
      timeoutMs: integer(task.timeoutMs ?? policy.maxTaskTimeoutMs, 1, policy.maxTaskTimeoutMs!, `${id}.timeoutMs`),
      maxAttempts: integer(task.maxAttempts ?? 1, 1, policy.maxAttempts!, `${id}.maxAttempts`),
      network: task.network === undefined ? policy.network : task.network as boolean,
      ...(tools ? { tools } : {}),
      ...(task.estimatedTokens === undefined ? {} : { estimatedTokens: integer(task.estimatedTokens, 1, Number.MAX_SAFE_INTEGER, `${id}.estimatedTokens`) }),
      ...(task.estimatedCost === undefined ? {} : { estimatedCost: finite(task.estimatedCost, 0.000001, Number.MAX_SAFE_INTEGER, `${id}.estimatedCost`) }),
    };
    return result;
  });
  const byId = new Map(tasks.map(t => [t.taskId, t]));
  if (byId.size !== tasks.length) fail('Duplicate taskId');
  const ancestors = new Map<string, Set<string>>();
  const visiting = new Set<string>();
  function visit(id: string): Set<string> {
    if (visiting.has(id)) fail(`Dependency cycle at ${id}`);
    if (ancestors.has(id)) return ancestors.get(id)!;
    const task = byId.get(id)!;
    const dependencies = task.dependsOn!;
    if (new Set(dependencies).size !== dependencies.length) fail(`Duplicate dependency on ${id}`);
    visiting.add(id);
    const all = new Set<string>();
    for (const dependency of dependencies) {
      if (!byId.has(dependency)) fail(`Unknown dependency ${dependency} on ${id}`);
      all.add(dependency);
      for (const ancestor of visit(dependency)) all.add(ancestor);
    }
    visiting.delete(id); ancestors.set(id, all); return all;
  }
  for (const task of tasks) visit(task.taskId);
  for (let i = 0; i < tasks.length; i++) for (let j = i + 1; j < tasks.length; j++) {
    const a = tasks[i]!, b = tasks[j]!;
    if (!isWritingTask(a, policy) || !isWritingTask(b, policy)) continue;
    if (a.scope.some(x => b.scope.some(y => scopeContains(x, y) || scopeContains(y, x))) && !ancestors.get(a.taskId)!.has(b.taskId) && !ancestors.get(b.taskId)!.has(a.taskId)) fail(`Unordered write scopes overlap: ${a.taskId} and ${b.taskId}`);
  }
  tasks.sort((a, b) => ancestors.get(a.taskId)!.size - ancestors.get(b.taskId)!.size);
  const budgetRaw = raw.budget === undefined ? {} : record(raw.budget, 'budget');
  const maxTokens = budgetRaw.maxTokens === undefined ? policy.maxTokens : integer(budgetRaw.maxTokens, 1, policy.maxTokens ?? Number.MAX_SAFE_INTEGER, 'budget.maxTokens');
  const maxCost = budgetRaw.maxCost === undefined ? policy.maxCost : finite(budgetRaw.maxCost, 0.000001, policy.maxCost ?? Number.MAX_SAFE_INTEGER, 'budget.maxCost');
  if (maxTokens !== undefined && tasks.some(t => t.estimatedTokens === undefined)) fail('Token-budgeted tasks require estimatedTokens reservations');
  if (maxCost !== undefined && tasks.some(t => t.estimatedCost === undefined)) fail('Cost-budgeted tasks require estimatedCost reservations');
  const plan: WorkflowPlan = { goal: raw.goal as string, tasks, maxConcurrency: integer(raw.maxConcurrency ?? Math.min(2, policy.maxConcurrency!), 1, policy.maxConcurrency!, 'maxConcurrency'), budget: { ...(maxTokens === undefined ? {} : { maxTokens }), ...(maxCost === undefined ? {} : { maxCost }) } };
  if (raw.workflowId !== undefined) plan.workflowId = raw.workflowId as string;
  if (raw.deadline !== undefined) plan.deadline = integer(raw.deadline, 1, Number.MAX_SAFE_INTEGER, 'deadline');
  return { plan, policy };
}
