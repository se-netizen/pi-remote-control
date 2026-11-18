import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { startServer } from '../src/server.js';
import * as server from '../src/seal.js';
// @ts-ignore -- buildless browser module shared unchanged with the web app
import * as browser from '../web/seal.js';

test('browser and daemon seal the same format; any change to ciphertext, direction or binding fails', () => {
  const key = server.newSealKey();
  const aad = server.requestAad('POST', '/api/sessions/s1/commands', 'dev', 1_800_000_000_000);
  const fromBrowser = browser.seal(key, '{"text":"halo"}', aad);
  assert.equal(server.open(key, fromBrowser.nonce, fromBrowser.data, aad), '{"text":"halo"}');
  const fromDaemon = server.seal(key, '{"ok":true}', server.responseAad('POST', '/x', 'dev', 1, fromBrowser.nonce));
  assert.equal(browser.open(key, fromDaemon.nonce, fromDaemon.data, browser.responseAad('POST', '/x', 'dev', 1, fromBrowser.nonce)), '{"ok":true}');
  const flipped = Buffer.from(fromBrowser.data, 'base64url'); flipped[0] ^= 1;
  assert.throws(() => server.open(key, fromBrowser.nonce, flipped.toString('base64url'), aad), /seal_invalid/);
  assert.throws(() => server.open(key, fromBrowser.nonce, fromBrowser.data, aad.replace('|c2s|', '|s2c|')), /seal_invalid/, 'cannot be reflected to the other direction');
  assert.throws(() => server.open(key, fromBrowser.nonce, fromBrowser.data, aad.replace('/s1/', '/s2/')), /seal_invalid/, 'bound to the path');
  assert.throws(() => server.open(server.newSealKey(), fromBrowser.nonce, fromBrowser.data, aad), /seal_invalid/, 'another device key');
  assert.notEqual(browser.seal(key, 'x', aad).nonce, browser.seal(key, 'x', aad).nonce, 'fresh random nonce each time');
  const guard = new server.ReplayGuard();
  assert.equal(guard.remember('n1'), true); assert.equal(guard.remember('n1'), false);
});

test('vendored @noble/ciphers files are byte-identical to the pinned npm package', async () => {
  for (const file of ['chacha.js', '_arx.js', '_poly1305.js', 'utils.js']) {
    const vendored = await readFile(new URL(`../web/vendor/noble/${file}`, import.meta.url));
    const pinned = await readFile(new URL(`../node_modules/@noble/ciphers/${file}`, import.meta.url));
    assert.ok(vendored.equals(pinned), `${file} differs from node_modules/@noble/ciphers`);
  }
});

async function freePort(): Promise<number> { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = (s.address() as any).port; await new Promise<void>(r => s.close(() => r())); return p; }

test('Wi-Fi path: plaintext refused, cookies ignored, sealed pairing/API/stream work, tamper/replay/clock/revoke refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-seal-')); const port = await freePort(); const secret = randomBytes(32).toString('base64url');
  const app = await startServer({ dataDir: dir, secret, port, host: '0.0.0.0', allowHttp: true, interfaceAddresses: () => ['127.0.0.1', '192.168.1.10'], hiddenAddresses: () => [], remoteAddressOf: req => String(req.headers['x-test-peer'] ?? req.socket.remoteAddress) });
  const origin = `http://127.0.0.1:${port}`; const WIFI = '192.168.1.20';
  let ipc: Socket | undefined;
  type Creds = { device: string; key: string };
  const sealedFetch = async (creds: Creds, method: string, path: string, payload?: unknown, opts: { t?: number; tamper?: boolean; reuse?: any } = {}) => {
    const sealed = opts.reuse ?? browser.sealRequest(creds, method, path, payload, opts.t ?? Date.now());
    const headers: Record<string, string> = { 'X-Test-Peer': WIFI, Origin: origin, 'X-Pi-Remote': '1', ...sealed.headers };
    let body = sealed.body;
    if (opts.tamper) { if (body) body = body.slice(0, -2) + (body.endsWith('AA') ? 'BB' : 'AA'); else headers['X-Pi-Seal-Data'] = headers['X-Pi-Seal-Data'].slice(0, -2) + 'AA'; }
    const response = await fetch(origin + path, { method, headers, body });
    const text = await response.text();
    const type = response.headers.get('content-type') ?? '';
    return { status: response.status, type, text, sealed, data: type.startsWith(server.SEAL_CONTENT_TYPE) ? browser.openResponse(creds, sealed.context, text) : JSON.parse(text || '{}') };
  };
  try {
    ipc = connect(app.socketPath); await once(ipc, 'connect');
    const session = { sessionId: 's1', runtimeId: 'r1', bindingEpoch: 1, branchId: 'b', title: 'Rahasia proyek', cwd: '/tmp/secret', mode: 'attach', workState: 'idle', capabilities: ['prompt'], messages: [{ role: 'user', content: 'password database adalah hunter2', timestamp: 1 }] };
    ipc.write(JSON.stringify({ type: 'register', secret, session }) + '\n');
    for (let i = 0; i < 50 && !app.core.sessions.has('s1'); i++) await new Promise(r => setTimeout(r, 10));

    // Plain requests from Wi-Fi are refused, even with a valid cookie from another path.
    const tsDevice = app.core.claim(app.core.makePairing(['s1'], true, true).token, 'Tailscale phone');
    const plain = await fetch(`${origin}/api/sessions`, { headers: { 'X-Test-Peer': WIFI, Cookie: `pi_remote=${tsDevice.secret}` } });
    assert.equal(plain.status, 401); assert.equal(((await plain.json()) as any).error, 'encryption_required');
    const boot = await (await fetch(`${origin}/api/bootstrap`, { headers: { 'X-Test-Peer': WIFI, Cookie: `pi_remote=${tsDevice.secret}` } })).json() as any;
    assert.equal(boot.paired, false); assert.equal(boot.sealRequired, true); assert.equal(boot.hostId, undefined);
    const plainStream = await fetch(`${origin}/api/stream?session=s1`, { headers: { 'X-Test-Peer': WIFI, Cookie: `pi_remote=${tsDevice.secret}` } });
    assert.equal(plainStream.status, 401);

    // Pairing: the claim is sealed with the key from the QR.
    const pairing = app.core.makeWifiPairing(['s1']);
    const wrongKey = await sealedFetch({ device: `pair:${pairing.requestId}`, key: server.newSealKey() }, 'POST', '/api/pair', {});
    assert.equal(wrongKey.status, 401);
    const claim = await sealedFetch({ device: `pair:${pairing.requestId}`, key: pairing.key }, 'POST', '/api/pair', {});
    assert.equal(claim.status, 200); assert.equal(claim.data.paired, true);
    assert.ok(!claim.text.includes(claim.data.clientId), 'response body is ciphertext');
    assert.equal((await sealedFetch({ device: `pair:${pairing.requestId}`, key: pairing.key }, 'POST', '/api/pair', {})).status, 401, 'pairing works once');
    const creds = { device: claim.data.clientId, key: pairing.key };

    const list = await sealedFetch(creds, 'GET', '/api/sessions');
    assert.equal(list.status, 200); assert.equal(list.type, server.SEAL_CONTENT_TYPE);
    assert.equal(list.data.sessions[0].title, 'Rahasia proyek');
    assert.ok(!list.text.includes('Rahasia'), 'session titles never cross Wi-Fi in clear');
    const snap = await sealedFetch(creds, 'GET', '/api/sessions/s1');
    assert.ok(!snap.text.includes('hunter2')); assert.equal(snap.data.session.messages[0].content, 'password database adalah hunter2');

    assert.equal((await sealedFetch(creds, 'GET', '/api/sessions', undefined, { tamper: true })).status, 401, 'modified ciphertext');
    const replayed = await sealedFetch(creds, 'GET', '/api/sessions', undefined, { reuse: list.sealed });
    assert.equal(replayed.status, 401); assert.equal(replayed.data.error, 'seal_replay');
    const skew = await sealedFetch(creds, 'GET', '/api/sessions', undefined, { t: Date.now() - 5 * 60_000 });
    assert.equal(skew.data.error, 'seal_clock'); assert.equal(typeof skew.data.now, 'number');

    // Sealed stream: encrypted query, numbered encrypted events.
    const s = browser.sealStream(creds, 's1');
    const controller = new AbortController();
    const res = await fetch(`${origin}/api/stream?seal=${encodeURIComponent(s.query)}`, { headers: { 'X-Test-Peer': WIFI }, signal: controller.signal });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader(); let text = '';
    for (let i = 0; i < 50 && !/event: snapshot\ndata: [^\n]+\n\n/.test(text); i++) { const { value } = await reader.read(); text += new TextDecoder().decode(value); }
    const data = /event: snapshot\ndata: ([^\n]+)/.exec(text)![1]!;
    assert.ok(!text.includes('hunter2'), 'stream events are ciphertext');
    assert.equal(browser.openEvent(creds, s.context, data).session.sessionId, 's1');
    controller.abort();
    const reuseStream = await fetch(`${origin}/api/stream?seal=${encodeURIComponent(s.query)}`, { headers: { 'X-Test-Peer': WIFI } });
    assert.equal(reuseStream.status, 401, 'a stream URL cannot be replayed');

    // Sign-out retires the Wi-Fi device; the key stops working immediately.
    const logout = await sealedFetch(creds, 'POST', '/api/logout', {});
    assert.equal(logout.status, 200);
    assert.equal((await sealedFetch(creds, 'GET', '/api/sessions')).status, 401);
    // Loopback stays plaintext (local only).
    assert.equal((await fetch(`${origin}/api/bootstrap`)).headers.get('content-type')?.startsWith('application/json'), true);
  } finally { ipc?.destroy(); await app.close(); await rm(dir, { recursive: true, force: true }); }
});
