import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { request } from 'node:http';
import { randomBytes } from 'node:crypto';
import { startServer } from '../src/server.js';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', ok);
  });
  const port = (server.address() as AddressInfo).port;
  await new Promise<void>(ok => server.close(() => ok()));
  return port;
}

function httpGet(port: number, host: string, origin?: string): Promise<{ status: number; body: any }> {
  return new Promise((ok, fail) => {
    const req = request({ hostname: '127.0.0.1', port, path: '/api/bootstrap', headers: { Host: host, ...(origin ? { Origin: origin } : {}) } }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        try { ok({ status: response.statusCode ?? 0, body: JSON.parse(text) }); }
        catch (error) { fail(error); }
      });
    });
    req.on('error', fail);
    req.end();
  });
}

test('default listener stays loopback while explicit 0.0.0.0 opens all IPv4 interfaces', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pi-bind-'));
  const secret = randomBytes(32).toString('base64url');
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    let port = await freePort();
    app = await startServer({ dataDir, secret, port });
    assert.equal((app.http.address() as AddressInfo).address, '127.0.0.1');
    await app.close(); app = undefined;

    port = await freePort();
    app = await startServer({ dataDir, secret, port, host: '0.0.0.0' });
    assert.equal((app.http.address() as AddressInfo).address, '0.0.0.0');
    const bootstrap = await httpGet(port, `127.0.0.1:${port}`);
    assert.equal(bootstrap.status, 200);
    assert.equal(bootstrap.body.paired, false);
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('nonloopback HTTP requires explicit permission and retains exact Host/Origin checks', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pi-http-bind-'));
  const secret = randomBytes(32).toString('base64url');
  const port = await freePort();
  const origin = `http://192.0.2.10:${port}`;
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    await assert.rejects(startServer({ dataDir, secret, port, host: '0.0.0.0', origin }), /https_required/);
    app = await startServer({ dataDir, secret, port, host: '0.0.0.0', origin, allowHttp: true });
    assert.equal((app.http.address() as AddressInfo).address, '0.0.0.0');
    const allowed = await httpGet(port, `192.0.2.10:${port}`, origin);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.product, 'Pi Remote Control');
    const otherHost = await httpGet(port, `untrusted.example:${port}`, origin);
    assert.equal(otherHost.status, 403);
    assert.equal(otherHost.body.error, 'invalid_host');
    const otherOrigin = await httpGet(port, `192.0.2.10:${port}`, 'http://untrusted.example');
    assert.equal(otherOrigin.status, 403);
    assert.equal(otherOrigin.body.error, 'invalid_origin');
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('wildcard listener with --allow-http accepts every machine IP, including Tailscale, beside the explicit origin', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pi-multi-origin-'));
  const secret = randomBytes(32).toString('base64url');
  const port = await freePort();
  const lan = `http://10.91.128.250:${port}`;
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    app = await startServer({
      dataDir, secret, port, host: '0.0.0.0', origin: lan, allowHttp: true,
      hostnames: ['muqsith-vm.tail6bcbc1.ts.net'],
      interfaceAddresses: () => ['127.0.0.1', '10.91.128.250', '100.74.43.35', 'fd7a:115c:a1e0::642f:2b24', '172.17.0.1'],
      hiddenAddresses: () => ['172.17.0.1'],
    });
    // The exact case from the bug report: daemon configured with the LAN origin, browser opens the Tailscale IP.
    const tailscale = await httpGet(port, `100.74.43.35:${port}`, `http://100.74.43.35:${port}`);
    assert.equal(tailscale.status, 200);
    assert.equal((await httpGet(port, `10.91.128.250:${port}`, lan)).status, 200);
    assert.equal((await httpGet(port, `127.0.0.1:${port}`)).status, 200);
    assert.equal((await httpGet(port, `muqsith-vm.tail6bcbc1.ts.net:${port}`)).status, 200);
    assert.equal((await httpGet(port, `172.17.0.1:${port}`)).status, 200, 'hidden addresses are still accepted');
    // Cross-origin requests stay blocked even between two allowed hosts.
    const crossed = await httpGet(port, `100.74.43.35:${port}`, lan);
    assert.equal(crossed.status, 403);
    assert.equal(crossed.body.error, 'invalid_origin');
    // Names and foreign IPs are still rejected (DNS rebinding protection).
    assert.equal((await httpGet(port, `evil.example:${port}`)).status, 403);
    assert.equal((await httpGet(port, `203.0.113.9:${port}`)).status, 403);
    assert.equal((await httpGet(port, `100.74.43.35:${port + 1}`)).status, 403);
    // Explicit origin first, then Tailscale, then LAN, loopback last.
    assert.deepEqual(app.urls, [lan, `http://100.74.43.35:${port}`, `http://muqsith-vm.tail6bcbc1.ts.net:${port}`, `http://127.0.0.1:${port}`]);
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('without --allow-http a wildcard listener only accepts loopback and explicit HTTPS origins', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pi-no-http-'));
  const secret = randomBytes(32).toString('base64url');
  const port = await freePort();
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    app = await startServer({
      dataDir, secret, port, host: '0.0.0.0', origin: ['https://muqsith-vm.tail6bcbc1.ts.net'],
      interfaceAddresses: () => ['127.0.0.1', '100.74.43.35'],
    });
    assert.equal((await httpGet(port, 'muqsith-vm.tail6bcbc1.ts.net', 'https://muqsith-vm.tail6bcbc1.ts.net')).status, 200);
    assert.equal((await httpGet(port, `127.0.0.1:${port}`)).status, 200);
    assert.equal((await httpGet(port, `100.74.43.35:${port}`)).status, 403);
    assert.deepEqual(app.urls, ['https://muqsith-vm.tail6bcbc1.ts.net', `http://127.0.0.1:${port}`]);
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('a rejected browser page explains how to allow the address instead of returning bare JSON', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pi-host-page-'));
  const secret = randomBytes(32).toString('base64url');
  const port = await freePort();
  let app: Awaited<ReturnType<typeof startServer>> | undefined;
  try {
    app = await startServer({ dataDir, secret, port });
    const html = await new Promise<{ status: number; type: string; text: string }>((ok, fail) => {
      const req = request({ hostname: '127.0.0.1', port, path: '/', headers: { Host: `<b>x</b>:${port}` } }, response => {
        let text = ''; response.setEncoding('utf8');
        response.on('data', c => { text += c; });
        response.on('end', () => ok({ status: response.statusCode ?? 0, type: String(response.headers['content-type']), text }));
      });
      req.on('error', fail); req.end();
    });
    assert.equal(html.status, 403);
    assert.match(html.type, /text\/html/);
    assert.match(html.text, /--allow-http/);
    assert.ok(!html.text.includes('<b>x</b>'), 'Host header must be escaped');
  } finally {
    await app?.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});
