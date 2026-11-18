import { connect, type Socket } from 'node:net';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { existsSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { JsonLines, type BridgeCommand, type BridgeResult, type CommandOutput, type RemoteAttachment, type RemoteCommandInfo, type SessionDescriptor } from './types.js';
import { preferredPhoneUrl, qrWidth, renderQr } from './qr.js';
import { openSettingsPanel } from './settings-panel.js';

/** Structural subset of the pinned Pi 1.5.2 extension API; no second SDK runtime is loaded. */
export interface AttachContext {
  mode: string;
  cwd: string;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  isIdle(): boolean;
  abort(): void;
  /** Gracefully quit Pi (all contexts in Pi 1.5.2). */
  shutdown?(): void;
  compact?(options?: { customInstructions?: string; onComplete?: (result: unknown) => void; onError?: (error: Error) => void }): void;
  getContextUsage?(): { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
  modelRegistry?: { getAvailable(): { provider: string; id: string; name?: string; reasoning?: boolean }[] };
  /** Only on command contexts (ExtensionCommandContext). */
  newSession?(options?: { withSession?: (ctx: AttachContext) => Promise<void> }): Promise<unknown>;
  reload?(): Promise<void>;
  waitForIdle?(): Promise<void>;
  switchSession?(sessionPath: string, options?: { withSession?: (ctx: AttachContext) => Promise<void> }): Promise<unknown>;
  sessionManager: {
    getSessionId(): string;
    getLeafId(): string | null;
    getSessionName(): string | undefined;
    getSessionFile?(): string | undefined;
    buildSessionProjection(): { messages: unknown[] };
  };
  ui: {
    notify(message: string, kind?: 'info' | 'warning' | 'error'): void;
    /** Pi 1.5.2: string[] widgets are capped at 10 lines, so the QR uses a component factory. */
    setWidget?(key: string, content: undefined | ((tui: unknown, theme: unknown) => WidgetComponent), options?: { placement?: 'aboveEditor' | 'belowEditor' }): void;
    select?(title: string, options: string[]): Promise<string | undefined>;
    custom?<T>(factory: (tui: any, theme: unknown, keybindings: unknown, done: (result: T) => void) => WidgetComponent): Promise<T>;
  };
}
export interface CompletionItem { value: string; label: string; description?: string }
export type UserContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export interface WidgetComponent { render(width: number): string[]; invalidate(): void; dispose?(): void; handleInput?(data: string): void }
export interface AttachPi {
  registerCommand(name: string, command: {
    description: string;
    /** Pi 1.5.2 shows these after `/name ` (and on Tab); `value` replaces everything typed after the command. */
    getArgumentCompletions?: (prefix: string) => CompletionItem[] | null | Promise<CompletionItem[] | null>;
    handler: (args: string, ctx: AttachContext) => Promise<void>;
  }): void;
  on(name: string, handler: (event: Record<string, any>, ctx: AttachContext) => void | Promise<void>): unknown;
  sendUserMessage(content: string | UserContent[], options?: { deliverAs?: 'steer' | 'followUp'; expandPromptTemplates?: boolean }): void;
  getThinkingLevel(): string;
  getCommands?(): { name: string; description?: string; source: string }[];
  setModel?(model: unknown): Promise<boolean>;
  setThinkingLevel?(level: string): void;
  setSessionName?(name: string): void;
}
interface ProcessBinding {
  runtimeId: string; epoch: number; enabled: boolean; dispose?: () => void;
  /**
   * Command context for remote /new and /reload. Pi re-creates extension instances when it replaces
   * the session, so this lives with the process, not with one bridge instance.
   */
  commandCtx?: AttachContext;
  /** Asks the live bridge instance for a fresh snapshot (the command list depends on commandCtx). */
  refresh?: () => void;
}
const key = Symbol.for('pi-remote-control.binding.v1');
function processBinding(): ProcessBinding {
  const globals = globalThis as unknown as Record<symbol, ProcessBinding>;
  return globals[key] ??= { runtimeId: randomUUID(), epoch: 0, enabled: false };
}

export interface AttachOptions { socketPath?: string; secretFile?: string; url?: string; binding?: ProcessBinding }
function publicOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return undefined;
    return url.origin;
  } catch { return undefined; }
}
const PAIR_WIDGET = 'remote-control-pair';
/** Set when the daemon started this Pi as a background session (tmux or RPC). */
function backgroundInfo(): { name: string; backend: string } | undefined {
  const name = process.env.PI_REMOTE_BACKGROUND;
  return process.env.PI_REMOTE_AUTOSTART === '1' && name && /^pi-rc-[a-f0-9]{6}$/.test(name) ? { name, backend: process.env.PI_REMOTE_BACKGROUND_BACKEND === 'rpc' ? 'rpc' : 'tmux' } : undefined;
}
/** How the daemon can start Pi the same way this process was started (the daemon may lack Pi on PATH). */
function launcherInfo(): { node: string; cli: string; path?: string; agentDir?: string; extensions?: string[] } | undefined {
  const cli = process.argv[1];
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  // Extensions loaded with -e/--extension (not installed as packages) must be passed again,
  // otherwise the background Pi would start without remote control.
  const extensions: string[] = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if ((arg === '-e' || arg === '--extension') && argv[i + 1]) extensions.push(argv[++i]!);
    else if (arg.startsWith('--extension=')) extensions.push(arg.slice('--extension='.length));
  }
  const absolute = extensions.map(e => e.startsWith('/') || e.startsWith('builtin:') || e.startsWith('npm:') ? e : `${process.cwd()}/${e}`).slice(0, 20);
  return process.execPath.startsWith('/') && typeof cli === 'string' && cli.startsWith('/') ? { node: process.execPath, cli, ...(process.env.PATH ? { path: process.env.PATH } : {}), ...(agentDir?.startsWith('/') ? { agentDir } : {}), ...(absolute.length ? { extensions: absolute } : {}) } : undefined;
}
/** Wi-Fi pairing link to show: home/office ranges (192.168/16, 10/8) before 172.16/12, which is mostly container bridges. */
function preferLan(links: string[]): string {
  const host = (u: string) => { try { return new URL(u).hostname; } catch { return ''; } };
  const rank = (u: string) => /^192\.168\./.test(host(u)) ? 0 : /^10\./.test(host(u)) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(host(u)) ? 2 : 3;
  return [...links].sort((a, b) => rank(a) - rank(b))[0]!;
}
/** Paired owner devices that are still valid; each of them can open every exposed session. */
function activeOwners(devices: unknown): { name: string; clientId: string }[] {
  return (Array.isArray(devices) ? devices : []).filter((d: any) => d && d.owner && !d.revoked && (typeof d.expiresAt !== 'number' || d.expiresAt > Date.now()));
}
function deviceNames(devices: { name: string }[]): string {
  const counts = new Map<string, number>();
  for (const d of devices) counts.set(terminalText(d.name), (counts.get(terminalText(d.name)) ?? 0) + 1);
  return [...counts].map(([name, n]) => n > 1 ? `${name} (${n})` : name).join(', ');
}
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const REMOTE_COMMANDS: Omit<RemoteCommandInfo, 'source'>[] = [
  { name: 'model', description: 'Switch model', hint: '[provider/model]' },
  { name: 'thinking', description: 'Set thinking level', hint: '[level]' },
  { name: 'compact', description: 'Compact the context', hint: '[instructions]' },
  { name: 'new', description: 'Start a new session' },
  { name: 'name', description: 'Rename the session', hint: '<name>' },
  { name: 'session', description: 'Show session info' },
  { name: 'reload', description: 'Reload extensions, skills and prompts' },
  { name: 'stop', description: 'Stop Pi' },
  { name: 'help', description: 'List commands' },
];
/** Built-in TUI commands that need the terminal (pickers, clipboard, auth, process control). */
const TERMINAL_ONLY = new Set(['settings', 'tree', 'scoped-models', 'export', 'import', 'share', 'bug', 'copy', 'changelog', 'hotkeys', 'fork', 'clone', 'trust', 'login', 'logout', 'resume', 'quit', 'remote-control']);
function contextUsage(ctx: AttachContext): { tokens: number | null; contextWindow: number; percent: number | null } | undefined {
  try {
    const usage = ctx.getContextUsage?.();
    return usage && typeof usage.contextWindow === 'number' ? { tokens: usage.tokens ?? null, contextWindow: usage.contextWindow, percent: usage.percent ?? null } : undefined;
  } catch { return undefined; }
}
type ThemeLike = { fg?(color: string, text: string): string; bold?(text: string): string } | undefined;
function pairingWidget(link: string, minutes: number, theme: unknown, tui?: unknown): WidgetComponent {
  const t = theme as ThemeLike;
  const fg = (color: string, text: string) => { try { return t?.fg ? t.fg(color, text) : text; } catch { return text; } };
  const bold = (text: string) => { try { return t?.bold ? t.bold(text) : text; } catch { return text; } };
  const rows = () => { const r = (tui as { terminal?: { rows?: unknown } } | undefined)?.terminal?.rows; return typeof r === 'number' && r > 0 ? r : 60; };
  let cache: { width: number; height: number; lines: string[] } | undefined;
  return {
    render(width: number): string[] {
      const height = rows();
      if (cache?.width === width && cache.height === height) return cache.lines;
      // Every line is cut to the terminal width before colouring, so it never wraps or overflows.
      const room = Math.max(1, width - 2);
      const fit = (text: string) => text.slice(0, room);
      const qr = renderQr(link);
      // The link comes first: if the terminal is short, it is the QR that gets dropped, never the link.
      const showQr = width >= qrWidth(link) + 2 && height >= qr.length + 12;
      const wifi = link.includes('/#w=');
      const title = showQr ? (wifi ? 'Scan the QR with a phone on the same Wi-Fi (encrypted):' : 'Scan the QR with your phone camera, or open:') : 'Open this link on your phone:';
      const lines: string[] = [`  ${bold(fg('accent', fit(title)))}`];
      for (let i = 0; i < link.length; i += room) lines.push(`  ${fg('dim', link.slice(i, i + room))}`);
      if (showQr) for (const row of qr) lines.push(`  ${row}`);
      else if (width >= qrWidth(link) + 2) lines.push(`  ${fg('muted', fit('(Enlarge the terminal to show the QR)'))}`);
      const footer = width >= 64 ? `Single use · ${minutes} min · /remote-control stop to close` : `Single use · ${minutes} min`;
      lines.push(`  ${fg('muted', fit(footer))}`);
      cache = { width, height, lines };
      return lines;
    },
    invalidate() { cache = undefined; },
  };
}
/** Heading of the file list appended to a message with attachments; web/helpers.js splitAttachments() parses it. */
export const ATTACHMENT_HEADING = 'Files from phone (saved on this computer):';
const INLINE_IMAGES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const INLINE_IMAGE_MAX = 20 * 1024 * 1024, INLINE_TOTAL_MAX = 50 * 1024 * 1024;
function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
/** The message text Pi receives: what was typed, then one line per file with its absolute path. */
export function attachmentText(text: string, files: RemoteAttachment[]): string {
  const list = files.map(f => `- ${f.path} (${f.mimeType}, ${formatSize(f.size)})`).join('\n');
  return `${text.trim() ? `${text.trimEnd()}\n\n` : ''}${ATTACHMENT_HEADING}\n${list}`;
}
function validAttachments(value: unknown): RemoteAttachment[] {
  if (!Array.isArray(value) || !value.length || value.length > 10) throw new Error('Invalid attachments');
  return value.map(v => {
    const f = v as Record<string, unknown>;
    if (typeof f?.path !== 'string' || !f.path.startsWith('/') || /[\u0000-\u001f]/.test(f.path) || typeof f.name !== 'string' || typeof f.mimeType !== 'string' || !Number.isSafeInteger(f.size)) throw new Error('Invalid attachments');
    return { name: f.name, path: f.path, mimeType: f.mimeType, size: Number(f.size) };
  });
}
/** Image bytes stay out of snapshots: Pi keeps them in the session, the phone only needs to know one was there. */
function withoutImageData(message: unknown): unknown {
  const m = message as { content?: unknown };
  if (!m || !Array.isArray(m.content) || !m.content.some(p => (p as { type?: string })?.type === 'image')) return message;
  return { ...m, content: m.content.map(p => (p as { type?: string })?.type === 'image' ? { type: 'image', mimeType: (p as { mimeType?: string }).mimeType } : p) };
}
/** "5m ago" for a timestamp in milliseconds. */
function ago(at: unknown): string {
  const ms = Date.now() - Number(at);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
}
function terminalText(value: unknown): string { return String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' '); }
export class AttachBridge {
  private ctx?: AttachContext;
  private socket?: Socket;
  private reconnect?: ReturnType<typeof setTimeout>;
  private snapshotTimer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private branchId = randomUUID();
  private bindingEpoch = 0;
  private enabled = false;
  private registered = false;
  private state: SessionDescriptor['workState'] = 'idle';
  private failures = 0;
  private advertisedUrl?: string;
  private advertisedUrls: string[] = [];
  private currentMessage?: Record<string, any>;
  /** Pi rejects every prompt while compaction or a branch summary runs; the rejection never reaches extensions. */
  private maintenanceUntil = 0;
  private lastSnapshotAt = 0;
  private pairWatch?: ReturnType<typeof setTimeout>;
  private pairWatchCtx?: AttachContext;
  private readonly activeTools = new Map<string, Record<string, unknown>>();
  private readonly global: ProcessBinding;
  readonly socketPath: string;
  readonly secretFile: string;
  constructor(private readonly pi: AttachPi, private readonly options: AttachOptions = {}) {
    this.socketPath = options.socketPath ?? process.env.PI_REMOTE_SOCKET ?? join(homedir(), '.pi', 'remote-control', 'bridge.sock');
    this.secretFile = options.secretFile ?? process.env.PI_REMOTE_SECRET_FILE ?? join(homedir(), '.pi', 'remote-control', 'bridge.secret');
    this.global = options.binding ?? processBinding();
    this.global.dispose?.();
    this.global.dispose = () => this.stop(false);
    this.global.refresh = () => this.scheduleSnapshot();
  }
  bind(ctx: AttachContext): void {
    this.ctx = ctx;
    this.bindingEpoch = ++this.global.epoch;
    this.branchId = randomUUID();
    this.currentMessage = undefined; this.activeTools.clear();
    this.state = ctx.isIdle() ? 'idle' : 'running';
    if (this.enabled) { this.socket?.destroy(); void this.connect().catch(() => this.retry()); }
  }
  async start(ctx: AttachContext): Promise<void> {
    if (ctx.mode !== 'tui' && !backgroundInfo()) throw new Error('Remote attach requires the active Pi TUI');
    this.stop(false);
    this.bind(ctx);
    this.enabled = true; this.global.enabled = true;
    const epoch = this.bindingEpoch;
    try { await this.connect(); }
    catch (error) { if (epoch === this.bindingEpoch) this.stop(); throw error; }
    if (epoch === this.bindingEpoch && this.enabled) {
      this.heartbeat = setInterval(() => this.send({ type: 'ping' }), 15_000);
      this.heartbeat.unref();
    }
  }
  /**
   * Shows the pairing QR and one link. Opening it pairs the device directly; the daemon then
   * sends a `paired` notice, which replaces the QR with a short confirmation.
   */
  showPairing(ctx: AttachContext, link: string, expiresAt: number): void {
    this.clearPairing();
    this.pairWatchCtx = ctx;
    if (!ctx.ui.setWidget) { ctx.ui.notify(`Open on your phone: ${link}`, 'info'); return; }
    const minutes = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000));
    ctx.ui.setWidget(PAIR_WIDGET, (tui, theme) => pairingWidget(link, minutes, theme, tui));
    this.pairWatch = setTimeout(() => {
      if (this.pairWatchCtx !== ctx) return;
      this.clearPairing();
      ctx.ui.notify('The remote QR expired. Run /remote-control again for a new one.', 'info');
    }, Math.max(1000, expiresAt - Date.now()));
    this.pairWatch.unref();
  }
  clearPairing(): void {
    clearTimeout(this.pairWatch); this.pairWatch = undefined;
    const ctx = this.pairWatchCtx; this.pairWatchCtx = undefined;
    try { ctx?.ui.setWidget?.(PAIR_WIDGET, undefined); } catch { /* context replaced by reload */ }
  }
  private onPaired(name: unknown): void {
    this.clearPairing();
    this.ctx?.ui.notify(`📱 ${terminalText(name) || 'New device'} connected to this session. Manage: /remote-control devices`, 'info');
  }
  stop(clearDesired = true): void {
    this.clearPairing();
    this.enabled = false;
    this.registered = false;
    if (clearDesired) this.global.enabled = false;
    clearTimeout(this.reconnect); clearTimeout(this.snapshotTimer); clearInterval(this.heartbeat);
    this.reconnect = undefined; this.snapshotTimer = undefined;
    this.socket?.destroy(); this.socket = undefined;
    this.currentMessage = undefined; this.activeTools.clear();
    ++this.bindingEpoch;
  }
  isEnabled(): boolean { return this.enabled; }
  /** Settings from the daemon (see /remote-control settings); `activity` controls the notices below. */
  private remote: { activity: boolean } = { activity: true };
  private applySettings(value: unknown): void {
    const v = value as { activity?: unknown } | undefined;
    if (v && typeof v === 'object') this.remote = { activity: v.activity !== false };
  }
  showsActivity(): boolean { return this.remote.activity; }
  /** A notice about something a remote device did; hidden when "Remote activity in this terminal" is off. */
  private activity(ctx: AttachContext, message: string, kind: 'info' | 'warning' | 'error' = 'info'): void {
    if (this.remote.activity) ctx.ui.notify(message, kind);
  }
  isConnected(): boolean { return this.enabled && this.registered && !!this.socket && !this.socket.destroyed; }
  wantsReconnect(): boolean { return this.global.enabled; }
  get url(): string { return this.advertisedUrl ?? publicOrigin(this.options.url) ?? publicOrigin(process.env.PI_REMOTE_URL) ?? 'http://127.0.0.1:3141'; }
  /** Every origin the daemon accepts, best first (e.g. Tailscale IP, LAN IP, loopback). */
  get urls(): string[] { return this.advertisedUrls.length ? [...this.advertisedUrls] : [this.url]; }
  async admin(action: 'pair' | 'status' | 'revoke' | 'background.list' | 'background.handoff' | 'background.release' | 'background.stop' | 'settings.get' | 'settings.set', fields: Record<string, unknown> = {}): Promise<Record<string, any>> {
    const secret = (await readFile(this.secretFile, 'utf8')).trim();
    if (!secret) throw new Error('Daemon bridge secret is empty');
    return new Promise((resolve, reject) => {
      const socket = connect(this.socketPath);
      socket.setEncoding('utf8');
      let settled = false;
      const finish = (error?: Error, value?: Record<string, unknown>) => {
        if (settled) return; settled = true;
        clearTimeout(timeout); socket.destroy();
        if (error) reject(error); else resolve(value!);
      };
      const timeout = setTimeout(() => finish(new Error('Daemon request timed out')), action === 'background.release' ? 30_000 : 8000);
      const lines = new JsonLines(record => {
        if (typeof record.error === 'string') finish(new Error(`Daemon rejected the request: ${terminalText(record.error)}`));
        else finish(undefined, record);
      }, 256 * 1024);
      socket.once('connect', () => socket.write(`${JSON.stringify({ ...fields, type: 'admin', secret, action })}\n`));
      socket.on('data', (chunk: string) => { try { lines.push(chunk); } catch { finish(new Error('Invalid daemon response')); } });
      socket.once('error', () => finish(new Error('The daemon is not running. Run npm start -- start in the pi-remote-control folder.')));
      socket.once('close', () => finish(new Error('Daemon closed the request before replying')));
    });
  }
  snapshot(): SessionDescriptor {
    const ctx = this.ctx;
    if (!ctx) throw new Error('Pi context is unavailable');
    const allMessages = [...ctx.sessionManager.buildSessionProjection().messages];
    if (this.currentMessage) {
      // Pi persists the final assistant message after streaming. A snapshot also needs its live draft.
      const current = this.currentMessage;
      const index = allMessages.findLastIndex(value => {
        const message = value as Record<string, unknown>;
        return message.role === current.role && message.timestamp !== undefined && message.timestamp === current.timestamp;
      });
      if (index >= 0) allMessages[index] = { ...current, streaming: true };
      else allMessages.push({ ...current, streaming: true });
    }
    allMessages.push(...this.activeTools.values());
    const messages = allMessages.slice(-100).map(withoutImageData);
    const snapshot: SessionDescriptor = {
      sessionId: ctx.sessionManager.getSessionId(), runtimeId: this.global.runtimeId,
      bindingEpoch: this.bindingEpoch, branchId: this.branchId,
      ...(ctx.sessionManager.getLeafId() ? { leafEntryId: ctx.sessionManager.getLeafId()! } : {}),
      title: ctx.sessionManager.getSessionName() ?? basename(ctx.cwd), cwd: ctx.cwd,
      mode: 'attach', workState: this.state, capabilities: ['prompt', 'steer', 'follow_up', 'abort', 'command', 'attachments'],
      commands: this.remoteCommands(),
      ...(backgroundInfo() ? { background: { ...backgroundInfo(), ...(ctx.sessionManager.getSessionFile?.() ? { sessionFile: ctx.sessionManager.getSessionFile!() } : {}) } } : {}),
      ...(contextUsage(ctx) ? { usage: contextUsage(ctx) } : {}),
      messages, ...(ctx.model ? { model: { provider: ctx.model.provider, id: ctx.model.id } } : {}),
      thinkingLevel: ctx.thinkingLevel ?? this.pi.getThinkingLevel(),
      ...(messages.length !== allMessages.length ? { truncated: true } : {}),
    };
    // Keep a usable bounded snapshot and explicitly expose omission.
    while (snapshot.messages.length && Buffer.byteLength(JSON.stringify(snapshot)) > 180 * 1024) {
      snapshot.messages.shift(); snapshot.truncated = true;
    }
    return structuredClone(snapshot);
  }
  private send(record: Record<string, unknown>): void {
    const socket = this.socket;
    if (!this.enabled || !socket || socket.destroyed || socket.connecting) return;
    const line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line) > 256 * 1024) {
      socket.write(`${JSON.stringify({ type: 'event', sessionId: this.ctx?.sessionManager.getSessionId(), event: { type: 'stream_gap', payload: { reason: 'event_too_large', truncated: true } } })}\n`);
      this.scheduleSnapshot(); return;
    }
    if (socket.writableLength > 1024 * 1024) { socket.destroy(); return; }
    socket.write(line);
  }
  private async connect(): Promise<void> {
    if (!this.enabled || !this.ctx) return;
    clearTimeout(this.reconnect);
    const secret = (await readFile(this.secretFile, 'utf8')).trim();
    if (!secret) throw new Error('Daemon bridge secret is empty');
    // A reload may have happened during asynchronous file access.
    if (!this.enabled || this.global.epoch !== this.bindingEpoch) return;
    const epoch = this.bindingEpoch;
    const socket = connect(this.socketPath);
    this.registered = false;
    this.socket = socket;
    socket.setEncoding('utf8');
    let confirm: (() => void) | undefined;
    let fail: ((error: Error) => void) | undefined;
    const registered = new Promise<void>((resolve, reject) => { confirm = resolve; fail = reject; });
    const timeout = setTimeout(() => { socket.destroy(); fail?.(new Error('Daemon registration timed out')); }, 3000);
    const lines = new JsonLines(record => {
      if (this.socket !== socket || epoch !== this.bindingEpoch) return;
      if (record.type === 'registered') { clearTimeout(timeout); this.advertisedUrl = publicOrigin(record.url); this.advertisedUrls = Array.isArray(record.urls) ? [...new Set(record.urls.map(publicOrigin).filter((u): u is string => !!u))].slice(0, 8) : []; this.registered = true; this.failures = 0; this.applySettings(record.settings); confirm?.(); const followed = Number(record.followedDevices) || 0; if (followed > 0) this.ctx?.ui.notify(`Remote stays on for this new session; ${followed} ${followed === 1 ? 'device still has' : 'devices still have'} access. Stop it with /remote-control stop.`, 'info'); }
      if (record.type === 'error') { clearTimeout(timeout); fail?.(new Error('Daemon rejected remote registration')); socket.destroy(); }
      if (record.type === 'command') this.handleCommand(record as unknown as BridgeCommand);
      if (record.type === 'paired') this.onPaired(record.name);
      if (record.type === 'settings') this.applySettings(record.settings);
      // Only daemon-launched background sessions may be closed remotely.
      if (record.type === 'shutdown' && backgroundInfo()) { try { this.ctx?.shutdown?.(); } catch { /* already closing */ } }
    }, 256 * 1024);
    socket.on('data', (chunk: string) => {
      try { lines.push(chunk); } catch { socket.destroy(); }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      clearTimeout(timeout); fail?.(new Error('Daemon connection closed'));
      if (this.socket === socket) { this.socket = undefined; this.registered = false; this.retry(); }
    });
    socket.once('error', () => { clearTimeout(timeout); fail?.(new Error('Daemon is unavailable; run npm start -- serve')); });
    socket.once('connect', () => {
      if (!this.enabled || epoch !== this.bindingEpoch) { socket.destroy(); return; }
      this.send({ type: 'register', secret, session: this.snapshot(), launcher: launcherInfo() });
    });
    await registered;
  }
  private retry(): void {
    if (!this.enabled || this.reconnect) return;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.failures++, 6));
    this.reconnect = setTimeout(() => {
      this.reconnect = undefined;
      void this.connect().catch(() => this.retry());
    }, delay);
    this.reconnect.unref();
  }
  private stale(command: BridgeCommand, ctx: AttachContext): boolean {
    return !this.enabled || ctx !== this.ctx || this.global.epoch !== this.bindingEpoch || command.runtimeId !== this.global.runtimeId ||
      command.sessionId !== ctx.sessionManager.getSessionId() || command.bindingEpoch !== this.bindingEpoch || command.branchId !== this.branchId;
  }
  handleCommand(command: BridgeCommand): BridgeResult {
    const result: BridgeResult = { type: 'result', commandId: command.commandId, status: 'rejected' };
    const ctx = this.ctx;
    if (!ctx || this.stale(command, ctx)) {
      result.status = 'stale_context'; result.error = 'Pi session binding changed';
    } else if (command.payload?.attachments !== undefined && command.kind !== 'abort' && command.kind !== 'command') {
      // Files are read from disk first; the result follows once Pi has the message.
      void this.sendWithAttachments(command, ctx).then(sent => { this.send(sent as unknown as Record<string, unknown>); this.scheduleSnapshot(); });
      return { type: 'result', commandId: command.commandId, status: 'dispatched_unconfirmed' };
    } else if (command.kind === 'command') {
      // Slash commands may await Pi (model switch); the result is sent when they finish.
      void this.runSlash(command, ctx).catch(error => ({ type: 'result' as const, commandId: command.commandId, status: 'rejected' as const, error: error instanceof Error ? error.message : 'Command failed' }))
        .then(slash => { this.send(slash as unknown as Record<string, unknown>); this.scheduleSnapshot(); });
      return { type: 'result', commandId: command.commandId, status: 'dispatched_unconfirmed' };
    } else {
      try {
        if (command.kind === 'abort') {
          ctx.abort(); this.state = ctx.isIdle() ? 'idle' : 'stopping';
          // Pi's TUI moves every queued steer/follow-up (remote ones too) into the terminal editor on abort.
          ctx.ui.notify('A remote device asked Pi to stop. Queued messages were moved to the terminal editor.', 'warning');
        } else {
          const text = command.payload?.text;
          if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text) > 64 * 1024) throw new Error('Invalid prompt text');
          if (!['prompt', 'steer', 'follow_up'].includes(command.kind)) throw new Error('Unsupported command');
          if (command.kind === 'prompt' && !ctx.isIdle()) throw new Error('Pi is busy; explicitly select steer or follow-up');
          // Checked synchronously right before the call: Pi would reject asynchronously and only show the
          // error in the terminal, leaving the remote device with an unconfirmed message.
          if (Date.now() < this.maintenanceUntil) throw new Error('Pi is compacting the context. Try again when compaction finishes.');
          this.pi.sendUserMessage(text, {
            ...(command.kind === 'steer' ? { deliverAs: 'steer' as const } : {}),
            ...(command.kind === 'follow_up' ? { deliverAs: 'followUp' as const } : {}),
            expandPromptTemplates: false,
          });
          const how = command.kind === 'steer' ? 'sent as a steering message' : command.kind === 'follow_up' ? 'queued as a follow-up' : 'sent as a new prompt';
          this.activity(ctx, `Message from a remote device ${how}.`, 'info');
        }
        // sendUserMessage() and ctx.abort() return void; never imply Pi acceptance from their return.
        result.status = 'dispatched_unconfirmed';
      } catch (error) { result.error = error instanceof Error ? error.message : 'Pi command rejected'; }
    }
    this.send(result as unknown as Record<string, unknown>);
    this.scheduleSnapshot();
    return result;
  }
  private async sendWithAttachments(command: BridgeCommand, ctx: AttachContext): Promise<BridgeResult> {
    const result: BridgeResult = { type: 'result', commandId: command.commandId, status: 'rejected' };
    try {
      const files = validAttachments(command.payload.attachments);
      const text = command.payload.text ?? '';
      if (typeof text !== 'string' || Buffer.byteLength(text) > 64 * 1024) throw new Error('Invalid prompt text');
      // Images go inline so the model sees them right away (Pi resizes them); every file is also listed by path.
      const input = (ctx.model as { input?: string[] } | undefined)?.input;
      const images: UserContent[] = [];
      let budget = INLINE_TOTAL_MAX;
      for (const f of files) {
        if (input && !input.includes('image')) break;
        if (!INLINE_IMAGES.has(f.mimeType) || f.size > INLINE_IMAGE_MAX || f.size > budget) continue;
        const data = await readFile(f.path);
        budget -= data.length;
        images.push({ type: 'image', data: data.toString('base64'), mimeType: f.mimeType });
      }
      if (this.stale(command, ctx)) { result.status = 'stale_context'; result.error = 'Pi session binding changed'; return result; }
      if (command.kind === 'prompt' && !ctx.isIdle()) throw new Error('Pi is busy; explicitly select steer or follow-up');
      if (Date.now() < this.maintenanceUntil) throw new Error('Pi is compacting the context. Try again when compaction finishes.');
      this.pi.sendUserMessage([{ type: 'text', text: attachmentText(text, files) }, ...images], {
        ...(command.kind === 'steer' ? { deliverAs: 'steer' as const } : {}),
        ...(command.kind === 'follow_up' ? { deliverAs: 'followUp' as const } : {}),
        expandPromptTemplates: false,
      });
      const how = command.kind === 'steer' ? 'sent as a steering message' : command.kind === 'follow_up' ? 'queued as a follow-up' : 'sent as a new prompt';
      this.activity(ctx, `Message from a remote device with ${files.length} ${files.length === 1 ? 'file' : 'files'} ${how}.`, 'info');
      result.status = 'dispatched_unconfirmed';
    } catch (error) {
      result.error = (error as NodeJS.ErrnoException)?.code === 'ENOENT' ? 'Attached file not found on this computer.' : error instanceof Error ? error.message : 'Pi command rejected';
    }
    return result;
  }
  event(event: Record<string, any>, ctx: AttachContext): void {
    if (!this.ctx || ctx.sessionManager.getSessionId() !== this.ctx.sessionManager.getSessionId() || this.global.epoch !== this.bindingEpoch) return;
    this.ctx = ctx;
    if (event.type === 'session_before_compact' || event.type === 'session_before_tree') this.maintenanceUntil = Date.now() + 10 * 60_000;
    if (['session_compact', 'session_compact_failed', 'session_tree', 'agent_settled'].includes(event.type)) this.maintenanceUntil = 0;
    if (event.type === 'agent_start') this.state = 'running';
    if (event.type === 'agent_settled') this.state = 'idle';
    if ((event.type === 'message_start' || event.type === 'message_update') && event.message && typeof event.message === 'object') this.currentMessage = event.message;
    if (event.type === 'message_end') this.currentMessage = undefined;
    if (event.type === 'tool_execution_start' && typeof event.toolCallId === 'string') {
      this.activeTools.set(event.toolCallId, {
        role: 'toolResult', toolCallId: event.toolCallId, toolName: event.toolName, streaming: true,
        content: [{ type: 'text', text: 'Tool running…' }], timestamp: Date.now(),
      });
    }
    if (event.type === 'tool_execution_update' && typeof event.toolCallId === 'string') {
      this.activeTools.set(event.toolCallId, {
        role: 'toolResult', toolCallId: event.toolCallId, toolName: event.toolName, streaming: true,
        content: Array.isArray(event.partialResult?.content) ? event.partialResult.content : [{ type: 'text', text: 'Tool running…' }],
        timestamp: Date.now(),
      });
    }
    if (event.type === 'tool_execution_end' && typeof event.toolCallId === 'string') this.activeTools.delete(event.toolCallId);
    if (event.type === 'agent_settled') { this.currentMessage = undefined; this.activeTools.clear(); }
    if (event.type === 'ui_prompt_start') this.state = 'waiting_local_input';
    if (event.type === 'ui_prompt_end') this.state = ctx.isIdle() ? 'idle' : 'running';
    if (event.type === 'session_tree') {
      this.currentMessage = undefined; this.activeTools.clear();
      this.branchId = randomUUID(); this.bindingEpoch = ++this.global.epoch;
      // Re-register a new generation; old socket callback cannot dispatch.
      if (this.enabled) { this.socket?.destroy(); void this.connect().catch(() => this.retry()); }
    }
    if (this.enabled && event.type === 'message_update') {
      const e = event.assistantMessageEvent;
      // Only the new characters cross IPC, so the browser can render text as Pi writes it.
      if (e && (e.type === 'text_delta' || e.type === 'thinking_delta') && typeof e.delta === 'string' && Number.isSafeInteger(e.contentIndex)) {
        for (let i = 0; i < e.delta.length; i += 8192) {
          this.send({ type: 'delta', sessionId: ctx.sessionManager.getSessionId(), delta: { kind: e.type === 'text_delta' ? 'text' : 'thinking', index: e.contentIndex, text: e.delta.slice(i, i + 8192), messageTs: event.message?.timestamp } });
        }
      }
    }
    if (this.enabled && (event.type === 'message_update' || event.type === 'tool_execution_update')) {
      // These fire per token with the cumulative message; serialising them inside Pi's process would
      // cost O(n^2). The throttled snapshot carries the live content instead.
      this.scheduleSnapshot(); return;
    }
    if (this.enabled) {
      // Model metadata can contain provider headers/base URLs; transport only the public identity.
      const payload = event.type === 'model_select' ? {
        type: event.type, source: event.source,
        model: event.model ? { provider: event.model.provider, id: event.model.id } : undefined,
        previousModel: event.previousModel ? { provider: event.previousModel.provider, id: event.previousModel.id } : undefined,
      } : event;
      this.send({ type: 'event', sessionId: ctx.sessionManager.getSessionId(), event: { type: event.type, payload } });
      this.scheduleSnapshot();
    }
  }
  /** After /remote-control attach switches sessions, the next extension instance must reconnect. */
  keepRemoteEnabled(): void { this.global.enabled = true; }
  setCommandContext(ctx: AttachContext | undefined): void { this.global.commandCtx = ctx; this.scheduleSnapshot(); }
  /** `/remote-control auto`: every new Pi TUI session on this machine registers by itself. */
  private get autoStartFile(): string { return join(dirname(this.socketPath), 'autostart'); }
  autoStart(): boolean { try { return existsSync(this.autoStartFile); } catch { return false; } }
  setAutoStart(on: boolean): void {
    if (on) writeFileSync(this.autoStartFile, 'on\n', { mode: 0o600 });
    else { try { unlinkSync(this.autoStartFile); } catch { /* already off */ } }
  }

  /** Commands the web palette offers: bridge built-ins first, then Pi extension, prompt and skill commands. */
  remoteCommands(): RemoteCommandInfo[] {
    const canReplace = !!this.global.commandCtx?.newSession;
    const builtins: RemoteCommandInfo[] = REMOTE_COMMANDS.filter(c => (c.name !== 'new' && c.name !== 'reload') || canReplace).map(c => ({ ...c, source: 'remote' }));
    let others: RemoteCommandInfo[] = [];
    try {
      const names = new Set(builtins.map(c => c.name));
      others = (this.pi.getCommands?.() ?? []).filter(c => c.name !== 'remote-control' && !names.has(c.name) && /^[A-Za-z0-9][\w:.-]{0,63}$/.test(c.name))
        .slice(0, 200).map(c => ({ name: c.name, description: terminalText(c.description ?? '').slice(0, 160), source: (['extension', 'prompt', 'skill'].includes(c.source) ? c.source : 'extension') as RemoteCommandInfo['source'] }));
    } catch { /* runtime replaced: built-ins only */ }
    return [...builtins, ...others];
  }

  private async runSlash(command: BridgeCommand, ctx: AttachContext): Promise<BridgeResult> {
    const base = { type: 'result' as const, commandId: command.commandId };
    const done = (output: CommandOutput, status: BridgeResult['status'] = 'completed'): BridgeResult => ({ ...base, status, output });
    const fail = (error: string): BridgeResult => ({ ...base, status: 'rejected', error });
    const text = String(command.payload?.text ?? '').trim();
    const match = /^\/([A-Za-z0-9][\w:.-]{0,63})(?:\s+([\s\S]*))?$/.exec(text);
    if (!match) return fail('Invalid command format.');
    const name = match[1]!, args = (match[2] ?? '').trim();
    const busy = !ctx.isIdle();
    switch (name.toLowerCase()) {
      case 'help':
        return done({ title: 'Commands', message: this.remoteCommands().map(c => `/${c.name}${c.hint ? ` ${c.hint}` : ''} — ${c.description}`).join('\n') });
      case 'stop':
        ctx.abort(); this.state = ctx.isIdle() ? 'idle' : 'stopping';
        ctx.ui.notify('A remote device asked Pi to stop. Queued messages were moved to the terminal editor.', 'warning');
        return done({ message: 'Stop request sent.' }, 'dispatched_unconfirmed');
      case 'session': {
        const usage = contextUsage(ctx);
        const lines = [
          `Session: ${ctx.sessionManager.getSessionName() ?? basename(ctx.cwd)}`,
          `Model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : 'none selected'} · thinking ${this.pi.getThinkingLevel()}`,
          usage ? `Context: ${usage.tokens === null ? '?' : usage.tokens.toLocaleString('en-US')} / ${usage.contextWindow.toLocaleString('en-US')} tokens${usage.percent === null ? '' : ` (${Math.round(usage.percent)}%)`}` : 'Context: unknown',
          `Folder: ${ctx.cwd}`, `ID: ${ctx.sessionManager.getSessionId()}`,
        ];
        return done({ title: 'Session info', message: lines.join('\n') });
      }
      case 'name':
        if (!args) return fail('Add a name, for example: /name Fix login');
        if (!this.pi.setSessionName) return fail('This Pi version does not support /name from a remote device.');
        this.pi.setSessionName(args.slice(0, 120));
        return done({ message: `Session name: ${args.slice(0, 120)}` });
      case 'thinking': {
        const current = this.pi.getThinkingLevel();
        if (!args) return done({ title: 'Thinking level', choices: THINKING_LEVELS.map(level => ({ label: level, value: `/thinking ${level}`, current: level === current })) });
        if (!THINKING_LEVELS.includes(args.toLowerCase())) return fail(`Unknown level. Choose one of: ${THINKING_LEVELS.join(', ')}`);
        if (!this.pi.setThinkingLevel) return fail('This Pi version does not support /thinking from a remote device.');
        this.pi.setThinkingLevel(args.toLowerCase());
        const actual = this.pi.getThinkingLevel();
        return done({ message: `Thinking: ${actual}${actual !== args.toLowerCase() ? ' (adjusted to what the model supports)' : ''}` });
      }
      case 'model': {
        const models = ctx.modelRegistry?.getAvailable() ?? [];
        if (!models.length || !this.pi.setModel) return fail('No model list is available in this session.');
        const key = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;
        const current = ctx.model ? key(ctx.model) : '';
        const choose = (list: typeof models, title: string): BridgeResult => done({ title, choices: [...list].sort((a, b) => Number(key(b) === current) - Number(key(a) === current) || key(a).localeCompare(key(b))).slice(0, 300).map(m => ({ label: key(m), value: `/model ${key(m)}`, detail: m.name && m.name !== m.id ? m.name : undefined, current: key(m) === current })) });
        if (!args) return choose(models, 'Choose a model');
        const query = args.toLowerCase();
        const exact = models.filter(m => key(m).toLowerCase() === query || m.id.toLowerCase() === query);
        const found = exact.length ? exact : models.filter(m => key(m).toLowerCase().includes(query) || (m.name ?? '').toLowerCase().includes(query));
        if (!found.length) return fail(`Model "${args}" not found. Type /model to see the list.`);
        if (found.length > 1) return choose(found, `Models matching "${args}"`);
        const model = found[0]!;
        if (!(await this.pi.setModel(model))) return fail(`Authentication for provider ${model.provider} is not set up in Pi.`);
        return done({ message: `Model: ${key(model)}${busy ? ' (applies from the next step)' : ''}` });
      }
      case 'compact':
        if (!ctx.compact) return fail('This Pi version does not support /compact from a remote device.');
        if (busy) return fail('Pi is working. Wait for it to finish or stop it first.');
        if (Date.now() < this.maintenanceUntil) return fail('Compaction is already running.');
        ctx.compact({
          ...(args ? { customInstructions: args } : {}),
          onComplete: () => this.activity(ctx, 'Compaction requested by a remote device finished.', 'info'),
          onError: error => ctx.ui.notify(`Compaction failed: ${error.message}`, 'error'),
        });
        this.activity(ctx, 'A remote device started compaction.', 'info');
        return done({ message: 'Compacting the context…' }, 'dispatched_unconfirmed');
      case 'new':
      case 'reload': {
        const commandCtx = this.global.commandCtx;
        if (!commandCtx?.newSession || !commandCtx.reload) return fail(`Run /remote-control once in the terminal to enable /${name} from your phone.`);
        if (busy) return fail('Pi is working. Wait for it to finish or stop it first.');
        if (name.toLowerCase() === 'new') {
          this.activity(ctx, 'A remote device started a new session.', 'info');
          const binding = this.global;
          void commandCtx.newSession({ withSession: async next => { binding.commandCtx = next; binding.refresh?.(); } }).catch(error => ctx.ui.notify(`New session failed: ${error instanceof Error ? error.message : error}`, 'error'));
          return done({ message: 'Starting a new session… this device follows automatically.' }, 'dispatched_unconfirmed');
        }
        this.activity(ctx, 'A remote device is reloading extensions.', 'info');
        void commandCtx.reload().catch(error => ctx.ui.notify(`Reload failed: ${error instanceof Error ? error.message : error}`, 'error'));
        return done({ message: 'Reloading extensions, skills and prompts…' }, 'dispatched_unconfirmed');
      }
      default: {
        if (TERMINAL_ONLY.has(name.toLowerCase())) return fail(`/${name} can only run in the Pi terminal.`);
        const known = this.remoteCommands().find(c => c.name === name && c.source !== 'remote');
        if (!known) return fail(`Unknown command /${name}. Type / to see the list.`);
        if (Date.now() < this.maintenanceUntil) return fail('Pi is compacting the context. Try again when compaction finishes.');
        // Pi itself runs extension commands and expands prompt templates and skills, exactly as typed in the TUI.
        this.pi.sendUserMessage(text, { expandPromptTemplates: true, ...(busy ? { deliverAs: 'followUp' as const } : {}) });
        this.activity(ctx, `A remote device ran /${name}.`, 'info');
        return done({ message: busy ? `/${name} will run when Pi finishes.` : `Running /${name}.` }, 'dispatched_unconfirmed');
      }
    }
  }

  /** At most one snapshot per 300 ms: building one walks the whole session inside Pi's event loop. */
  private scheduleSnapshot(): void {
    if (!this.enabled || this.snapshotTimer) return;
    const delay = Math.max(50, this.lastSnapshotAt + 300 - Date.now());
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = undefined;
      this.lastSnapshotAt = Date.now();
      if (this.enabled) this.send({ type: 'snapshot', session: this.snapshot() });
    }, delay);
    this.snapshotTimer.unref();
  }
}

/**
 * /remote-control detach: the same session continues in the background (tmux, or Pi RPC without tmux)
 * and this terminal Pi quits. The daemon starts the background Pi only after this process has exited,
 * so the session file never has two writers.
 */
async function detach(bridge: AttachBridge, ctx: AttachContext): Promise<void> {
  const file = ctx.sessionManager.getSessionFile?.();
  if (!file) throw new Error('This session is not saved to a file (--no-session), so it cannot move to the background.');
  if (!ctx.shutdown) throw new Error('This Pi version cannot quit from an extension.');
  if (!ctx.isIdle()) { ctx.ui.notify('Waiting for Pi to finish before moving to the background…', 'info'); await ctx.waitForIdle?.(); }
  if (!bridge.isConnected()) await bridge.start(ctx);
  const result = await bridge.admin('background.handoff', { cwd: ctx.cwd, sessionFile: file, pid: process.pid, sessionId: ctx.sessionManager.getSessionId() });
  const name = terminalText(result.name);
  const back = `/remote-control attach${result.attach ? ` (or ${terminalText(result.attach)})` : ''}`;
  ctx.ui.notify(`${result.fresh ? `This session was still empty, so a new background session was started in this folder (${name})` : `Session moved to the background (${name}). Your phone stays connected`}.\nBack to the terminal: ${back}\nClosing Pi in this terminal now.`, 'info');
  // Printed after Pi has restored the terminal, so the user sees how to come back.
  process.once('exit', () => { try { process.stderr.write(`\nPi keeps running in the background (${name}). To come back, start pi and run ${back}\n`); } catch { /* terminal gone */ } });
  setTimeout(() => ctx.shutdown?.(), 400).unref();
}

/**
 * /remote-control attach [show] [NAME]: pull a background session into this terminal Pi, or with
 * `show`, look at its TUI through tmux and come back with Ctrl-b d.
 */
async function attachBackground(bridge: AttachBridge, ctx: AttachContext, show: boolean, wanted?: string): Promise<void> {
  const state = await bridge.admin('background.list');
  const sessions: Record<string, any>[] = Array.isArray(state.sessions) ? state.sessions : [];
  if (!sessions.length) { ctx.ui.notify('No background sessions. Move one there with /remote-control detach, or start one from your phone (Background sessions menu).', 'info'); return; }
  // Several sessions often share a folder and title; the last request tells them apart.
  const label = (e: Record<string, any>) => {
    const what = e.preview ? `"${terminalText(e.preview)}"` : e.messageCount === 0 ? '(empty)' : terminalText(e.title || basename(String(e.cwd ?? '')) || e.name);
    const facts = [basename(String(e.cwd ?? '')), typeof e.messageCount === 'number' ? `${e.messageCount} msg` : '', ago(e.createdAt), e.workState && e.workState !== 'idle' ? 'working' : ''].filter(Boolean).map(terminalText);
    return `${what} — ${facts.join(' · ')} (${terminalText(e.name)})`;
  };
  let entry = wanted ? sessions.find(e => e.name === wanted) : sessions.length === 1 ? sessions[0] : undefined;
  if (!entry && !wanted && ctx.ui.select) {
    const choice = await ctx.ui.select(show ? 'Which background session do you want to view?' : 'Which background session should move to this terminal?', sessions.map(label));
    entry = sessions.find(e => label(e) === choice);
    if (!entry) return;
  }
  if (!entry) { ctx.ui.notify(wanted ? `Session ${terminalText(wanted)} not found.` : `Choose one by name: ${sessions.map(e => `/remote-control attach ${show ? 'show ' : ''}${terminalText(e.name)}`).join(', ')}`, 'warning'); return; }
  const name = String(entry.name);
  if (show) {
    if (entry.backend !== 'tmux') { ctx.ui.notify('attach show needs tmux (this session runs in RPC mode). Install tmux, or use /remote-control attach to move it here.', 'warning'); return; }
    if (process.env.TMUX) {
      // Already inside tmux: switch this client instead of nesting tmux in tmux.
      spawnSync('tmux', ['switch-client', '-t', `=${name}`], { stdio: 'ignore' });
      ctx.ui.notify(`Switched to ${name}. Come back to this Pi with Ctrl-b L.`, 'info');
      return;
    }
    if (!ctx.ui.custom) throw new Error('This Pi version cannot pause the screen.');
    await ctx.ui.custom<void>((tui, _theme, _keys, done) => {
      tui.stop();
      process.stdout.write('\x1b[2J\x1b[H');
      spawnSync('tmux', ['attach-session', '-t', `=${name}`], { stdio: 'inherit' });
      tui.start(); tui.requestRender?.(true);
      done(undefined);
      return { render: () => [], invalidate: () => {} };
    });
    ctx.ui.notify(`Back from ${name}. That session keeps running in the background.`, 'info');
    return;
  }
  const file = typeof entry.sessionFile === 'string' ? entry.sessionFile : undefined;
  // Pi writes a session file with its first message. A background session nobody used yet has no
  // file; switching to that path would make Pi start an unrelated new session there.
  const empty = !file || !existsSync(file);
  if (!empty && !ctx.switchSession) throw new Error('This Pi version cannot switch sessions from an extension.');
  if (entry.workState && entry.workState !== 'idle') {
    const choice = ctx.ui.select ? await ctx.ui.select('The background session is working', ['Wait until it finishes', 'Stop its work, then move', 'Cancel']) : 'Cancel';
    if (!choice || choice === 'Cancel') return;
    if (choice.startsWith('Wait')) {
      ctx.ui.notify('Waiting for the background session to finish…', 'info');
      for (let i = 0; i < 1200; i++) {
        await new Promise(resolve => setTimeout(resolve, 1500));
        const now = (await bridge.admin('background.list')).sessions?.find((e: any) => e.name === name);
        if (!now) break;
        if (!now.workState || now.workState === 'idle') break;
      }
    }
  }
  if (!ctx.isIdle()) await ctx.waitForIdle?.();
  ctx.ui.notify(`Closing ${name} in the background…`, 'info');
  await bridge.admin('background.release', { name, moving: !empty });
  if (empty) { ctx.ui.notify(`${name} had no messages yet, so it was closed. You stay in this session.`, 'info'); return; }
  bridge.keepRemoteEnabled();
  await ctx.switchSession!(file!);
}

/** Everything /remote-control can do, in the order Tab shows it. */
const SUBCOMMANDS: { value: string; description: string }[] = [
  { value: 'settings', description: 'Settings, status, devices and background sessions in one panel' },
  { value: 'pair', description: 'Show a QR to connect another phone or browser' },
  { value: 'pair wifi', description: 'QR for the Wi-Fi/LAN address, encrypted with a per-device key' },
  { value: 'detach', description: 'Keep this session running in the background and close Pi here' },
  { value: 'attach', description: 'Bring a background session into this terminal' },
  { value: 'attach show', description: 'Look at a background session (tmux); Ctrl-b d to come back' },
  { value: 'auto on', description: 'Every new Pi on this computer shows up on your phone' },
  { value: 'auto off', description: 'New Pi sessions need /remote-control again' },
  { value: 'status', description: 'Remote on or off, devices and address' },
  { value: 'devices', description: 'List connected devices' },
  { value: 'revoke', description: 'Remove a device: /remote-control revoke ID' },
  { value: 'stop', description: 'Turn off remote access for this session (Pi keeps working)' },
  { value: 'help', description: 'What /remote-control can do' },
];

/** Suggestions after `/remote-control `: options, plus real background sessions and devices from the daemon. */
export async function remoteControlCompletions(bridge: AttachBridge, prefix: string, cache: { at: number; key: string; items: CompletionItem[] } = { at: 0, key: '', items: [] }): Promise<CompletionItem[] | null> {
  const typed = prefix.replace(/^\s+/, '').replace(/\s+/g, ' ').toLowerCase();
  const auto = bridge.autoStart();
  let items: CompletionItem[] = SUBCOMMANDS.map(c => ({ value: c.value, label: c.value, description: c.value === `auto ${auto ? 'on' : 'off'}` ? `${c.description} (current)` : c.description }));
  // Only ask the daemon once the user is choosing a session or a device, and at most every 3 seconds.
  const want = /^attach /.test(typed) ? 'attach' : /^revoke( |$)/.test(typed) ? 'revoke' : '';
  if (want) {
    if (cache.key !== want || Date.now() - cache.at > 3000) {
      let dynamic: CompletionItem[] = [];
      try {
        const reply = await Promise.race([bridge.admin(want === 'attach' ? 'background.list' : 'status'), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('slow')), 1500).unref())]);
        if (want === 'attach') {
          for (const e of Array.isArray(reply.sessions) ? reply.sessions : []) {
            const name = terminalText(e.name);
            const about = [e.preview ? `"${terminalText(e.preview)}"` : e.messageCount === 0 ? '(empty)' : terminalText(e.title ?? ''), typeof e.messageCount === 'number' ? `${e.messageCount} msg` : '', ago(e.createdAt), e.workState && e.workState !== 'idle' ? 'working' : ''].filter(Boolean).join(' · ');
            dynamic.push({ value: `attach ${name}`, label: `attach ${name}`, description: about });
            if (e.backend === 'tmux') dynamic.push({ value: `attach show ${name}`, label: `attach show ${name}`, description: about });
          }
        } else {
          for (const d of Array.isArray(reply.devices) ? reply.devices.filter((d: any) => !d.revoked) : []) {
            const id = terminalText(String(d.clientId).slice(0, 8));
            dynamic.push({ value: `revoke ${id}`, label: `revoke ${id}`, description: `${terminalText(d.name)}${d.owner ? ' · owner' : ''}` });
          }
        }
      } catch { dynamic = []; /* daemon not running: the static options still help */ }
      cache.at = Date.now(); cache.key = want; cache.items = dynamic;
    }
    items = [...items, ...cache.items];
  }
  const starts = items.filter(i => i.value.startsWith(typed));
  const contains = typed ? items.filter(i => !i.value.startsWith(typed) && i.value.includes(typed)) : [];
  const result = [...starts, ...contains];
  return result.length ? result : null;
}

/** /remote-control help */
function remoteControlHelp(bridge: AttachBridge): string {
  const width = Math.max(...SUBCOMMANDS.map(c => c.value.length));
  return [
    'Remote Control: use this Pi session from your phone or another browser.',
    `  ${'(none)'.padEnd(width)}  Turn on remote for this session (QR the first time)`,
    ...SUBCOMMANDS.map(c => `  ${c.value.padEnd(width)}  ${c.description}`),
    `Auto mode is ${bridge.autoStart() ? 'on' : 'off'}. On the phone: chat, stop Pi, / commands (/model, /compact, /new…), files and photos.`,
    'Tip: type /remote-control and a space (or Tab) to pick an option.',
  ].join('\n');
}

export function installRemoteControl(pi: AttachPi, options: AttachOptions = {}): AttachBridge {
  const bridge = new AttachBridge(pi, options);
  const completionCache = { at: 0, key: '', items: [] as CompletionItem[] };
  pi.registerCommand('remote-control', {
    description: 'Use this session from your phone: pair, detach, attach, auto… (Tab for options)',
    getArgumentCompletions: prefix => remoteControlCompletions(bridge, prefix, completionCache),
    handler: async function handle(args: string, ctx: AttachContext): Promise<void> {
      const action = args.trim();
      if (ctx.mode !== 'tui') { ctx.ui.notify('The remote-control command is only available in the Pi terminal.', 'warning'); return; }
      bridge.setCommandContext(ctx);
      if (action === 'stop') {
        bridge.stop(); ctx.ui.notify('Remote access stopped. Pi keeps working.', 'info'); return;
      }
      try {
        if (action === 'status') {
          const result = bridge.isConnected() ? await bridge.admin('status') : {};
          const devices = Array.isArray(result.devices) ? result.devices.filter((d: any) => !d.revoked) : [];
          ctx.ui.notify(`${bridge.isEnabled() ? `Remote on · ${devices.length} ${devices.length === 1 ? 'device' : 'devices'} · ${preferredPhoneUrl(bridge.urls) ?? bridge.url}` : 'Remote off. Run /remote-control.'}${bridge.autoStart() ? ' · auto on' : ''}`, 'info'); return;
        }
        if (action === 'devices') {
          const result = await bridge.admin('status');
          const devices = (Array.isArray(result.devices) ? result.devices : []).filter((d: any) => !d.revoked);
          ctx.ui.notify(devices.length ? `Connected devices:\n${devices.map((d: any) => `  ${terminalText(d.name)}  (${terminalText(String(d.clientId).slice(0, 8))})`).join('\n')}\nRevoke: /remote-control revoke ID` : 'No devices connected yet.', 'info'); return;
        }
        const revoke = /^revoke\s+([a-f0-9-]{4,36})$/i.exec(action);
        if (revoke) { const result = await bridge.admin('revoke', { clientId: revoke[1]!.toLowerCase() }); ctx.ui.notify(`Access for "${terminalText(result.name)}" revoked.`, 'info'); return; }
        const auto = /^auto(?:\s+(on|off))?$/i.exec(action);
        if (auto) {
          const on = auto[1] ? auto[1].toLowerCase() === 'on' : !bridge.autoStart();
          bridge.setAutoStart(on);
          if (on && !bridge.isConnected()) await bridge.start(ctx);
          ctx.ui.notify(on ? 'Auto remote on: every new Pi session can be opened right away from your paired phones. Turn off: /remote-control auto off' : 'Auto remote off. New Pi sessions need /remote-control to show up on your phone.', 'info'); return;
        }
        if (action === 'detach') { await detach(bridge, ctx); return; }
        const attach = /^attach(?:\s+(show))?(?:\s+(pi-rc-[a-f0-9]{6}))?$/i.exec(action);
        if (attach) { await attachBackground(bridge, ctx, !!attach[1], attach[2]); return; }
        if (action === 'pair wifi' || action === 'wifi') {
          // Wi-Fi/LAN has no transport encryption: the QR carries a per-device key for the sealed path.
          if (!bridge.isConnected()) await bridge.start(ctx);
          const result = await bridge.admin('pair', { sessionIds: [ctx.sessionManager.getSessionId()], control: true, owner: true, wifi: true });
          const links = Array.isArray(result.urls) ? result.urls.filter((u: unknown) => typeof u === 'string' && /^http:\/\/[^/]+\/#w=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(u)) : [];
          if (!links.length) throw new Error('The daemon has no Wi-Fi/LAN address. Start the daemon with --host 0.0.0.0 --allow-http.');
          bridge.showPairing(ctx, preferLan(links), typeof result.expiresAt === 'number' ? result.expiresAt : Date.now() + 300_000);
          return;
        }
        if (action === 'help' || action === '?') { ctx.ui.notify(remoteControlHelp(bridge), 'info'); return; }
        if (action === 'settings' || action === 'config') {
          // Actions that need the terminal (QR, detach, attach) close the panel and run here.
          const next = await openSettingsPanel(bridge, ctx);
          if (next) await handle(next, ctx);
          return;
        }
        if (action && action !== 'pair' && action !== 'qr') { ctx.ui.notify(`Unknown option "${terminalText(action)}".\n${remoteControlHelp(bridge)}`, 'warning'); return; }
        if (!bridge.isConnected()) await bridge.start(ctx);
        if (!action) {
          // A phone paired once sees every exposed session, so only first-time setup needs a QR.
          const result = await bridge.admin('status');
          const phones = activeOwners(result.devices);
          if (phones.length) {
            ctx.ui.notify(`Remote on · ${deviceNames(phones)} can open this session (${preferredPhoneUrl(bridge.urls) ?? bridge.url}).\nNew device: /remote-control pair${bridge.autoStart() ? '' : ' · On for every session: /remote-control auto'}`, 'info');
            return;
          }
        }
        const result = await bridge.admin('pair', { sessionIds: [ctx.sessionManager.getSessionId()], control: true, owner: true });
        if (typeof result.token !== 'string') throw new Error('Daemon did not return a pairing token');
        bridge.showPairing(ctx, `${preferredPhoneUrl(bridge.urls) ?? bridge.url}/#pair=${encodeURIComponent(result.token)}`, typeof result.expiresAt === 'number' ? result.expiresAt : Date.now() + 300_000);
      } catch (error) { ctx.ui.notify(error instanceof Error ? error.message : 'Could not connect to the daemon', 'error'); }
    },
  });
  pi.on('session_start', async (_event, ctx) => {
    if (backgroundInfo()) {
      // Started by the daemon in the background: register right away, quietly, in TUI or RPC mode,
      // and keep trying while the daemon restarts.
      const attempt = async (): Promise<void> => { try { await bridge.start(ctx); } catch { setTimeout(() => void attempt(), 2000).unref(); } };
      await attempt();
      return;
    }
    const auto = ctx.mode === 'tui' && !bridge.wantsReconnect() && bridge.autoStart();
    if (ctx.mode === 'tui' && !auto) ctx.ui.notify('Remote Control available: /remote-control (Tab for options, /remote-control help)', 'info');
    if (ctx.mode === 'tui' && (bridge.wantsReconnect() || auto)) {
      try {
        await bridge.start(ctx);
        if (auto) ctx.ui.notify('Remote on automatically: this session can be opened from your phone.', 'info');
      } catch { ctx.ui.notify('Remote not connected. Make sure the daemon is running, then run /remote-control.', 'warning'); }
    } else bridge.bind(ctx);
  });
  pi.on('session_shutdown', event => { bridge.setCommandContext(undefined); bridge.stop(event.reason === 'quit'); });
  for (const name of ['agent_start', 'agent_end', 'agent_settled', 'message_start', 'message_update', 'message_end',
    'tool_execution_start', 'tool_execution_update', 'tool_execution_end', 'ui_prompt_start', 'ui_prompt_end',
    'session_tree', 'session_info_changed', 'session_before_compact', 'session_compact', 'session_compact_failed', 'session_before_tree',
    'model_select', 'thinking_level_select']) {
    pi.on(name, (event, ctx) => bridge.event(event, ctx));
  }
  return bridge;
}
