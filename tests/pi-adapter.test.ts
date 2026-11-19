import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AttachBridge, installRemoteControl, remoteControlCompletions, type AttachContext, type AttachPi, type CompletionItem } from '../src/pi/attach-bridge.js';
import { JsonLines, type BridgeCommand } from '../src/pi/types.js';

delete process.env.PI_REMOTE_AUTOSTART;
delete process.env.PI_REMOTE_BACKGROUND;
delete process.env.PI_REMOTE_BACKGROUND_BACKEND;

test('JSONL framing is LF-only and rejects oversize or non-object frames', () => {
  const records: unknown[] = [];
  const lines = new JsonLines(record => records.push(record), 80);
  lines.push('{"text":"first\u2028second"}\r'); lines.push('\n');
  assert.deepEqual(records, [{ text: 'first\u2028second' }]);
  assert.throws(() => lines.push('[]\n'), /JSON object/);
  assert.throws(() => new JsonLines(() => {}, 5).push('123456'), /limit/);
});

test('attach snapshots include live assistant/tool output and clone mutable stream messages', () => {
  const pi: AttachPi = { on: () => {}, registerCommand: () => {}, getThinkingLevel: () => 'medium', sendUserMessage: () => {} };
  const projected: unknown[] = [];
  const ctx: AttachContext = {
    mode: 'tui', cwd: '/tmp', isIdle: () => false, abort: () => {}, ui: { notify: () => {} },
    sessionManager: { getSessionId: () => 'stream-session', getLeafId: () => null, getSessionName: () => 'Streaming', buildSessionProjection: () => ({ messages: projected }) },
  };
  const bridge = new AttachBridge(pi, { binding: { runtimeId: 'stream-runtime', epoch: 0, enabled: false } });
  bridge.bind(ctx);
  const message = { role: 'assistant', timestamp: 123, content: [{ type: 'text', text: 'Working' }] };
  bridge.event({ type: 'message_start', message }, ctx);
  const first = bridge.snapshot();
  assert.equal((first.messages[0] as any).content[0].text, 'Working');
  message.content[0]!.text = 'Working with live tokens';
  bridge.event({ type: 'message_update', message }, ctx);
  assert.equal((bridge.snapshot().messages[0] as any).content[0].text, 'Working with live tokens');
  assert.equal((first.messages[0] as any).content[0].text, 'Working');
  projected.push(message);
  assert.equal(bridge.snapshot().messages.length, 1);
  bridge.event({ type: 'message_end', message }, ctx);
  assert.equal((bridge.snapshot().messages[0] as any).streaming, undefined);
  bridge.event({ type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash' }, ctx);
  bridge.event({ type: 'tool_execution_update', toolCallId: 'tool-1', toolName: 'bash', partialResult: { content: [{ type: 'text', text: 'test 1 passed' }] } }, ctx);
  const tool = bridge.snapshot().messages[1] as any;
  assert.equal(tool.role, 'toolResult'); assert.equal(tool.toolName, 'bash'); assert.equal(tool.content[0].text, 'test 1 passed');
  bridge.event({ type: 'tool_execution_end', toolCallId: 'tool-1', toolName: 'bash' }, ctx);
  assert.equal(bridge.snapshot().messages.length, 1);
  bridge.stop();
});

test('attach dispatches only through same live TUI API, rejects stale binding, and stop does not abort', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-attach-'));
  const socketPath = join(dir, 'bridge.sock'); const secretFile = join(dir, 'bridge.secret');
  await writeFile(secretFile, 'test-secret', { mode: 0o600 });
  let registration: Record<string, any> | undefined;
  const records: Record<string, any>[] = [];
  const server = createServer(socket => {
    socket.setEncoding('utf8'); const lines = new JsonLines(record => { records.push(record); if(record.type === 'register') { registration = record; socket.write('{"type":"registered"}\n'); } });
    socket.on('data', (chunk: string) => lines.push(chunk));
  });
  server.listen(socketPath); await once(server, 'listening');
  const sent: unknown[] = []; const notices: string[] = []; let aborts = 0; let idle = true;
  const pi: AttachPi = { on: () => {}, registerCommand: () => {}, getThinkingLevel: () => 'medium', sendUserMessage: (text, options) => { sent.push({ text, options }); } };
  const privateModel = { provider: 'test', id: 'model', headers: { authorization: 'private-provider-key' }, baseUrl: 'https://provider.invalid/private' };
  const ctx: AttachContext = {
    mode: 'tui', cwd: dir, model: privateModel, isIdle: () => idle, abort: () => { aborts++; }, ui: { notify: text => { notices.push(text); } },
    sessionManager: { getSessionId: () => 'same-session', getLeafId: () => 'leaf', getSessionName: () => 'Test', buildSessionProjection: () => ({ messages: [] }) },
  };
  const bridge = new AttachBridge(pi, { socketPath, secretFile, binding: { runtimeId: 'same-process', epoch: 0, enabled: false } });
  try {
    await bridge.start(ctx); await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(registration?.secret, 'test-secret'); assert.equal(registration?.session.sessionId, 'same-session');
    const session = bridge.snapshot();
    assert.deepEqual(session.model, { provider: 'test', id: 'model' });
    bridge.event({ type: 'model_select', model: privateModel, previousModel: privateModel, source: 'set' }, ctx);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(records.some(record => record.type === 'event' && record.event.type === 'model_select'));
    assert.ok(!JSON.stringify(records).includes('private-provider-key'));
    assert.ok(!JSON.stringify(records).includes('provider.invalid'));
    const command: BridgeCommand = { type: 'command', commandId: 'one', ...session, kind: 'prompt', payload: { text: 'do work' } };
    assert.equal(bridge.handleCommand(command).status, 'dispatched_unconfirmed');
    assert.equal(sent.length, 1);
    idle = false;
    assert.equal(bridge.handleCommand({ ...command, commandId: 'busy' }).status, 'rejected');
    assert.equal(bridge.handleCommand({ ...command, commandId: 'steer', kind: 'steer' }).status, 'dispatched_unconfirmed');
    assert.equal(sent.length, 2);
    assert.ok(notices.some(n => n.includes('remote device sent as a steering message')), 'the terminal sees remote-originated input');
    // Pi rejects prompts during compaction only inside the terminal; the bridge must refuse up front.
    bridge.event({ type: 'session_before_compact' }, ctx);
    const compacting = bridge.handleCommand({ ...command, commandId: 'during-compaction', kind: 'follow_up' });
    assert.equal(compacting.status, 'rejected'); assert.match(String(compacting.error), /compaction/);
    assert.equal(sent.length, 2);
    bridge.event({ type: 'session_compact' }, ctx);
    assert.equal(bridge.handleCommand({ ...command, commandId: 'after-compaction', kind: 'follow_up' }).status, 'dispatched_unconfirmed');
    assert.equal(sent.length, 3);
    // Per-token updates are not serialised over IPC; snapshots are throttled instead.
    await new Promise(resolve => setTimeout(resolve, 400));
    const before = records.filter(r => r.type === 'event').length;
    const snapshotsBefore = records.filter(r => r.type === 'snapshot').length;
    for (let i = 0; i < 50; i++) bridge.event({ type: 'message_update', message: { role: 'assistant', content: 'x'.repeat(i * 100), timestamp: 1 } }, ctx);
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.equal(records.filter(r => r.type === 'event').length, before);
    const snapshots = records.filter(r => r.type === 'snapshot').length - snapshotsBefore;
    assert.ok(snapshots >= 1 && snapshots <= 3, `snapshots are throttled (${snapshots})`);
    bridge.bind(ctx);
    assert.equal(bridge.handleCommand({ ...command, kind: 'abort' }).status, 'stale_context');
    bridge.stop(); assert.equal(aborts, 0);
  } finally {
    bridge.stop(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('TUI startup advertises the command without exposing a session; /remote-control shows one QR link and manages devices', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-pair-'));
  const socketPath = join(dir, 'bridge.sock'), secretFile = join(dir, 'bridge.secret');
  await writeFile(secretFile, 'private-ipc-test-secret', { mode: 0o600 });
  const records: Record<string, any>[] = [];
  const server = createServer(socket => {
    socket.setEncoding('utf8'); socket.on('error', () => {});
    const lines = new JsonLines(record => {
      records.push(record);
      if (record.type === 'register') socket.write(JSON.stringify({ type: 'registered', url: 'http://10.91.128.250:3141', urls: ['http://10.91.128.250:3141', 'http://100.74.43.35:3141', 'javascript:alert(1)', 'http://127.0.0.1:3141'] }) + '\n');
      if (record.type !== 'admin') return;
      if (record.action === 'pair') socket.end(JSON.stringify({ token: 'single-use-token', requestId: 'r', expiresAt: Date.now() + 300_000 }) + '\n');
      if (record.action === 'status') socket.end(JSON.stringify({ devices: [{ name: 'Phone\u001b[31m', clientId: 'abcdef12-0000-4000-8000-000000000000', revoked: false }, { name: 'Old', clientId: 'ffffffff-0000-4000-8000-000000000000', revoked: true }] }) + '\n');
      if (record.action === 'revoke') socket.end(JSON.stringify({ status: 'revoked', clientId: 'abcdef12-0000-4000-8000-000000000000', name: 'Phone' }) + '\n');
    });
    socket.on('data', (chunk: string) => lines.push(chunk));
  });
  server.listen(socketPath); await once(server, 'listening');
  const notices: string[] = [], events = new Map<string, (event: Record<string, any>, ctx: AttachContext) => void | Promise<void>>();
  let command!: (args: string, ctx: AttachContext) => Promise<void>;
  const pi: AttachPi = {
    on: (event, handler) => { events.set(event, handler); },
    registerCommand: (_name, definition) => { command = definition.handler; },
    sendUserMessage: () => { throw new Error('Pairing must not invoke inference'); }, getThinkingLevel: () => 'off',
  };
  const ctx: AttachContext = {
    mode: 'tui', cwd: dir, isIdle: () => true, abort: () => {}, ui: { notify: text => { notices.push(text); } },
    sessionManager: { getSessionId: () => 'current-session-only', getLeafId: () => null, getSessionName: () => 'Pair test', buildSessionProjection: () => ({ messages: [] }) },
  };
  const bridge = installRemoteControl(pi, { socketPath, secretFile, url: 'https://old.example', binding: { runtimeId: 'pair-runtime', epoch: 0, enabled: false } });
  try {
    await events.get('session_start')!({ type: 'session_start', reason: 'startup' }, ctx);
    assert.equal(notices[0], 'Remote Control available: /remote-control (Tab for options, /remote-control help)');
    assert.equal(records.length, 0); assert.equal(bridge.isEnabled(), false);
    await command('', ctx);
    assert.equal(bridge.url, 'http://10.91.128.250:3141');
    assert.deepEqual(bridge.urls, ['http://10.91.128.250:3141', 'http://100.74.43.35:3141', 'http://127.0.0.1:3141']);
    // Without a widget API the single best link (Tailscale) is shown, not a wall of URLs.
    assert.equal(notices.at(-1), 'Open on your phone: http://100.74.43.35:3141/#pair=single-use-token');
    const pairs = () => records.filter(r => r.type === 'admin' && r.action === 'pair');
    assert.deepEqual(pairs()[0]?.sessionIds, ['current-session-only']);
    assert.equal(pairs()[0]?.control, true); assert.equal(pairs()[0]?.owner, true);
    await command('pair', ctx); assert.equal(pairs().length, 2);
    assert.equal(records.filter(r => r.type === 'register').length, 1);
    await command('devices', ctx);
    assert.match(notices.at(-1)!, /Phone .*abcdef12/); assert.ok(!notices.at(-1)!.includes('\u001b')); assert.ok(!notices.at(-1)!.includes('Old'));
    await command('revoke abcdef12', ctx);
    assert.equal(records.findLast(r => r.action === 'revoke')?.clientId, 'abcdef12'); assert.match(notices.at(-1)!, /Phone.*revoked/);
    await command('approve 123456', ctx); assert.match(notices.at(-1)!, /Unknown option "approve 123456"/);
    const count = records.length;
    await command('pair', { ...ctx, mode: 'rpc' }); assert.equal(records.length, count); assert.ok(notices.at(-1)?.includes('Pi terminal'));
    assert.ok(!notices.join('\n').includes('private-ipc-test-secret'));
  } finally {
    bridge.stop(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true });
  }
});

test('real Pi discovers installed package commands without an explicit extension flag', {
  skip: process.env.PI_REMOTE_REAL_SMOKE !== '1', timeout: 20_000,
}, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-package-discovery-'));
  const packageRoot = fileURLToPath(new URL('../', import.meta.url));
  await writeFile(join(dir, 'settings.json'), JSON.stringify({ packages: [packageRoot] }));
  const child = spawn('pi', ['--mode', 'rpc', '--offline', '--no-session', '--no-mcp', '--no-skills', '--no-prompt-templates', '--no-context-files', '--no-themes', '--no-tools', '--no-approve'], {
    cwd: dir, env: { ...process.env, PI_CODING_AGENT_DIR: dir, PI_OFFLINE: '1' }, stdio: 'pipe',
  });
  let exited = false;
  const closed = new Promise<void>(resolve => child.once('close', () => { exited = true; resolve(); }));
  child.stdout.setEncoding('utf8'); child.stderr.on('data', () => {});
  try {
    const commands = await new Promise<Record<string, any>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Pi package discovery timed out')), 15_000);
      const done = (error?: Error, data?: Record<string, any>) => { clearTimeout(timer); if (error) reject(error); else resolve(data!); };
      const lines = new JsonLines(record => {
        if (record.type === 'response' && record.id === 'package-discovery') {
          if (record.success === true) done(undefined, record.data as Record<string, any>);
          else done(new Error('Pi get_commands rejected'));
        }
      });
      child.stdout.on('data', (chunk: string) => { try { lines.push(chunk); } catch { done(new Error('Invalid Pi stream')); } });
      child.once('error', () => done(new Error('Unable to start Pi')));
      child.once('close', () => done(new Error('Pi exited before command discovery')));
      child.stdin.on('error', () => done(new Error('Pi stdin closed')));
      child.stdin.write('{"type":"get_commands","id":"package-discovery"}\n');
    });
    assert.ok(commands.commands.some((command: any) => command.name === 'remote-control' && command.source === 'extension'));
  } finally {
    child.stdin.end();
    const terminate = setTimeout(() => { if (!exited) child.kill('SIGTERM'); }, 1000);
    const kill = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, 2500);
    await closed; clearTimeout(terminate); clearTimeout(kill);
    await rm(dir, { recursive: true, force: true });
  }
});

test('pairing QR is a valid QR matrix rendered black-on-white and prefers the Tailscale URL', async () => {
  const { qrMatrix, renderQr, qrWidth, preferredPhoneUrl } = await import('../src/pi/qr.js');
  const link = 'http://100.74.43.35:3141/#pair=' + 'A'.repeat(43);
  const m = qrMatrix(link);
  assert.equal((m.length - 17) % 4, 0, 'QR size is 17 + 4 * version');
  for (const [r, c] of [[0, 0], [0, m.length - 7], [m.length - 7, 0]] as const) {
    // Finder pattern: dark 7x7 ring, light ring inside, dark 3x3 centre.
    assert.equal(m[r]![c], true); assert.equal(m[r + 6]![c + 6], true);
    assert.equal(m[r + 1]![c + 1], false); assert.equal(m[r + 3]![c + 3], true);
  }
  const lines = renderQr(link);
  assert.equal(lines.length, Math.ceil(qrWidth(link) / 2));
  const visible = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, '');
  for (const line of lines) { assert.equal(visible(line).length, qrWidth(link)); assert.ok(line.includes('\u001b[48;5;231m')); }
  assert.equal(preferredPhoneUrl(['http://10.91.128.250:3141', 'http://100.74.43.35:3141', 'http://127.0.0.1:3141']), 'http://100.74.43.35:3141');
  assert.equal(preferredPhoneUrl(['http://127.0.0.1:3141', 'http://192.168.1.4:3141']), 'http://192.168.1.4:3141');
  assert.equal(preferredPhoneUrl(['http://100.74.43.35:3141', 'https://box.tail6bcbc1.ts.net']), 'https://box.tail6bcbc1.ts.net');
});

test('/remote-control shows a QR widget that fits the terminal and is replaced by a notice when a phone joins', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-qr-'));
  const socketPath = join(dir, 'bridge.sock'); const secretFile = join(dir, 'bridge.secret');
  await writeFile(secretFile, 'qr-secret', { mode: 0o600 });
  let ipc: import('node:net').Socket | undefined;
  let phones: Record<string, unknown>[] = [{ name: 'Old phone', clientId: 'x', owner: true, revoked: true }, { name: 'Expired', clientId: 'y', owner: true, revoked: false, expiresAt: 1 }];
  const server = createServer(socket => {
    socket.setEncoding('utf8'); socket.on('error', () => {});
    const lines = new JsonLines(record => {
      if (record.type === 'register') { ipc = socket; socket.write(JSON.stringify({ type: 'registered', url: 'http://10.91.128.250:3141', urls: ['http://10.91.128.250:3141', 'http://100.74.43.35:3141'] }) + '\n'); }
      if (record.type === 'admin' && record.action === 'pair') socket.end(JSON.stringify({ token: 'qr-token', requestId: 'r', expiresAt: Date.now() + 300_000 }) + '\n');
      if (record.type === 'admin' && record.action === 'status') socket.end(JSON.stringify({ devices: phones }) + '\n');
    });
    socket.on('data', (chunk: string) => lines.push(chunk));
  });
  server.listen(socketPath); await once(server, 'listening');
  const notices: string[] = []; const widgets = new Map<string, unknown>();
  let command!: (args: string, ctx: AttachContext) => Promise<void>;
  const pi: AttachPi = { on: () => {}, registerCommand: (_n, d) => { command = d.handler; }, sendUserMessage: () => {}, getThinkingLevel: () => 'off' };
  const ctx: AttachContext = {
    mode: 'tui', cwd: dir, isIdle: () => true, abort: () => {},
    ui: { notify: text => { notices.push(text); }, setWidget: (key, content) => { if (content) widgets.set(key, content); else widgets.delete(key); } },
    sessionManager: { getSessionId: () => 'qr-session', getLeafId: () => null, getSessionName: () => 'QR', buildSessionProjection: () => ({ messages: [] }) },
  };
  const bridge = installRemoteControl(pi, { socketPath, secretFile, binding: { runtimeId: 'qr-runtime', epoch: 0, enabled: false } });
  try {
    await command('', ctx);
    assert.equal(notices.length, 0, 'no wall of text: the widget is the whole UI');
    const factory = widgets.get('remote-control-pair') as (tui: unknown, theme: unknown) => { render(width: number): string[] };
    assert.ok(factory, 'QR widget shown');
    const theme = { fg: (_c: string, t: string) => `<${t}>`, bold: (t: string) => t };
    const visible = (line: string) => line.replace(/\u001b\[[0-9;]*m/g, '').replace(/[<>]/g, '');
    for (const width of [120, 60, 46, 30]) {
      const lines = factory(undefined, theme).render(width);
      for (const line of lines) assert.ok(visible(line).length <= width, `line fits width ${width}: ${visible(line)}`);
      assert.equal(lines.map(visible).join('').replace(/\s/g, '').includes('100.74.43.35:3141/#pair=qr-token'), true, 'the Tailscale link is shown');
    }
    assert.ok(factory(undefined, theme).render(120).filter(l => l.includes('\u001b[48;5;231m')).length > 10, 'QR is not truncated to the 10-line string widget cap');
    const short = factory({ terminal: { rows: 24 } }, theme).render(120);
    assert.ok(!short.some(l => l.includes('\u001b[48;5;231m')) && short.map(visible).join('').includes('qr-token'), 'a short terminal shows the link instead of a clipped QR');
    assert.match(visible(factory(undefined, theme).render(120)[1]!), /100\.74\.43\.35:3141\/#pair=qr-token/, 'the link comes before the QR');
    assert.ok(!factory(undefined, theme).render(30).some(l => l.includes('\u001b[48;5;231m')), 'too narrow for a QR: link only');
    ipc!.write(JSON.stringify({ type: 'paired', name: 'iPhone · Safari' }) + '\n');
    for (let i = 0; i < 40 && !notices.length; i++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.match(notices.at(-1)!, /iPhone · Safari connected/);
    assert.equal(widgets.has('remote-control-pair'), false, 'QR is removed once a phone joins');
    // Once a phone is paired, /remote-control in a new session just exposes it: no QR to scan again.
    phones = [{ name: 'iPhone · Safari', clientId: 'p1', owner: true, revoked: false, expiresAt: Date.now() + 86_400_000 }, { name: 'iPhone · Safari', clientId: 'p2', owner: true, revoked: false }];
    await command('', ctx);
    assert.equal(widgets.has('remote-control-pair'), false);
    assert.match(notices.at(-1)!, /Remote on · iPhone · Safari \(2\) can open this session/);
    await command('pair', ctx);
    assert.ok(widgets.has('remote-control-pair'), '/remote-control pair always shows a QR for a new device');
  } finally {
    bridge.stop(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true });
  }
});

test('remote slash commands: built-ins, pickers, Pi extension commands, and terminal-only refusals', async () => {
  const sent: { text: string; options: unknown }[] = []; const notices: string[] = [];
  let thinking = 'medium'; let model = { provider: 'acme', id: 'acme-pro' }; let name = ''; let compacted: unknown; let newSessions = 0;
  const models = [{ provider: 'acme', id: 'acme-pro', name: 'Pro' }, { provider: 'acme', id: 'acme-lite', name: 'Lite' }, { provider: 'openai', id: 'gpt-x' }];
  const pi: AttachPi = {
    on: () => {}, registerCommand: () => {}, getThinkingLevel: () => thinking,
    sendUserMessage: (text, options) => { sent.push({ text: String(text), options }); },
    getCommands: () => [{ name: 'remote-control', source: 'extension' }, { name: 'commit', description: 'Buat commit', source: 'prompt' }, { name: 'skill:review', source: 'skill' }, { name: 'model', source: 'extension' }],
    setModel: async (m: any) => { if (m.provider === 'openai') return false; model = m; return true; },
    setThinkingLevel: level => { thinking = level === 'max' ? 'xhigh' : level; },
    setSessionName: value => { name = value; },
  };
  let idle = true;
  const ctx: AttachContext = {
    mode: 'tui', cwd: '/tmp/proj', isIdle: () => idle, abort: () => {}, ui: { notify: text => { notices.push(text); } },
    get model() { return model; },
    modelRegistry: { getAvailable: () => models },
    compact: options => { compacted = options; },
    getContextUsage: () => ({ tokens: 42_000, contextWindow: 200_000, percent: 21 }),
    sessionManager: { getSessionId: () => 'slash-session', getLeafId: () => null, getSessionName: () => name || undefined, buildSessionProjection: () => ({ messages: [] }) },
  };
  const bridge = new AttachBridge(pi, { socketPath: '/nonexistent/sock', secretFile: '/nonexistent/secret', binding: { runtimeId: 'slash-runtime', epoch: 0, enabled: false } });
  bridge.bind(ctx);
  const session = bridge.snapshot();
  const run = async (text: string) => (bridge as any).runSlash({ type: 'command', commandId: `c-${text}`, ...session, kind: 'command', payload: { text } }, ctx);
  try {
    const names = (session.commands ?? []).map(c => c.name);
    assert.ok(names.includes('model') && names.includes('commit') && names.includes('skill:review'));
    assert.ok(!names.includes('remote-control'), 'the bridge never exposes itself');
    assert.equal(names.filter(n => n === 'model').length, 1, 'built-ins win over same-named commands');
    assert.ok(!names.includes('new'), '/new needs a command context from the terminal');
    assert.deepEqual((session as any).usage, { tokens: 42_000, contextWindow: 200_000, percent: 21 });

    const picker = await run('/model');
    assert.equal(picker.status, 'completed'); assert.equal(picker.output.choices[0].label, 'acme/acme-pro'); assert.equal(picker.output.choices[0].current, true);
    assert.equal((await run('/model lite')).output.message, 'Model: acme/acme-lite'); assert.equal(model.id, 'acme-lite');
    assert.equal((await run('/model acme')).output.choices.length, 2, 'ambiguous query opens a filtered picker');
    assert.match((await run('/model gpt-x')).error, /Authentication for provider openai/);
    assert.match((await run('/model nope')).error, /not found/);
    assert.equal((await run('/thinking')).output.choices.find((c: any) => c.current).label, 'medium');
    assert.match((await run('/thinking max')).output.message, /xhigh \(adjusted/);
    assert.match((await run('/thinking turbo')).error, /Unknown level/);
    assert.equal((await run('/name Fix login')).output.message, 'Session name: Fix login'); assert.equal(name, 'Fix login');
    assert.match((await run('/session')).output.message, /42,000 \/ 200,000 tokens \(21%\)/);
    assert.equal((await run('/compact focus on auth')).status, 'dispatched_unconfirmed'); assert.deepEqual((compacted as any).customInstructions, 'focus on auth');
    idle = false;
    assert.match((await run('/compact')).error, /Pi is working/);
    assert.match((await run('/new')).error, /Run \/remote-control once in the terminal/);
    assert.match((await run('/settings')).error, /can only run in the Pi terminal/);
    assert.match((await run('/remote-control stop')).error, /can only run in the Pi terminal/);
    assert.match((await run('/nosuchcommand')).error, /Unknown command \/nosuchcommand/);
    assert.equal((await run('/commit tidy message')).status, 'dispatched_unconfirmed');
    assert.deepEqual(sent.at(-1), { text: '/commit tidy message', options: { expandPromptTemplates: true, deliverAs: 'followUp' } }, 'Pi expands templates/extension commands itself; queued while busy');
    idle = true;
    bridge.setCommandContext({ ...ctx, newSession: async (options?: any) => { newSessions++; await options?.withSession?.({ ...ctx }); }, reload: async () => {} });
    assert.ok((bridge.remoteCommands()).some(c => c.name === 'new'));
    assert.equal((await run('/new')).status, 'dispatched_unconfirmed'); await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(newSessions, 1);
    assert.ok(notices.some(n => n.includes('started a new session')));
  } finally { bridge.stop(); }
});

test('/remote-control auto makes every new Pi session register by itself, and can be switched off', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-auto-'));
  const socketPath = join(dir, 'bridge.sock'); const secretFile = join(dir, 'bridge.secret');
  await writeFile(secretFile, 'auto-secret', { mode: 0o600 });
  const registered: string[] = [];
  const server = createServer(socket => {
    socket.setEncoding('utf8'); socket.on('error', () => {});
    const lines = new JsonLines(record => {
      if (record.type === 'register') { registered.push((record.session as { sessionId: string }).sessionId); socket.write('{"type":"registered"}\n'); }
      if (record.type === 'admin') socket.end(JSON.stringify({ devices: [] }) + '\n');
    });
    socket.on('data', (chunk: string) => lines.push(chunk));
  });
  server.listen(socketPath); await once(server, 'listening');
  const notices: string[] = []; let sessionId = 'first';
  const events = new Map<string, (event: Record<string, any>, ctx: AttachContext) => void | Promise<void>>();
  let command!: (args: string, ctx: AttachContext) => Promise<void>;
  const pi: AttachPi = { on: (e, h) => { events.set(e, h); }, registerCommand: (_n, d) => { command = d.handler; }, sendUserMessage: () => {}, getThinkingLevel: () => 'off' };
  const ctx: AttachContext = {
    mode: 'tui', cwd: dir, isIdle: () => true, abort: () => {}, ui: { notify: text => { notices.push(text); } },
    sessionManager: { getSessionId: () => sessionId, getLeafId: () => null, getSessionName: () => undefined, buildSessionProjection: () => ({ messages: [] }) },
  };
  const binding = { runtimeId: 'auto-runtime', epoch: 0, enabled: false };
  let bridge = installRemoteControl(pi, { socketPath, secretFile, binding });
  try {
    await command('auto', ctx);
    assert.match(notices.at(-1)!, /Auto remote on/);
    assert.equal(registered.length, 1);
    // A brand-new Pi process: the binding is fresh (not enabled), only the auto flag survives.
    bridge.stop(); registered.length = 0; sessionId = 'second';
    bridge = installRemoteControl(pi, { socketPath, secretFile, binding: { runtimeId: 'other-process', epoch: 0, enabled: false } });
    await events.get('session_start')!({ type: 'session_start', reason: 'startup' }, ctx);
    assert.deepEqual(registered, ['second'], 'registered without typing /remote-control');
    assert.match(notices.at(-1)!, /Remote on automatically/);
    await command('auto off', ctx);
    bridge.stop(); registered.length = 0;
    bridge = installRemoteControl(pi, { socketPath, secretFile, binding: { runtimeId: 'third-process', epoch: 0, enabled: false } });
    await events.get('session_start')!({ type: 'session_start', reason: 'startup' }, ctx);
    assert.deepEqual(registered, [], 'auto off: nothing is exposed until /remote-control');
    assert.equal(notices.at(-1), 'Remote Control available: /remote-control (Tab for options, /remote-control help)');
  } finally {
    bridge.stop(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true });
  }
});

test('/remote-control pair wifi shows a QR with the sealed-key link to a private LAN address', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-wifi-'));
  const socketPath = join(dir, 'bridge.sock'); const secretFile = join(dir, 'bridge.secret');
  await writeFile(secretFile, 'wifi-secret', { mode: 0o600 });
  const asked: Record<string, any>[] = [];
  const server = createServer(socket => {
    socket.setEncoding('utf8'); socket.on('error', () => {});
    const lines = new JsonLines(record => {
      if (record.type === 'register') socket.write('{"type":"registered","urls":["http://100.74.43.35:3141"]}\n');
      if (record.type === 'admin') { asked.push(record); socket.end(JSON.stringify({ requestId: 'req12', expiresAt: Date.now() + 300_000, urls: ['http://172.17.0.1:3141/#w=req12.KEY_abc-123', 'http://10.91.128.250:3141/#w=req12.KEY_abc-123', 'javascript:alert(1)#w=a.b'] }) + '\n'); }
    });
    socket.on('data', (chunk: string) => lines.push(chunk));
  });
  server.listen(socketPath); await once(server, 'listening');
  const widgets = new Map<string, unknown>(); const notices: string[] = [];
  let command!: (args: string, ctx: AttachContext) => Promise<void>;
  const pi: AttachPi = { on: () => {}, registerCommand: (_n, d) => { command = d.handler; }, sendUserMessage: () => {}, getThinkingLevel: () => 'off' };
  const ctx: AttachContext = {
    mode: 'tui', cwd: dir, isIdle: () => true, abort: () => {},
    ui: { notify: text => { notices.push(text); }, setWidget: (key, content) => { if (content) widgets.set(key, content); else widgets.delete(key); } },
    sessionManager: { getSessionId: () => 'wifi-session', getLeafId: () => null, getSessionName: () => 'W', buildSessionProjection: () => ({ messages: [] }) },
  };
  const bridge = installRemoteControl(pi, { socketPath, secretFile, binding: { runtimeId: 'wifi-runtime', epoch: 0, enabled: false } });
  try {
    await command('pair wifi', ctx);
    assert.equal(asked[0]?.action, 'pair'); assert.equal(asked[0]?.wifi, true); assert.equal(asked[0]?.owner, true);
    const factory = widgets.get('remote-control-pair') as (tui: unknown, theme: unknown) => { render(width: number): string[] };
    const lines = factory(undefined, undefined).render(100).map(l => l.replace(/\u001b\[[0-9;]*m/g, ''));
    assert.match(lines[0]!, /same Wi-Fi \(encrypted\)/);
    assert.ok(lines.join('').includes('http://10.91.128.250:3141/#w=req12.KEY_abc-123'), 'a private LAN address is preferred over a container bridge');
    assert.equal(notices.length, 0);
  } finally {
    bridge.stop(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true });
  }
});

async function fakeDaemon(onAdmin: (record: Record<string, any>) => unknown) {
  const dir = await mkdtemp(join(tmpdir(), 'pi-bg-'));
  const socketPath = join(dir, 'bridge.sock'); const secretFile = join(dir, 'bridge.secret');
  await writeFile(secretFile, 'bg-secret', { mode: 0o600 });
  const records: Record<string, any>[] = []; let ipc: import('node:net').Socket | undefined;
  const server = createServer(socket => {
    socket.setEncoding('utf8'); socket.on('error', () => {});
    const lines = new JsonLines(record => {
      records.push(record);
      if (record.type === 'register') { ipc = socket; socket.write('{"type":"registered"}\n'); }
      if (record.type === 'admin') socket.end(JSON.stringify(onAdmin(record) ?? {}) + '\n');
    });
    socket.on('data', (chunk: string) => lines.push(chunk));
  });
  server.listen(socketPath); await once(server, 'listening');
  return { dir, socketPath, secretFile, records, ipc: () => ipc, close: async () => { await new Promise<void>(r => server.close(() => r())); await rm(dir, { recursive: true, force: true }); } };
}

test('/remote-control detach hands the session file to the daemon with this PID, then quits Pi', async () => {
  const daemon = await fakeDaemon(r => r.action === 'background.handoff' ? { name: 'pi-rc-abc123', backend: 'tmux', attach: 'tmux attach -t pi-rc-abc123' } : {});
  const notices: string[] = []; let shutdowns = 0; let command!: (args: string, ctx: AttachContext) => Promise<void>;
  const pi: AttachPi = { on: () => {}, registerCommand: (_n, d) => { command = d.handler; }, sendUserMessage: () => {}, getThinkingLevel: () => 'off' };
  let file: string | undefined = '/home/u/.pi/agent/sessions/x.jsonl';
  const ctx: AttachContext = {
    mode: 'tui', cwd: '/home/u/proj', isIdle: () => true, abort: () => {}, shutdown: () => { shutdowns++; },
    ui: { notify: text => { notices.push(text); } },
    sessionManager: { getSessionId: () => 'detach-me', getLeafId: () => null, getSessionName: () => 'D', getSessionFile: () => file, buildSessionProjection: () => ({ messages: [] }) },
  };
  const bridge = installRemoteControl(pi, { socketPath: daemon.socketPath, secretFile: daemon.secretFile, binding: { runtimeId: 'detach-runtime', epoch: 0, enabled: false } });
  try {
    await command('detach', ctx);
    const handoff = daemon.records.find(r => r.action === 'background.handoff')!;
    assert.deepEqual({ cwd: handoff.cwd, sessionFile: handoff.sessionFile, pid: handoff.pid }, { cwd: '/home/u/proj', sessionFile: file, pid: process.pid });
    assert.match(notices.at(-1)!, /moved to the background \(pi-rc-abc123\)/); assert.match(notices.at(-1)!, /tmux attach -t pi-rc-abc123/);
    await new Promise(r => setTimeout(r, 500));
    assert.equal(shutdowns, 1, 'the terminal Pi quits so only the background Pi writes the session');
    file = undefined;
    await command('detach', ctx);
    assert.match(notices.at(-1)!, /--no-session/);
  } finally { bridge.stop(); await daemon.close(); }
});

test('/remote-control attach releases the background session, then switches this Pi to its file with remote kept on', async () => {
  const files = await mkdtemp(join(tmpdir(), 'pi-attach-files-'));
  await writeFile(join(files, 'a.jsonl'), '{}\n'); await writeFile(join(files, 'b.jsonl'), '{}\n');
  const list = [
    { name: 'pi-rc-aaaaaa', backend: 'tmux', cwd: '/home/u/a', title: 'proj', workState: 'idle', sessionFile: join(files, 'a.jsonl'), messageCount: 8, preview: 'fix the login bug', createdAt: Date.now() - 5 * 60_000 },
    { name: 'pi-rc-bbbbbb', backend: 'rpc', cwd: '/home/u/a', title: 'proj', workState: 'idle', sessionFile: join(files, 'b.jsonl'), messageCount: 3, preview: 'write the release notes', createdAt: Date.now() - 2 * 3600_000 },
    { name: 'pi-rc-cccccc', backend: 'tmux', cwd: '/home/u/a', title: 'proj', workState: 'idle', sessionFile: join(files, 'never-written.jsonl'), messageCount: 0 },
  ];
  let offered: string[] = []; let pick = 'pi-rc-bbbbbb';
  const daemon = await fakeDaemon(r => r.action === 'background.list' ? { sessions: list } : r.action === 'background.release' ? { status: 'released' } : {});
  const notices: string[] = []; const switched: string[] = []; let command!: (args: string, ctx: AttachContext) => Promise<void>;
  const pi: AttachPi = { on: () => {}, registerCommand: (_n, d) => { command = d.handler; }, sendUserMessage: () => {}, getThinkingLevel: () => 'off' };
  const binding = { runtimeId: 'attach-runtime', epoch: 0, enabled: false };
  const ctx: AttachContext = {
    mode: 'tui', cwd: '/home/u', isIdle: () => true, abort: () => {},
    switchSession: async path => { switched.push(path); },
    ui: { notify: text => { notices.push(text); }, select: async (_title, options) => { offered = options; return options.find(o => o.includes(pick)); } },
    sessionManager: { getSessionId: () => 'here', getLeafId: () => null, getSessionName: () => 'H', buildSessionProjection: () => ({ messages: [] }) },
  };
  const bridge = installRemoteControl(pi, { socketPath: daemon.socketPath, secretFile: daemon.secretFile, binding });
  try {
    await command('attach', ctx);
    assert.deepEqual(daemon.records.filter(r => r.action === 'background.release').map(r => r.name), ['pi-rc-bbbbbb'], 'the picked session is released first');
    assert.deepEqual(switched, [join(files, 'b.jsonl')]);
    assert.equal(binding.enabled, true, 'the next extension instance reconnects so the phone keeps the session');
    // Sessions in the same folder are told apart by their last request, size and age.
    assert.equal(offered[0], '"fix the login bug" — a · 8 msg · 5m ago (pi-rc-aaaaaa)');
    assert.equal(offered[1], '"write the release notes" — a · 3 msg · 2h ago (pi-rc-bbbbbb)');
    assert.equal(offered[2], '(empty) — a · 0 msg (pi-rc-cccccc)');
    // A background session that never got a message has no file: it is closed and this Pi stays put.
    pick = 'pi-rc-cccccc';
    await command('attach', ctx);
    assert.equal(daemon.records.filter(r => r.action === 'background.release').at(-1)?.name, 'pi-rc-cccccc');
    assert.equal(daemon.records.filter(r => r.action === 'background.release').at(-1)?.moving, false);
    assert.equal(switched.length, 1, 'no switch to a file that does not exist');
    assert.match(notices.at(-1)!, /no messages yet/);
    await command('attach show pi-rc-bbbbbb', ctx);
    assert.match(notices.at(-1)!, /attach show needs tmux/);
    await command('attach pi-rc-ffffff', ctx);
    assert.match(notices.at(-1)!, /Session pi-rc-ffffff not found/);
  } finally { bridge.stop(); await daemon.close(); await rm(files, { recursive: true, force: true }); }
});

test('a daemon-launched background Pi registers by itself (also in RPC mode) and obeys shutdown; terminal sessions do not', async () => {
  const daemon = await fakeDaemon(() => ({}));
  const saved = { a: process.env.PI_REMOTE_AUTOSTART, b: process.env.PI_REMOTE_BACKGROUND, c: process.env.PI_REMOTE_BACKGROUND_BACKEND };
  let shutdowns = 0;
  const events = new Map<string, (event: Record<string, any>, ctx: AttachContext) => void | Promise<void>>();
  const pi: AttachPi = { on: (e, h) => { events.set(e, h); }, registerCommand: () => {}, sendUserMessage: () => {}, getThinkingLevel: () => 'off' };
  const ctx: AttachContext = {
    mode: 'rpc', cwd: '/home/u/p', isIdle: () => true, abort: () => {}, shutdown: () => { shutdowns++; }, ui: { notify: () => {} },
    sessionManager: { getSessionId: () => 'bg-session', getLeafId: () => null, getSessionName: () => 'BG', getSessionFile: () => '/s/bg.jsonl', buildSessionProjection: () => ({ messages: [] }) },
  };
  let bridge: AttachBridge | undefined;
  try {
    process.env.PI_REMOTE_AUTOSTART = '1'; process.env.PI_REMOTE_BACKGROUND = 'pi-rc-c0ffee'; process.env.PI_REMOTE_BACKGROUND_BACKEND = 'rpc';
    bridge = installRemoteControl(pi, { socketPath: daemon.socketPath, secretFile: daemon.secretFile, binding: { runtimeId: 'bg-runtime', epoch: 0, enabled: false } });
    await events.get('session_start')!({ type: 'session_start', reason: 'startup' }, ctx);
    const reg = daemon.records.find(r => r.type === 'register')!;
    assert.deepEqual(reg.session.background, { name: 'pi-rc-c0ffee', backend: 'rpc', sessionFile: '/s/bg.jsonl' });
    assert.equal(typeof reg.launcher?.node, 'string');
    daemon.ipc()!.write('{"type":"shutdown"}\n'); await new Promise(r => setTimeout(r, 50));
    assert.equal(shutdowns, 1);
    bridge.stop();
    delete process.env.PI_REMOTE_BACKGROUND; delete process.env.PI_REMOTE_AUTOSTART;
    bridge = installRemoteControl(pi, { socketPath: daemon.socketPath, secretFile: daemon.secretFile, binding: { runtimeId: 'tui-runtime', epoch: 0, enabled: true } });
    await events.get('session_start')!({ type: 'session_start', reason: 'startup' }, { ...ctx, mode: 'tui' });
    await new Promise(r => setTimeout(r, 50));
    daemon.ipc()!.write('{"type":"shutdown"}\n'); await new Promise(r => setTimeout(r, 50));
    assert.equal(shutdowns, 1, 'a terminal session ignores remote shutdown requests');
  } finally {
    bridge?.stop(); await daemon.close();
    for (const [k, v] of [['PI_REMOTE_AUTOSTART', saved.a], ['PI_REMOTE_BACKGROUND', saved.b], ['PI_REMOTE_BACKGROUND_BACKEND', saved.c]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('/remote-control offers its options after a space (and on Tab), with real background sessions and devices', async () => {
  const daemon = await fakeDaemon(r => r.action === 'background.list'
    ? { sessions: [
      { name: 'pi-rc-aaaaaa', backend: 'tmux', cwd: '/home/u/proj', preview: 'fix the login bug', messageCount: 8, createdAt: Date.now() - 5 * 60_000, workState: 'running' },
      { name: 'pi-rc-bbbbbb', backend: 'rpc', cwd: '/home/u/proj', messageCount: 0, createdAt: Date.now() },
    ] }
    : r.action === 'status' ? { devices: [{ clientId: 'db9cce91-0000-4000-8000-000000000000', name: 'Android · Chrome', owner: true, revoked: false }, { clientId: 'deadbeef-0000', name: 'Old', revoked: true }] } : {});
  let options!: { description: string; getArgumentCompletions?: (prefix: string) => unknown; handler: (args: string, ctx: AttachContext) => Promise<void> };
  const pi: AttachPi = { on: () => {}, registerCommand: (_n, d) => { options = d; }, sendUserMessage: () => {}, getThinkingLevel: () => 'off' };
  const bridge = installRemoteControl(pi, { socketPath: daemon.socketPath, secretFile: daemon.secretFile, binding: { runtimeId: 'tab', epoch: 0, enabled: false } });
  const values = async (prefix: string) => ((await options.getArgumentCompletions!(prefix)) as CompletionItem[] | null)?.map(i => i.value) ?? null;
  try {
    assert.match(options.description, /Tab for options/);
    assert.deepEqual(await values(''), ['settings', 'pair', 'pair wifi', 'detach', 'attach', 'attach show', 'auto on', 'auto off', 'status', 'devices', 'revoke', 'stop', 'help']);
    assert.deepEqual(await values('de'), ['detach', 'devices']);
    assert.deepEqual(await values('wifi'), ['pair wifi'], 'a word inside an option also finds it');
    assert.equal(await values('xyz'), null);
    const auto = (await options.getArgumentCompletions!('auto')) as CompletionItem[];
    assert.match(auto.find(i => i.value === 'auto off')!.description!, /\(current\)/, 'the current auto setting is marked');
    // Choosing a session: the daemon's background sessions, told apart by their last message.
    const attach = (await options.getArgumentCompletions!('attach ')) as CompletionItem[];
    assert.deepEqual(attach.map(i => i.value), ['attach show', 'attach pi-rc-aaaaaa', 'attach show pi-rc-aaaaaa', 'attach pi-rc-bbbbbb']);
    assert.equal(attach[1]!.description, '"fix the login bug" · 8 msg · 5m ago · working');
    assert.equal(attach[3]!.description, '(empty) · 0 msg · just now');
    assert.deepEqual(await values('attach show '), ['attach show pi-rc-aaaaaa'], 'show only lists tmux sessions');
    assert.deepEqual(await values('revoke '), ['revoke db9cce91'], 'revoked devices are not offered');
    assert.equal(((await options.getArgumentCompletions!('revoke ')) as CompletionItem[])[0]!.description, 'Android · Chrome · owner');
    assert.equal(daemon.records.filter(r => r.action === 'background.list').length, 1, 'repeated keystrokes reuse the answer for a few seconds');
    // help, and unknown options answer with the same overview.
    const notices: string[] = [];
    const ctx: AttachContext = { mode: 'tui', cwd: '/home/u', isIdle: () => true, abort: () => {}, ui: { notify: text => { notices.push(text); } },
      sessionManager: { getSessionId: () => 'here', getLeafId: () => null, getSessionName: () => 'H', buildSessionProjection: () => ({ messages: [] }) } };
    await options.handler('help', ctx);
    assert.match(notices.at(-1)!, /^Remote Control: use this Pi session/);
    assert.match(notices.at(-1)!, /detach +Keep this session running in the background/);
    await options.handler('dettach', ctx);
    assert.match(notices.at(-1)!, /^Unknown option "dettach"\.\nRemote Control:/);
  } finally { bridge.stop(); await daemon.close(); }
  // Without a daemon the static options still work.
  let offline!: typeof options;
  installRemoteControl({ on: () => {}, registerCommand: (_n, d) => { offline = d; }, sendUserMessage: () => {}, getThinkingLevel: () => 'off' }, { socketPath: join(tmpdir(), 'no-daemon.sock'), secretFile: join(tmpdir(), 'no-such-secret') });
  assert.deepEqual(((await offline.getArgumentCompletions!('attach ')) as CompletionItem[]).map(i => i.value), ['attach show']);
});
