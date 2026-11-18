import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { startServer } from '../src/server.js';
import type { TailscaleAuth } from '../src/tailscale.js';
import { JsonLines, type BridgeCommand } from '../src/pi/types.js';
import { AttachBridge, type AttachContext, type AttachPi } from '../src/pi/attach-bridge.js';
import { openSettingsPanel, TABS, type PanelComponent, type PanelHost } from '../src/pi/settings-panel.js';

async function freePort(): Promise<number> { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = (s.address() as any).port; await new Promise<void>(r => s.close(() => r())); return p; }
async function admin(socketPath: string, secret: string, fields: Record<string, unknown>): Promise<any> {
  const socket = connect(socketPath); socket.setEncoding('utf8'); await once(socket, 'connect');
  socket.write(JSON.stringify({ ...fields, type: 'admin', secret }) + '\n');
  let text = ''; for await (const chunk of socket) text += chunk;
  return JSON.parse(text.trim());
}

test('daemon settings: stored, sent to every Pi, and enforced for Tailscale sign-in, Wi-Fi and files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-settings-')); const port = await freePort(); const secret = randomBytes(32).toString('base64url');
  const auth: TailscaleAuth = { ownerUserId: async () => 'me', whois: async ip => ip === '100.64.0.5' ? { nodeId: 'n-phone', nodeName: 'pixel', userId: 'me', login: 'me', tagged: false } : undefined };
  const app = await startServer({ dataDir: dir, secret, port, host: '0.0.0.0', allowHttp: true, tailscale: auth, interfaceAddresses: () => ['127.0.0.1', '192.168.1.10', '100.74.43.35'], hiddenAddresses: () => [], remoteAddressOf: req => String(req.headers['x-test-peer'] ?? req.socket.remoteAddress) });
  const origin = `http://127.0.0.1:${port}`;
  let ipc: Socket | undefined;
  try {
    const initial = await admin(app.socketPath, secret, { action: 'settings.get' });
    assert.deepEqual(initial.settings, { tailscaleLogin: true, lan: true, uploads: true, activity: true }, 'everything is on by default');
    assert.deepEqual(initial.available, { tailscaleLogin: true, lan: true });
    assert.equal((await admin(app.socketPath, secret, { action: 'settings.set', key: 'host', value: false })).error, 'invalid_setting');
    assert.equal((await admin(app.socketPath, secret, { action: 'settings.set', key: 'lan', value: 'no' })).error, 'invalid_setting');

    // A registered Pi gets the settings on registration and every change afterwards.
    ipc = connect(app.socketPath); ipc.setEncoding('utf8'); await once(ipc, 'connect');
    const received: any[] = [];
    const lines = new JsonLines(m => { received.push(m); if (m.type === 'command') ipc!.write(JSON.stringify({ type: 'result', commandId: m.commandId, status: 'dispatched_unconfirmed' }) + '\n'); });
    ipc.on('data', (c: string) => lines.push(c));
    const session = { sessionId: 's1', runtimeId: 'r1', bindingEpoch: 1, branchId: 'b', title: 'x', cwd: '/tmp', mode: 'attach', workState: 'idle', capabilities: ['prompt', 'attachments'], messages: [] };
    ipc.write(JSON.stringify({ type: 'register', secret, session }) + '\n');
    for (let i = 0; i < 50 && !received.some(m => m.type === 'registered'); i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(received.find(m => m.type === 'registered').settings.activity, true);
    const changed = await admin(app.socketPath, secret, { action: 'settings.set', key: 'activity', value: false });
    assert.equal(changed.settings.activity, false);
    for (let i = 0; i < 50 && !received.some(m => m.type === 'settings'); i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(received.find(m => m.type === 'settings')?.settings.activity, false);

    // Tailscale sign-in off: the owner's own phone gets the QR screen like anyone else.
    await admin(app.socketPath, secret, { action: 'settings.set', key: 'tailscaleLogin', value: false });
    const tsOff = await (await fetch(`${origin}/api/bootstrap`, { headers: { 'X-Test-Peer': '100.64.0.5' } })).json() as any;
    assert.equal(tsOff.paired, false);
    await admin(app.socketPath, secret, { action: 'settings.set', key: 'tailscaleLogin', value: true });
    const tsOn = await (await fetch(`${origin}/api/bootstrap`, { headers: { 'X-Test-Peer': '100.64.0.5' } })).json() as any;
    assert.equal(tsOn.paired, true); assert.equal(tsOn.uploads, true);

    // Wi-Fi/LAN off: the page explains it, every API call is refused, no Wi-Fi QR can be made.
    await admin(app.socketPath, secret, { action: 'settings.set', key: 'lan', value: false });
    const lanBoot = await (await fetch(`${origin}/api/bootstrap`, { headers: { 'X-Test-Peer': '192.168.1.20' } })).json() as any;
    assert.equal(lanBoot.lanDisabled, true); assert.equal(lanBoot.tailscaleUrl, 'http://100.74.43.35:' + port);
    const lanApi = await fetch(`${origin}/api/sessions`, { headers: { 'X-Test-Peer': '192.168.1.20' } });
    assert.equal(lanApi.status, 403); assert.equal(((await lanApi.json()) as any).error, 'lan_disabled');
    assert.equal((await admin(app.socketPath, secret, { action: 'pair', wifi: true })).error, 'lan_disabled');
    const fromTailscale = await fetch(`${origin}/api/bootstrap`, { headers: { 'X-Test-Peer': '100.64.0.5' } });
    assert.equal(fromTailscale.status, 200, 'Tailscale and this computer keep working');
    await admin(app.socketPath, secret, { action: 'settings.set', key: 'lan', value: true });

    // Files off: no new uploads and no sending of earlier ones.
    const owner = app.core.claim(app.core.makePairing(['s1'], true, true).token, 'Phone');
    const api = async (path: string, method = 'GET', data?: unknown) => {
      const r = await fetch(origin + path, { method, headers: { Origin: origin, 'X-Pi-Remote': '1', 'Content-Type': 'application/json', Cookie: `pi_remote=${owner.secret}` }, body: data === undefined ? undefined : JSON.stringify(data) });
      return { status: r.status, data: await r.json() as any };
    };
    const up = await api('/api/sessions/s1/uploads', 'POST', { name: 'a.txt', size: 3 });
    await api(`/api/uploads/${up.data.uploadId}`, 'POST', { offset: 0, data: Buffer.from('abc').toString('base64') });
    await admin(app.socketPath, secret, { action: 'settings.set', key: 'uploads', value: false });
    assert.equal((await api('/api/bootstrap')).data.uploads, false, 'the web app greys out the paperclip');
    assert.equal((await api('/api/sessions/s1/uploads', 'POST', { name: 'b.txt', size: 3 })).data.error, 'uploads_disabled');
    const lease = (await api('/api/sessions/s1/lease', 'POST', {})).data;
    const command = { commandId: randomUUID(), sessionId: 's1', runtimeId: 'r1', bindingEpoch: 1, branchId: 'b', leaseEpoch: lease.leaseEpoch, kind: 'prompt', payload: { text: 'x', attachments: [up.data.uploadId] }, expiresAt: Date.now() + 20_000 };
    assert.equal((await api('/api/sessions/s1/commands', 'POST', command)).data.error, 'uploads_disabled');
    // Settings survive a daemon restart.
    assert.equal(app.store.get<any>('remote').uploads, false);
  } finally { ipc?.destroy(); await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('bridge: "Remote activity in this terminal" off hides message notices, never stop requests', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-activity-'));
  const socketPath = join(dir, 'bridge.sock'); const secretFile = join(dir, 'bridge.secret');
  await writeFile(secretFile, 'activity-secret', { mode: 0o600 });
  let daemon: Socket | undefined;
  const server = createServer(socket => {
    socket.setEncoding('utf8');
    const lines = new JsonLines(record => { if (record.type === 'register') { daemon = socket; socket.write(JSON.stringify({ type: 'registered', settings: { activity: true } }) + '\n'); } });
    socket.on('data', (chunk: string) => lines.push(chunk));
  });
  server.listen(socketPath); await once(server, 'listening');
  const notices: string[] = [];
  const pi: AttachPi = { on: () => {}, registerCommand: () => {}, getThinkingLevel: () => 'off', sendUserMessage: () => {} };
  const ctx: AttachContext = { mode: 'tui', cwd: dir, isIdle: () => true, abort: () => {}, ui: { notify: text => { notices.push(text); } },
    sessionManager: { getSessionId: () => 'act', getLeafId: () => null, getSessionName: () => 'A', buildSessionProjection: () => ({ messages: [] }) } };
  const bridge = new AttachBridge(pi, { socketPath, secretFile, binding: { runtimeId: 'act-rt', epoch: 0, enabled: false } });
  try {
    await bridge.start(ctx); await new Promise(r => setTimeout(r, 20));
    const s = bridge.snapshot();
    const command = (id: string, kind: BridgeCommand['kind'], text?: string): BridgeCommand => ({ type: 'command', commandId: id, sessionId: s.sessionId, runtimeId: s.runtimeId, bindingEpoch: s.bindingEpoch, branchId: s.branchId, kind, payload: text === undefined ? {} : { text } });
    bridge.handleCommand(command('a', 'prompt', 'hello'));
    assert.match(notices.at(-1)!, /Message from a remote device/);
    daemon!.write(JSON.stringify({ type: 'settings', settings: { activity: false } }) + '\n');
    for (let i = 0; i < 50 && bridge.showsActivity(); i++) await new Promise(r => setTimeout(r, 10));
    const before = notices.length;
    bridge.handleCommand(command('b', 'prompt', 'again'));
    assert.equal(notices.length, before, 'no notice while activity is off');
    bridge.handleCommand(command('c', 'abort'));
    assert.match(notices.at(-1)!, /asked Pi to stop/, 'stop requests are always shown');
  } finally { bridge.stop(); server.close(); await rm(dir, { recursive: true, force: true }); }
});

test('settings panel: tabs, switches, revoke and stop need a second press, terminal actions close it', async () => {
  const calls: { action: string; fields?: Record<string, unknown> }[] = [];
  let enabled = false, auto = false;
  let settings = { tailscaleLogin: true, lan: true, uploads: true, activity: true };
  let devices = [{ clientId: 'db9cce91-aaaa', name: 'Android · Chrome', owner: true, revoked: false, expiresAt: Date.now() + 29.6 * 86_400_000, via: 'tailscale' }];
  let sessions = [{ name: 'pi-rc-aaaaaa', backend: 'tmux', cwd: '/home/u/proj', preview: 'fix the login bug', messageCount: 8, createdAt: Date.now() - 5 * 60_000 }];
  const host: PanelHost = {
    isEnabled: () => enabled, autoStart: () => auto, setAutoStart: on => { auto = on; },
    start: async () => { enabled = true; }, stop: () => { enabled = false; },
    url: 'http://127.0.0.1:3141', urls: ['http://100.74.43.35:3141', 'http://192.168.1.10:3141'],
    admin: async (action, fields) => {
      calls.push({ action, fields });
      if (action === 'settings.get') return { settings, available: { tailscaleLogin: true, lan: false }, pid: 42, version: '0.1.0', dataDir: '/tmp/data' };
      if (action === 'settings.set') { settings = { ...settings, [String(fields!.key)]: fields!.value }; return { settings }; }
      if (action === 'status') return { urls: ['http://100.74.43.35:3141', 'http://192.168.1.10:3141'], bindHost: '0.0.0.0', port: 3141, devices };
      if (action === 'background.list') return { backend: 'tmux', tmux: true, sessions };
      if (action === 'revoke') { devices = devices.map(d => ({ ...d, revoked: true })); return { status: 'revoked' }; }
      if (action === 'background.stop') { sessions = []; return { status: 'stopped' }; }
      return {};
    },
  };
  let panel!: PanelComponent; let result: Promise<string | undefined>;
  const keys: Record<string, string[]> = { 'tui.select.up': ['UP'], 'tui.select.down': ['DOWN'], 'tui.select.confirm': ['ENTER'], 'tui.select.cancel': ['ESC'], 'tui.editor.cursorLeft': ['LEFT'], 'tui.editor.cursorRight': ['RIGHT'] };
  const ctx = {
    sessionManager: { getSessionId: () => '01a1ef16-0000', getSessionName: () => 'proj' },
    ui: { custom: <T,>(factory: (tui: any, theme: unknown, keybindings: unknown, done: (r: T) => void) => PanelComponent) => new Promise<T>(resolve => {
      panel = factory({ requestRender: () => {} }, { fg: (_c: string, t: string) => t, bold: (t: string) => t, inverse: (t: string) => `[${t}]` }, { matches: (data: string, id: string) => keys[id]?.includes(data) ?? false }, resolve);
    }) },
  };
  const settle = () => new Promise(r => setTimeout(r, 15));
  const screen = () => panel.render(100).join('\n');
  const press = async (...input: string[]) => { for (const k of input) { panel.handleInput!(k); await settle(); } };
  const open = async () => { result = openSettingsPanel(host, ctx); await settle(); await settle(); };

  await open();
  assert.match(screen(), /Remote Control +\[ Settings \] +Status +Devices +Background/);
  assert.match(screen(), /› Remote for this session +○ off/);
  assert.match(screen(), /Wi-Fi\/LAN devices +unavailable/, 'a setting the daemon cannot offer says so');
  await press('ENTER');
  assert.equal(enabled, true); assert.match(screen(), /Remote for this session +● on/);
  await press('DOWN', 'ENTER');
  assert.equal(auto, true);
  await press('DOWN', 'DOWN', 'DOWN', 'ENTER');
  assert.deepEqual(calls.at(-1), { action: 'settings.set', fields: { key: 'uploads', value: false } });
  assert.match(screen(), /Files from phone +○ off/); assert.match(screen(), /Files from phone: off\./);

  await press('RIGHT');
  assert.match(screen(), /\[ Status \]/);
  assert.match(screen(), /Phone address +http:\/\/100\.74\.43\.35:3141/);
  assert.match(screen(), /This session +remote on · proj · 01a1ef16/);
  assert.match(screen(), /Files from phone +off/);

  await press('RIGHT');
  assert.match(screen(), /\+ Pair over Wi-Fi +unavailable/);
  assert.match(screen(), /Android · Chrome +db9cce91 · owner · tailscale · 30d left/);
  await press('DOWN', 'DOWN', 'ENTER');
  assert.match(screen(), /Press enter again to revoke Android · Chrome/);
  assert.ok(!calls.some(c => c.action === 'revoke'), 'nothing is revoked on the first press');
  await press('ENTER'); await settle();
  assert.deepEqual(calls.find(c => c.action === 'revoke')?.fields, { clientId: 'db9cce91-aaaa' });
  assert.match(screen(), /No devices yet\./);

  await press('RIGHT');
  assert.match(screen(), /"fix the login bug" +8 msg · 5m ago · tmux · pi-rc-aaaaaa/);
  await press('DOWN', 'x');
  assert.match(screen(), /Press x again to stop pi-rc-aaaaaa/);
  await press('ESC');
  assert.doesNotMatch(screen(), /Press x again/, 'escape cancels a pending confirmation first');
  await press('x', 'x'); await settle();
  assert.equal(calls.filter(c => c.action === 'background.stop').length, 1);
  assert.match(screen(), /No background sessions\./);
  await press('ESC');
  assert.equal(await result!, undefined, 'escape closes the panel');

  // Actions that need the terminal close the panel and hand back /remote-control arguments.
  sessions = [{ name: 'pi-rc-bbbbbb', backend: 'tmux', cwd: '/home/u/proj', preview: 'write docs', messageCount: 3, createdAt: Date.now() }];
  await open(); await press('LEFT');
  assert.match(screen(), /\[ Background \]/, 'left from the first tab wraps around');
  await press('DOWN', 's');
  assert.equal(await result!, 'attach show pi-rc-bbbbbb');
  await open(); await press('LEFT', 'DOWN', 'ENTER');
  assert.equal(await result!, 'attach pi-rc-bbbbbb');
  await open(); await press('RIGHT', 'RIGHT', 'ENTER');
  assert.equal(await result!, 'pair');
  assert.equal(TABS.length, 4);
});
