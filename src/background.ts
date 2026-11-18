import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { sep } from 'node:path';
import { RemoteError } from './errors.js';
import { JsonLines } from './pi/types.js';

/**
 * Background Pi sessions that keep running without a terminal.
 *
 * - tmux (when installed): the real Pi TUI in a hidden tmux session `pi-rc-*`; the user can come back
 *   with `tmux attach -t NAME` or `/remote-control attach`.
 * - rpc (no tmux, e.g. Windows): Pi in RPC mode as a child of the daemon. No terminal to peek into,
 *   but `/remote-control attach` still moves the session into a terminal Pi.
 *
 * In both cases Pi loads the remote-control extension, which registers the session with the daemon
 * like any terminal session (PI_REMOTE_AUTOSTART=1), so remote control works the same way.
 */
export type Backend = 'tmux' | 'rpc';
export interface Launcher { node: string; cli: string; path?: string; agentDir?: string; extensions?: string[] }
export interface BackgroundEntry { name: string; backend: Backend; cwd: string; sessionFile?: string; createdAt: number; pid?: number }
type Exec = (file: string, args: string[]) => Promise<{ code: number; stdout: string }>;
type SpawnRpc = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }) => ChildProcessWithoutNullStreams;

const PREFIX = 'pi-rc-';
const execDefault: Exec = (file, args) => new Promise(resolve => {
  execFile(file, args, { timeout: 5000, maxBuffer: 1024 * 1024 }, (error, stdout) => resolve({ code: error ? (typeof (error as any).code === 'number' ? (error as any).code : 1) : 0, stdout: String(stdout ?? '') }));
});

export interface BackgroundOptions {
  home?: string;
  /** Force a backend; default picks tmux when `tmux -V` works. */
  prefer?: 'auto' | Backend;
  exec?: Exec;
  spawnRpc?: SpawnRpc;
  isAlive?: (pid: number) => boolean;
  /** Extra environment for started Pi processes, e.g. the daemon's socket and secret locations. */
  env?: Record<string, string>;
}

export class BackgroundManager {
  private readonly entries = new Map<string, BackgroundEntry>();
  private readonly children = new Map<string, ChildProcessWithoutNullStreams>();
  private launcher?: Launcher;
  private tmux?: Promise<boolean>;
  private readonly home: string;
  private readonly exec: Exec;
  private readonly spawnRpc: SpawnRpc;
  private readonly isAlive: (pid: number) => boolean;
  constructor(private readonly options: BackgroundOptions = {}) {
    this.home = options.home ?? homedir();
    this.exec = options.exec ?? execDefault;
    this.spawnRpc = options.spawnRpc ?? ((command, args, opts) => spawn(command, args, { ...opts, stdio: 'pipe', shell: false }) as ChildProcessWithoutNullStreams);
    this.isAlive = options.isAlive ?? (pid => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } });
  }

  /** How to start Pi: the node binary and Pi CLI of the most recent terminal Pi that registered. */
  setLauncher(launcher: unknown): void {
    const l = launcher as Partial<Launcher> | undefined;
    if (l && typeof l.node === 'string' && typeof l.cli === 'string' && l.node.startsWith('/') && l.cli.startsWith('/')) {
      this.launcher = { node: l.node, cli: l.cli, ...(typeof l.path === 'string' && l.path.length < 8192 ? { path: l.path } : {}), ...(typeof l.agentDir === 'string' && l.agentDir.startsWith('/') && l.agentDir.length < 1024 ? { agentDir: l.agentDir } : {}),
        ...(Array.isArray(l.extensions) ? { extensions: l.extensions.filter((e): e is string => typeof e === 'string' && e.length < 1024 && !e.startsWith('-')).slice(0, 20) } : {}) };
    }
  }
  hasLauncher(): boolean { return !!this.launcher; }

  async tmuxAvailable(): Promise<boolean> {
    if (process.platform === 'win32') return false;
    this.tmux ??= this.exec('tmux', ['-V']).then(r => r.code === 0 && /^tmux /.test(r.stdout)).catch(() => false);
    return this.tmux;
  }
  async backend(): Promise<Backend> {
    if (this.options.prefer === 'rpc' || this.options.prefer === 'tmux') return this.options.prefer;
    return (await this.tmuxAvailable()) ? 'tmux' : 'rpc';
  }

  /** A fresh, unused `pi-rc-xxxxxx` name. */
  newName(): string {
    let name: string;
    do name = `${PREFIX}${randomBytes(3).toString('hex')}`; while (this.entries.has(name));
    return name;
  }

  /** A folder inside the home directory (after resolving symlinks) that exists. `anywhere` lifts the home rule for local terminal handoffs. */
  async validateFolder(folder: unknown, anywhere = false): Promise<string> {
    if (typeof folder !== 'string' || !folder.trim() || folder.length > 1024) throw new RemoteError('invalid_folder');
    const expanded = folder.trim().startsWith('~') ? this.home + folder.trim().slice(1) : folder.trim();
    let resolved: string;
    try { resolved = await realpath(expanded); } catch { throw new RemoteError('folder_not_found', 404); }
    const home = await realpath(this.home).catch(() => this.home);
    if (!anywhere && resolved !== home && !resolved.startsWith(home + sep)) throw new RemoteError('folder_outside_home', 403);
    if (!(await stat(resolved)).isDirectory()) throw new RemoteError('folder_not_found', 404);
    return resolved;
  }

  list(): BackgroundEntry[] { return [...this.entries.values()].map(e => ({ ...e })); }
  get(name: string): BackgroundEntry | undefined { const e = this.entries.get(name); return e ? { ...e } : undefined; }

  /** Drops tmux entries whose session has ended and adopts `pi-rc-*` sessions left by an earlier daemon. */
  async reconcile(): Promise<void> {
    if (!(await this.tmuxAvailable())) return;
    const r = await this.exec('tmux', ['list-sessions', '-F', '#{session_name}\t#{session_created}\t#{pane_current_path}']);
    const live = new Map<string, { created: number; cwd: string }>();
    if (r.code === 0) for (const line of r.stdout.split('\n')) {
      const [name, created, cwd] = line.split('\t');
      if (name?.startsWith(PREFIX) && /^pi-rc-[a-f0-9]{6}$/.test(name)) live.set(name, { created: Number(created) * 1000, cwd: cwd ?? '' });
    }
    for (const [name, entry] of this.entries) if (entry.backend === 'tmux' && !live.has(name)) this.entries.delete(name);
    for (const [name, info] of live) if (!this.entries.has(name)) this.entries.set(name, { name, backend: 'tmux', cwd: info.cwd, createdAt: info.created || Date.now() });
  }

  /**
   * Starts Pi in the background. `afterPid` (detach handoff) waits until that process has exited,
   * so two processes never write the same session file.
   */
  async start(request: { cwd: string; sessionFile?: string; afterPid?: number; waitMs?: number; name?: string }): Promise<BackgroundEntry> {
    const backend = await this.backend();
    const name = request.name && /^pi-rc-[a-f0-9]{6}$/.test(request.name) && !this.entries.has(request.name) ? request.name : this.newName();
    if (request.afterPid) await this.waitForExit(request.afterPid, request.waitMs ?? 60_000);
    const launcher = this.launcher;
    const command = launcher ? [launcher.node, launcher.cli] : ['pi'];
    const piArgs = [...(launcher?.extensions ?? []).flatMap(e => ['-e', e]), ...(request.sessionFile ? ['--session', request.sessionFile] : [])];
    const env: Record<string, string> = {
      ...this.options.env, PI_REMOTE_AUTOSTART: '1', PI_REMOTE_BACKGROUND: name, PI_REMOTE_BACKGROUND_BACKEND: backend,
      ...(launcher?.path ? { PATH: launcher.path } : {}), ...(launcher?.agentDir ? { PI_CODING_AGENT_DIR: launcher.agentDir } : {}),
    };
    const entry: BackgroundEntry = { name, backend, cwd: request.cwd, ...(request.sessionFile ? { sessionFile: request.sessionFile } : {}), createdAt: Date.now() };
    if (backend === 'tmux') {
      const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
      const r = await this.exec('tmux', ['new-session', '-d', '-s', name, '-x', '120', '-y', '40', '-c', request.cwd, ...envArgs, '--', ...command, ...piArgs]);
      if (r.code !== 0) throw new RemoteError('background_start_failed', 500);
    } else {
      const child = this.spawnRpc(command[0]!, [...command.slice(1), '--mode', 'rpc', ...piArgs], { cwd: request.cwd, env: { ...process.env, ...env } });
      entry.pid = child.pid;
      this.children.set(name, child);
      // Pi in RPC mode talks JSONL on stdout and blocks if nobody reads it. Dialogs that need an answer
      // cannot be shown anywhere, so they are cancelled instead of hanging the session.
      child.stdout.setEncoding('utf8'); child.stderr.on('data', () => {});
      const lines = new JsonLines(record => {
        if (record.type === 'extension_ui_request' && typeof record.id === 'string' && ['select', 'confirm', 'input', 'editor'].includes(String(record.method))) {
          if (!child.stdin.destroyed) child.stdin.write(JSON.stringify({ type: 'extension_ui_response', id: record.id, cancelled: true }) + '\n');
        }
      }, 64 * 1024 * 1024);
      child.stdout.on('data', (chunk: string) => { try { lines.push(chunk); } catch { /* malformed output: keep draining */ } });
      child.on('error', () => { this.children.delete(name); this.entries.delete(name); });
      child.on('close', () => { this.children.delete(name); this.entries.delete(name); });
    }
    this.entries.set(name, entry);
    return { ...entry };
  }

  /**
   * Stops a background session: `askShutdown` asks Pi to quit cleanly through the extension; if it
   * is still there after the grace period, the tmux session is killed (or the RPC child terminated).
   */
  async stop(name: string, askShutdown: () => boolean, graceMs = 10_000): Promise<void> {
    const entry = this.entries.get(name);
    if (!entry || !name.startsWith(PREFIX)) throw new RemoteError('background_not_found', 404);
    askShutdown();
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline && await this.running(entry)) await new Promise(r => setTimeout(r, 200));
    if (await this.running(entry)) {
      if (entry.backend === 'tmux') await this.exec('tmux', ['kill-session', '-t', `=${name}`]);
      else this.children.get(name)?.kill('SIGTERM');
    }
    this.entries.delete(name);
  }

  private async running(entry: BackgroundEntry): Promise<boolean> {
    if (entry.backend === 'tmux') return (await this.exec('tmux', ['has-session', '-t', `=${entry.name}`])).code === 0;
    const child = this.children.get(entry.name);
    return !!child && child.exitCode === null && child.signalCode === null;
  }

  async waitForExit(pid: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.isAlive(pid)) {
      if (Date.now() > deadline) throw new RemoteError('handoff_timeout', 409);
      await new Promise(r => setTimeout(r, 150));
    }
  }

  attachCommand(name: string): string | undefined {
    const entry = this.entries.get(name);
    return entry?.backend === 'tmux' ? `tmux attach -t ${name}` : undefined;
  }

  /** RPC children die with the daemon; tmux sessions keep running and are adopted on restart. */
  close(): void { for (const child of this.children.values()) child.kill('SIGTERM'); this.children.clear(); }
}
