import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { JsonLines } from './types.js';

export interface PiRpcOptions {
  cwd: string;
  sessionDir?: string;
  executable?: string;
  provider?: string;
  model?: string;
  thinkingLevel?: string;
  tools?: string[];
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  args?: string[];
}
export interface PiPromptResult {
  messages: Record<string, unknown>[];
  output: string;
  usage: { input: number; output: number; totalTokens: number; cost?: number };
  stopReason?: string;
}
interface Pending { resolve: (data: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }

/** Owns one newly spawned Pi RPC process, never attaches another writer to a TUI session. */
export class PiRpcWorker extends EventEmitter {
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();
  private exited = false;
  private prompting = false;
  private closing = false;
  private exitPromise?: Promise<void>;
  constructor(readonly options: PiRpcOptions) { super(); }

  async start(): Promise<void> {
    if (this.child) throw new Error('Worker already started');
    if (this.options.sessionDir) await mkdir(this.options.sessionDir, { recursive: true, mode: 0o700 });
    const args = ['--mode', 'rpc', '--offline', '--no-extensions', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--no-approve'];
    if (this.options.sessionDir) args.push('--session-dir', this.options.sessionDir);
    else args.push('--no-session');
    if (this.options.provider && !this.options.model) throw new Error('Provider requires explicit model');
    if (this.options.provider) args.push('--provider', this.options.provider);
    if (this.options.model) args.push('--model', this.options.model);
    if (this.options.thinkingLevel) args.push('--thinking', this.options.thinkingLevel);
    if (this.options.tools?.length) args.push('--tools', this.options.tools.join(','));
    else args.push('--no-tools');
    args.push(...(this.options.args ?? []));
    const child = spawn(this.options.executable ?? 'pi', args, {
      cwd: this.options.cwd, env: { ...process.env, ...this.options.env }, stdio: 'pipe', shell: false,
    });
    this.child = child;
    this.exitPromise = new Promise(resolve => child.once('close', () => resolve()));
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    // Always consume diagnostics; do not log provider output or credentials through the daemon.
    child.stderr.on('data', () => {});
    child.on('error', () => this.fail(new Error('Unable to start Pi RPC process')));
    child.on('close', (code, signal) => {
      this.exited = true;
      const error = new Error(`Pi RPC process exited (code ${code ?? 'none'}, signal ${signal ?? 'none'})`);
      this.fail(error);
      this.emit('exit', { code, signal, expected: this.closing });
    });
    const lines = new JsonLines(record => this.onRecord(record));
    child.stdout.on('data', (chunk: string) => {
      try { lines.push(chunk); }
      catch { this.fail(new Error('Invalid Pi RPC stream')); child.kill('SIGTERM'); }
    });
    child.stdin.on('error', () => this.fail(new Error('Pi RPC stdin closed')));
    try { await this.request('get_state'); }
    catch (error) { await this.close(); throw error; }
  }

  private fail(error: Error): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.emit('failure', error);
  }
  private onRecord(record: Record<string, unknown>): void {
    if (record.type === 'response' && typeof record.id === 'string') {
      const pending = this.pending.get(record.id);
      if (!pending) return;
      this.pending.delete(record.id); clearTimeout(pending.timer);
      if (record.success === true) pending.resolve(record.data);
      else pending.reject(new Error(typeof record.error === 'string' ? record.error : 'Pi RPC command rejected'));
      return;
    }
    if (record.type === 'extension_ui_request' && typeof record.id === 'string') {
      // Managed tasks cannot obtain consent from model text. Unsupported dialogs fail closed.
      if (['select', 'confirm', 'input', 'editor'].includes(String(record.method))) {
        void this.write({ type: 'extension_ui_response', id: record.id, cancelled: true }).catch(() => {});
      }
    }
    this.emit('event', record);
  }
  private async write(record: Record<string, unknown>): Promise<void> {
    const child = this.child;
    if (!child || this.exited || !child.stdin.writable) throw new Error('Pi RPC process unavailable');
    await new Promise<void>((resolve, reject) => {
      child.stdin.write(`${JSON.stringify(record)}\n`, error => error ? reject(error) : resolve());
    });
  }
  async request(type: string, fields: Record<string, unknown> = {}, timeoutMs = this.options.timeoutMs ?? 15_000): Promise<any> {
    if (!this.child || this.exited) throw new Error('Pi RPC process unavailable');
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Pi RPC ${type} timed out; outcome may be indeterminate`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ ...fields, type, id }).catch(error => {
        const pending = this.pending.get(id);
        if (pending) { this.pending.delete(id); clearTimeout(timer); reject(error); }
      });
    });
  }
  async getAvailableModels(): Promise<Record<string, any>[]> { return (await this.request('get_available_models')).models; }
  async getAvailableThinkingLevels(): Promise<string[]> { return (await this.request('get_available_thinking_levels')).levels; }
  async setModel(provider: string, modelId: string): Promise<void> { await this.request('set_model', { provider, modelId }); }
  async setThinkingLevel(level: string): Promise<void> {
    const levels = await this.getAvailableThinkingLevels();
    if (!levels.includes(level)) throw new Error(`Thinking level ${level} is unsupported; available: ${levels.join(', ')}`);
    await this.request('set_thinking_level', { level });
    const state = await this.request('get_state');
    if (state.thinkingLevel !== level) throw new Error('Pi did not apply requested thinking level');
  }

  async prompt(text: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<PiPromptResult> {
    if (this.prompting) throw new Error('Worker already has an active prompt');
    if (options.signal?.aborted) throw new Error('Prompt cancelled before dispatch');
    this.prompting = true;
    const result: PiPromptResult = { messages: [], output: '', usage: { input: 0, output: 0, totalTokens: 0 } };
    try {
      return await new Promise<PiPromptResult>((resolve, reject) => {
        let done = false;
        const cleanup = () => {
          clearTimeout(timer); this.off('event', onEvent); this.off('failure', onFailure);
          options.signal?.removeEventListener('abort', onAbort);
        };
        const finish = (error?: Error) => {
          if (done) return; done = true; cleanup(); error ? reject(error) : resolve(result);
        };
        const onFailure = (error: Error) => finish(error);
        const onAbort = () => {
          void this.abort().catch(() => {});
          finish(new Error('Prompt cancelled; external effects may already have occurred'));
        };
        const onEvent = (event: Record<string, any>) => {
          if (event.type === 'message_end' && event.message && typeof event.message === 'object') {
            const message = event.message as Record<string, any>;
            result.messages.push(message);
            if (message.role === 'assistant') {
              result.output += (message.content ?? []).filter((part: any) => part.type === 'text').map((part: any) => part.text).join('');
              const usage = message.usage;
              if (usage) {
                result.usage.input += Number(usage.input ?? 0);
                result.usage.output += Number(usage.output ?? 0);
                result.usage.totalTokens += Number(usage.totalTokens ?? (Number(usage.input ?? 0) + Number(usage.output ?? 0) + Number(usage.cacheRead ?? 0) + Number(usage.cacheWrite ?? 0)));
                if (typeof usage.cost?.total === 'number') result.usage.cost = (result.usage.cost ?? 0) + usage.cost.total;
              }
              result.stopReason = message.stopReason;
            }
          }
          if (event.type === 'agent_settled') {
            if (event.aborted || result.stopReason === 'aborted') finish(new Error('Pi run aborted; effects may require reconciliation'));
            else if (result.stopReason === 'error') finish(new Error('Pi provider reported a failed run'));
            else finish();
          }
        };
        const timer = setTimeout(() => {
          void this.abort().catch(() => {});
          finish(new Error('Pi run timed out; effects may require reconciliation'));
        }, options.timeoutMs ?? 120_000);
        this.on('event', onEvent); this.on('failure', onFailure);
        options.signal?.addEventListener('abort', onAbort, { once: true });
        this.request('prompt', { message: text }).then(data => {
          if (data?.disposition === 'handled') finish();
        }).catch((error: Error) => finish(error));
      });
    } finally { this.prompting = false; }
  }
  async abort(): Promise<void> {
    // Mirror interactive stop: queued work must not begin after abort.
    await this.request('clear_queue', {}, 3000);
    await this.request('abort', {}, 5000);
  }
  async close(graceMs = 1500): Promise<void> {
    if (!this.child || this.exited) return;
    this.closing = true;
    this.child.stdin.end();
    const terminate = setTimeout(() => { if (!this.exited) this.child?.kill('SIGTERM'); }, graceMs);
    const kill = setTimeout(() => { if (!this.exited) this.child?.kill('SIGKILL'); }, graceMs + 1000);
    await this.exitPromise;
    clearTimeout(terminate); clearTimeout(kill);
  }
}
