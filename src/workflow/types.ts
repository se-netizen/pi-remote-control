export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = typeof THINKING_LEVELS[number];
export type TaskRole = 'planner' | 'worker' | 'reviewer' | 'integrator';
export type TaskComplexity = 'simple' | 'standard' | 'complex';
export type TaskState = 'proposed' | 'ready' | 'running' | 'reviewing' | 'succeeded' | 'failed' | 'cancelled' | 'indeterminate' | 'blocked';
export type WorkflowState = 'proposed' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'indeterminate';
export type BuiltinTool = 'read' | 'grep' | 'find' | 'ls' | 'edit' | 'write' | 'bash';

export interface ModelProfile {
  /** Omit provider/model together to inherit the Pi host's configured model. */
  provider?: string;
  model?: string;
  /** auto chooses effort per role/complexity from supported levels; inherit preserves Pi's setting. */
  thinkingLevel?: ThinkingLevel | 'auto' | 'inherit';
}
export interface ModelProfiles {
  planner?: ModelProfile;
  worker?: ModelProfile;
  reviewer?: ModelProfile;
  integrator?: ModelProfile;
  complexity?: Partial<Record<TaskComplexity, ModelProfile>>;
}
export interface AvailableModel {
  provider: string;
  id: string;
  reasoning?: boolean;
  thinkingLevels?: readonly ThinkingLevel[];
}
export interface ResolvedModel extends ModelProfile {
  desiredThinkingLevel: ThinkingLevel;
  thinkingSource: 'explicit' | 'auto' | 'inherit';
}
export interface WorkflowTask {
  taskId: string;
  goal: string;
  dependsOn?: string[];
  role?: TaskRole;
  complexity?: TaskComplexity;
  /** Relative file paths or directory prefixes (src/, src/**). '**' grants the repository. */
  scope: string[];
  acceptanceCriteria: string[];
  expectedArtifacts?: string[];
  /** Commands executed by the host after the worker exits, never accepted from worker output. */
  checks?: string[][];
  timeoutMs?: number;
  maxAttempts?: number;
  /** Estimated reservation. If a token budget is set this is required on every task. */
  estimatedTokens?: number;
  estimatedCost?: number;
  tools?: BuiltinTool[];
  network?: boolean;
}
export interface WorkflowPlan {
  workflowId?: string;
  goal: string;
  tasks: WorkflowTask[];
  maxConcurrency?: number;
  /** Absolute Unix milliseconds; scheduler also enforces policy.maxDurationMs. */
  deadline?: number;
  budget?: { maxTokens?: number; maxCost?: number };
}
export interface WorkflowPolicy {
  scope: string[];
  tools: BuiltinTool[];
  network: boolean;
  maxConcurrency?: number;
  maxTasks?: number;
  maxAttempts?: number;
  maxTaskTimeoutMs?: number;
  maxDurationMs?: number;
  maxTokens?: number;
  maxCost?: number;
  /** Trusted host permission; proposed checks cannot enable themselves. */
  allowChecks?: boolean;
}
export interface CheckResult { command: string[]; exitCode: number; output?: string }
export interface TaskArtifact { path: string; sha256: string; size: number }
export interface WorkerResult {
  summary: string;
  files: string[];
  artifacts: TaskArtifact[];
  checks: CheckResult[];
  /** Indices (0-based) of acceptance criteria with independently collected evidence. */
  acceptanceEvidence: Array<{ criterion: number; evidence: string }>;
  patch?: string;
  baseCommit?: string;
  repositoryCommit?: string;
  appliedModel?: { provider: string; model: string; thinkingLevel?: ThinkingLevel };
  workspace?: string;
  sessionId?: string;
  risks?: string[];
  usage?: { tokens?: number; cost?: number };
  /** Set by trusted runner, never by the language model's response. */
  verified: boolean;
}
export interface TaskAttempt {
  attemptId: string;
  number: number;
  startedAt: number;
  endedAt?: number;
  status: TaskState;
  error?: string;
}
export interface TaskSnapshot {
  task: WorkflowTask;
  status: TaskState;
  attempts: TaskAttempt[];
  model: ResolvedModel;
  result?: WorkerResult;
  error?: string;
}
export interface WorkflowSnapshot {
  workflowId: string;
  goal: string;
  status: WorkflowState;
  createdAt: number;
  updatedAt: number;
  deadline: number;
  maxConcurrency: number;
  policy: WorkflowPolicy;
  budget: { maxTokens?: number; maxCost?: number; reservedTokens: number; reservedCost: number; usedTokens: number; usedCost: number; telemetryComplete: boolean };
  tasks: TaskSnapshot[];
  error?: string;
}
export interface WorkerContext {
  workflowId: string;
  attemptId: string;
  task: WorkflowTask;
  model: ResolvedModel;
  policy: WorkflowPolicy;
  /** All transitive dependency results in topological order, for preparing a derived worktree. */
  dependencies: WorkerResult[];
  signal: AbortSignal;
}
export type WorkerRunner = (context: WorkerContext) => Promise<WorkerResult>;
export interface WorkflowStore {
  load(): WorkflowSnapshot[];
  save(snapshot: WorkflowSnapshot): void;
}
