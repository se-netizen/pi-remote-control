import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { startServer } from '../src/server.js';
import { isTailscaleAddress, peerAddress, parseWhois, ownerDevice, tailscaleAuth, type TailscaleAuth } from '../src/tailscale.js';

test('Tailscale addresses and whois parsing', async () => {
  assert.equal(isTailscaleAddress('100.74.43.35'), true);
  assert.equal(isTailscaleAddress('::ffff:100.112.1.102'), true);
  assert.equal(isTailscaleAddress('fd7a:115c:a1e0::642f:2b24'), true);
  for (const ip of ['100.63.255.255', '100.128.0.1', '10.91.128.250', '127.0.0.1', '192.168.1.2', 'fd00::1', '']) assert.equal(isTailscaleAddress(ip), false, ip);
  assert.equal(peerAddress('::ffff:10.0.0.1'), '10.0.0.1');
  const identity = parseWhois(JSON.stringify({ Node: { StableID: 'nPHONE', ComputedName: 'pixel<script>', User: 2256413128772252, Tags: null }, UserProfile: { ID: 2256413128772252, LoginName: 'me@example.com' } }));
  assert.deepEqual(identity, { nodeId: 'nPHONE', nodeName: 'pixelscript', userId: '2256413128772252', login: 'me@example.com', tagged: false });
  assert.equal(parseWhois(JSON.stringify({ Node: { StableID: 'nSRV', Name: 'srv.tailnet.ts.net.', Tags: ['tag:server'] } }))!.tagged, true);
  // The CLI adapter caches lookups and never runs whois for non-tailnet peers.
  const calls: string[][] = [];
  const auth = tailscaleAuth(async args => { calls.push(args); return args[0] === 'status' ? JSON.stringify({ Self: { UserID: 7 } }) : JSON.stringify({ Node: { StableID: 'n1', ComputedName: 'pixel', User: 7 } }); });
  assert.equal(await auth.ownerUserId(), '7');
  assert.equal((await auth.whois('100.64.0.5'))?.nodeId, 'n1'); await auth.whois('100.64.0.5');
  assert.equal(await auth.whois('10.0.0.5'), undefined);
  assert.deepEqual(calls.map(c => c[0]), ['status', 'whois']);
});

test('only devices of the machine owner\'s own Tailscale account qualify', async () => {
  const auth: TailscaleAuth = {
    ownerUserId: async () => 'me',
    whois: async ip => ({ '100.64.0.5': { nodeId: 'n-phone', nodeName: 'pixel', userId: 'me', login: 'me', tagged: false }, '100.64.0.6': { nodeId: 'n-friend', nodeName: 'friend', userId: 'someone-else', login: 'x', tagged: false }, '100.64.0.7': { nodeId: 'n-tag', nodeName: 'ci', userId: 'me', login: '', tagged: true } } as Record<string, any>)[ip],
  };
  assert.equal((await ownerDevice(auth, '100.64.0.5'))?.nodeId, 'n-phone');
  assert.equal(await ownerDevice(auth, '100.64.0.6'), undefined, 'shared-in users are not the owner');
  assert.equal(await ownerDevice(auth, '100.64.0.7'), undefined, 'tagged nodes have no personal identity');
  assert.equal(await ownerDevice(auth, '10.91.128.250'), undefined, 'Wi-Fi/LAN peers have no Tailscale identity');
  assert.equal(await ownerDevice({ ...auth, ownerUserId: async () => undefined }, '100.64.0.5'), undefined, 'Tailscale not running');
});

async function freePort(): Promise<number> { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = (s.address() as any).port; await new Promise<void>(r => s.close(() => r())); return p; }

test('HTTP: Tailscale sign-in without QR, other accounts refused, revoke blocks until a QR pairing, Wi-Fi gets a Tailscale link', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-ts-login-')); const port = await freePort(); const secret = randomBytes(32).toString('base64url');
  const auth: TailscaleAuth = {
    ownerUserId: async () => 'me',
    whois: async ip => ip === '100.64.0.5' ? { nodeId: 'n-phone', nodeName: 'pixel', userId: 'me', login: 'me', tagged: false } : ip === '100.64.0.6' ? { nodeId: 'n-friend', nodeName: 'friend', userId: 'other', login: 'o', tagged: false } : undefined,
  };
  const app = await startServer({ dataDir: dir, secret, port, host: '0.0.0.0', allowHttp: true, tailscale: auth, interfaceAddresses: () => ['127.0.0.1', '10.91.128.250', '100.74.43.35'], hiddenAddresses: () => [], remoteAddressOf: req => String(req.headers['x-test-peer'] ?? req.socket.remoteAddress) });
  const origin = `http://127.0.0.1:${port}`;
  const get = async (peer: string, cookie = '') => { const r = await fetch(`${origin}/api/bootstrap`, { headers: { 'X-Test-Peer': peer, ...(cookie ? { Cookie: cookie } : {}) } }); return { body: await r.json() as any, cookie: (r.headers.get('set-cookie') ?? '').split(';')[0] }; };
  try {
    const phone = await get('100.64.0.5');
    assert.equal(phone.body.paired, true); assert.equal(phone.body.via, 'tailscale'); assert.equal(phone.body.owner, true);
    assert.match(phone.cookie, /^pi_remote=/);
    assert.equal((await get('100.64.0.5', phone.cookie)).body.via, undefined, 'the cookie is used afterwards; no new device per request');
    assert.equal(app.store.devices().filter(d => d.tailscaleNode === 'n-phone').length, 1);
    assert.equal(app.store.devices()[0]!.name, 'pixel · Tailscale');
    assert.equal((await get('100.64.0.6')).body.paired, false, 'a friend on the same tailnet is not the owner');
    const wifi = await get('10.91.128.250');
    assert.equal(wifi.body.paired, false); assert.equal(wifi.body.tailscaleUrl, `http://100.74.43.35:${port}`);
    // Revoking the phone stops automatic sign-in for that Tailscale node...
    app.core.revokeLocal(app.store.devices()[0]!.clientId);
    const blocked = await get('100.64.0.5');
    assert.equal(blocked.body.paired, false); assert.equal(blocked.body.tailscaleBlocked, true); assert.equal(blocked.cookie, '');
    // ...until it is paired again with a QR from that node.
    const socket = (await import('node:net')).connect(app.socketPath); await once(socket, 'connect');
    socket.write(JSON.stringify({ type: 'register', secret, session: { sessionId: 's1', runtimeId: 'r1', bindingEpoch: 1, branchId: 'b', title: 'T', cwd: '/tmp', mode: 'attach', workState: 'idle', capabilities: [], messages: [] } }) + '\n');
    for (let i = 0; i < 50 && !app.core.sessions.has('s1'); i++) await new Promise(r => setTimeout(r, 10));
    const token = app.core.makePairing(['s1'], true, true).token;
    const claim = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { 'X-Test-Peer': '100.64.0.5', Origin: origin, 'X-Pi-Remote': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    assert.equal(claim.status, 200);
    assert.equal((await get('100.64.0.5')).body.paired, true, 'QR pairing from the node lifts the block');
    socket.destroy();
  } finally { await app.close(); await rm(dir, { recursive: true, force: true }); }
});
