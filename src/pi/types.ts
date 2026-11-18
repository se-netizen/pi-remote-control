export interface SessionDescriptor {
  sessionId: string;
  runtimeId: string;
  bindingEpoch: number;
  branchId: string;
  leafEntryId?: string;
  title: string;
  cwd: string;
  mode: 'attach' | 'managed';
  workState: 'idle' | 'running' | 'waiting_local_input' | 'stopping' | 'ended';
  capabilities: string[];
  messages: unknown[];
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  truncated?: boolean;
  /** Slash commands the remote can run in this session (bridge built-ins plus Pi extension/prompt/skill commands). */
  commands?: RemoteCommandInfo[];
}
export interface RemoteCommandInfo { name: string; description: string; hint?: string; source: 'remote' | 'extension' | 'prompt' | 'skill' }
export interface CommandOutput { message?: string; title?: string; choices?: { label: string; value: string; detail?: string; current?: boolean }[] }

export interface BridgeCommand {
  type: 'command';
  commandId: string;
  sessionId: string;
  runtimeId: string;
  bindingEpoch: number;
  branchId: string;
  kind: 'prompt' | 'steer' | 'follow_up' | 'abort' | 'command';
  payload: { text?: string; attachments?: RemoteAttachment[] };
}
/** A file uploaded from a phone, already on this machine's disk (see src/uploads.ts). */
export interface RemoteAttachment { name: string; path: string; mimeType: string; size: number }

export interface BridgeResult {
  type: 'result';
  commandId: string;
  status: 'dispatched_unconfirmed' | 'pi_acknowledged' | 'completed' | 'rejected' | 'stale_context';
  error?: string;
  output?: CommandOutput;
}

/** Split only on LF: Unicode U+2028/U+2029 are valid JSON string contents. */
export class JsonLines {
  private buffer = '';
  constructor(private readonly onRecord: (record: Record<string, unknown>) => void,
    private readonly limit = 16 * 1024 * 1024) {}
  push(chunk: string): void {
    this.buffer += chunk;
    let index: number;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, '');
      this.buffer = this.buffer.slice(index + 1);
      if (Buffer.byteLength(line) > this.limit) throw new Error('Protocol frame exceeds limit');
      if (!line.trim()) continue;
      const record: unknown = JSON.parse(line);
      if (!record || typeof record !== 'object' || Array.isArray(record)) throw new Error('Expected JSON object');
      this.onRecord(record as Record<string, unknown>);
    }
    if (Buffer.byteLength(this.buffer) > this.limit) throw new Error('Protocol frame exceeds limit');
  }
}
