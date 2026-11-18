import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, realpath, lstat, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { pathInScope } from './policy.js';
import { WorkerFailure } from './scheduler.js';
import type { TaskArtifact, WorkerResult } from './types.js';

const execFileAsync = promisify(execFile);
export interface GitWorkspace { path: string; branch: string; baseCommit: string; repositoryCommit: string }
export class GitWorkspaceManager {
  constructor(readonly workspaceRoot: string, readonly stateDir: string) {}
  private async git(cwd: string, args: string[]): Promise<string> {
    const result = await execFileAsync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
    return result.stdout;
  }
  async create(workflowId: string, taskId: string, dependencies: WorkerResult[] = []): Promise<GitWorkspace> {
    let root: string, commit: string;
    try {
      root = await realpath(this.workspaceRoot);
      const topLevel = (await this.git(root, ['rev-parse', '--show-toplevel'])).trim();
      if (await realpath(topLevel) !== root) throw new Error('Configured workspace must be the Git repository root');
      commit = (await this.git(root, ['rev-parse', 'HEAD'])).trim();
    } catch (error) { throw new WorkerFailure(`Managed tasks require an existing Git repository with a commit: ${error instanceof Error ? error.message : error}`, 'none'); }
    await mkdir(this.stateDir, { recursive: true, mode: 0o700 });
    const uuid = randomUUID();
    const path = resolve(this.stateDir, uuid);
    const branch = `pi-remote/${workflowId}/${taskId}/${uuid}`;
    try {
      await this.git(root, ['worktree', 'add', '-b', branch, path, commit]);
      for (const dependency of dependencies) {
        if (!dependency.patch) continue;
        if (dependency.repositoryCommit && dependency.repositoryCommit !== commit) throw new Error('Dependency repository base changed; reconcile before integration');
        await this.applyPatch(path, dependency.patch);
      }
      if (dependencies.some(dependency => dependency.patch)) {
        await this.git(path, ['add', '--all', '--', '.']);
        await this.git(path, ['-c', 'user.name=Pi Remote Control', '-c', 'user.email=pi-remote@localhost', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', `Prepare approved dependency artifacts for ${taskId}`]);
      }
      const baseCommit = (await this.git(path, ['rev-parse', 'HEAD'])).trim();
      return { path, branch, baseCommit, repositoryCommit: commit };
    } catch (error) { throw new WorkerFailure(`Cannot prepare isolated task workspace; preserved ${path}: ${error instanceof Error ? error.message : error}`, 'none'); }
  }
  private async applyPatch(cwd: string, patch: string): Promise<void> {
    if (Buffer.byteLength(patch, 'utf8') > 8 * 1024 * 1024) throw new Error('Dependency patch exceeds 8 MiB');
    // argv never contains patch text; Git validates paths and applies only inside this newly created worktree.
    await new Promise<void>((resolvePromise, reject) => {
      const child = import('node:child_process').then(({ spawn }) => {
        const process = spawn('git', ['-c', 'core.hooksPath=/dev/null', 'apply', '--index', '--whitespace=nowarn', '-'], { cwd, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
        let diagnostic = '';
        process.stdout.resume(); process.stderr.on('data', data => { diagnostic = (diagnostic + String(data)).slice(-4096); });
        process.on('error', reject); process.stdin.on('error', reject);
        process.on('close', code => code === 0 ? resolvePromise() : reject(new Error(`Dependency patch conflict (${code}): ${diagnostic}`)));
        process.stdin.end(patch);
      });
      void child.catch(reject);
    });
  }
  async collect(workspace: GitWorkspace, scope: string[], expectedArtifacts: string[]): Promise<{ files: string[]; artifacts: TaskArtifact[]; patch: string }> {
    const head = (await this.git(workspace.path, ['rev-parse', 'HEAD'])).trim();
    if (head !== workspace.baseCommit) throw new WorkerFailure('Worker changed its Git base; review preserved branch before integration', 'possible');
    const changed = (await this.git(workspace.path, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', workspace.baseCommit])).split('\0').filter(Boolean);
    const untracked = (await this.git(workspace.path, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
    const files = [...new Set([...changed, ...untracked])].sort();
    if (files.some(path => !pathInScope(path, scope))) throw new WorkerFailure('Worker changed files outside declared scope; workspace preserved for review', 'possible');
    const artifacts: TaskArtifact[] = [];
    const root = await realpath(workspace.path);
    for (const path of [...new Set([...files, ...expectedArtifacts])].sort()) {
      if (!pathInScope(path, scope)) throw new WorkerFailure(`Artifact outside approved scope: ${path}`, 'possible');
      const absolute = resolve(root, path);
      let stat;
      try { stat = await lstat(absolute); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !expectedArtifacts.includes(path)) continue; throw new WorkerFailure(`Expected artifact unavailable: ${path}`, 'possible'); }
      if (!stat.isFile() || stat.isSymbolicLink()) throw new WorkerFailure(`Artifact must be a regular file: ${path}`, 'possible');
      const physical = await realpath(absolute);
      if (!physical.startsWith(root + sep)) throw new WorkerFailure(`Artifact escaped task workspace: ${path}`, 'possible');
      if (stat.size > 8 * 1024 * 1024) throw new WorkerFailure(`Artifact too large (8 MiB maximum): ${path}`, 'possible');
      artifacts.push({ path, sha256: createHash('sha256').update(await readFile(physical)).digest('hex'), size: stat.size });
    }
    // Intent-to-add makes new files visible to the patch without committing worker edits.
    if (untracked.length) await this.git(workspace.path, ['add', '--intent-to-add', '--', ...untracked]);
    const patch = await this.git(workspace.path, ['diff', '--binary', '--no-ext-diff', '--no-textconv', workspace.baseCommit]);
    if (Buffer.byteLength(patch, 'utf8') > 8 * 1024 * 1024) throw new WorkerFailure('Worker patch exceeds 8 MiB; workspace preserved', 'possible');
    return { files, artifacts, patch };
  }
}
