import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, utimes, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { startServer } from '../src/server.js';
import { UploadStore, safeFileName, sniffImage, UPLOAD_CHUNK_BYTES } from '../src/uploads.js';
import { parseCommand } from '../src/protocol.js';
import { AttachBridge, ATTACHMENT_HEADING, attachmentText, type AttachContext, type AttachPi } from '../src/pi/attach-bridge.js';
import { JsonLines, type BridgeCommand } from '../src/pi/types.js';
import * as seal from '../src/seal.js';
// @ts-ignore -- buildless browser modules shared unchanged with the web app
import * as browserSeal from '../web/seal.js';
// @ts-ignore -- buildless browser modules shared unchanged with the web app
import { splitAttachments, formatBytes, fileBadge, ATTACHMENT_HEADING as WEB_HEADING } from '../web/helpers.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
async function freePort(): Promise<number> { const s = createServer(); s.listen(0, '127.0.0.1'); await once(s, 'listening'); const p = (s.address() as any).port; await new Promise<void>(r => s.close(() => r())); return p; }

test('file names are one safe path segment; images are recognised from their bytes, not the browser claim', () => {
  assert.equal(safeFileName('../../etc/passwd'), 'passwd');
  assert.equal(safeFileName('C:\\Users\\a\\photo.jpg'), 'photo.jpg');
  assert.equal(safeFileName('.env'), 'env');
  assert.equal(safeFileName('a\nb\u0000c.txt'), 'abc.txt');
  assert.equal(safeFileName(''), 'file');
  const long = safeFileName('x'.repeat(300) + '.png');
  assert.ok(Buffer.byteLength(long) <= 120 && long.endsWith('.png'));
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), 'image/jpeg');
  assert.equal(sniffImage(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImage(Buffer.from('<svg xmlns=')), undefined);
});

test('upload store: ordered chunks, size limits, per-device ownership, cancel and retention', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-uploads-'));
  let now = Date.now();
  const store = new UploadStore(join(dir, 'uploads'), { maxBytes: 2 * UPLOAD_CHUNK_BYTES, totalBytes: 3 * UPLOAD_CHUNK_BYTES }, () => now);
  try {
    await assert.rejects(store.create('a', { name: 'x', size: 0 }), /upload_empty/);
    await assert.rejects(store.create('a', { name: 'x', size: 2 * UPLOAD_CHUNK_BYTES + 1 }), /upload_too_large/);
    const body = Buffer.concat([PNG, randomBytes(UPLOAD_CHUNK_BYTES + 100)]);
    // The browser says text/plain; the bytes say PNG.
    const up = await store.create('a', { name: '../shot.png', size: body.length, type: 'text/plain' });
    assert.equal(up.name, 'shot.png');
    await assert.rejects(store.append('b', up.uploadId, 0, body.subarray(0, 10)), /upload_not_found/, 'another device cannot write');
    await assert.rejects(store.append('a', up.uploadId, 5, body.subarray(0, 10)), /upload_offset/);
    await assert.rejects(store.append('a', up.uploadId, 0, body.subarray(0, UPLOAD_CHUNK_BYTES + 1)), /upload_chunk_invalid/);
    assert.throws(() => store.resolve('a', [up.uploadId]), /upload_incomplete/);
    const first = await store.append('a', up.uploadId, 0, body.subarray(0, UPLOAD_CHUNK_BYTES));
    assert.deepEqual(first, { received: UPLOAD_CHUNK_BYTES, done: false });
    const last = await store.append('a', up.uploadId, UPLOAD_CHUNK_BYTES, body.subarray(UPLOAD_CHUNK_BYTES));
    assert.equal(last.done, true); assert.equal(last.mimeType, 'image/png');
    const [file] = store.resolve('a', [up.uploadId]);
    assert.ok(file && file.path.endsWith(`/${up.uploadId}/shot.png`));
    assert.deepEqual(await readFile(file.path), body);
    assert.equal((await stat(file.path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(dir, 'uploads', up.uploadId))).mode & 0o777, 0o700);
    assert.throws(() => store.resolve('b', [up.uploadId]), /upload_not_found/, 'another device cannot attach it');
    await assert.rejects(store.append('a', up.uploadId, body.length, PNG), /upload_complete/);
    // A non-image claim keeps its type; an image claim without image bytes does not.
    const text = await store.create('a', { name: 'notes.csv', size: 3, type: 'text/csv' });
    assert.equal((await store.append('a', text.uploadId, 0, Buffer.from('a,b'))).mimeType, 'text/csv');
    const fake = await store.create('a', { name: 'evil.png', size: 4, type: 'image/png' });
    assert.equal((await store.append('a', fake.uploadId, 0, Buffer.from('<svg'))).mimeType, 'application/octet-stream');
    // Disk quota counts declared sizes.
    await assert.rejects(store.create('a', { name: 'big', size: 2 * UPLOAD_CHUNK_BYTES }), /upload_quota/);
    // Cancel removes the folder.
    const gone = await store.create('a', { name: 'gone.txt', size: 10 });
    await assert.rejects(store.cancel('b', gone.uploadId), /upload_not_found/);
    await store.cancel('a', gone.uploadId);
    assert.ok(!(await readdir(join(dir, 'uploads'))).includes(gone.uploadId));
    // Unfinished uploads expire after an hour, finished ones after a week (files of earlier runs too).
    const stale = await store.create('a', { name: 'half.txt', size: 10 });
    await mkdir(join(dir, 'uploads', 'old-run-folder'), { mode: 0o700 }); await writeFile(join(dir, 'uploads', 'old-run-folder', 'x'), 'x');
    const old = new Date(Date.now() - 8 * 24 * 3600_000); await utimes(join(dir, 'uploads', 'old-run-folder'), old, old);
    now += 61 * 60_000; await store.prune(true);
    assert.ok(!(await readdir(join(dir, 'uploads'))).includes(stale.uploadId));
    assert.ok(!(await readdir(join(dir, 'uploads'))).includes('old-run-folder'));
    assert.ok(store.resolve('a', [up.uploadId]).length === 1, 'finished upload kept');
    now += 7 * 24 * 3600_000; await store.prune(true);
    assert.throws(() => store.resolve('a', [up.uploadId]), /upload_not_found/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('message payload: attachments only with messages, at most 10, unique; text may be empty with files', () => {
  const base = { commandId: 'c', sessionId: 's', runtimeId: 'r', bindingEpoch: 1, branchId: 'b', leaseEpoch: 1, expiresAt: Date.now() + 10_000 };
  assert.deepEqual(parseCommand({ ...base, kind: 'prompt', payload: { text: '', attachments: ['u1'] } }).payload.attachments, ['u1']);
  assert.throws(() => parseCommand({ ...base, kind: 'prompt', payload: { text: '' } }), /empty_prompt/);
  assert.throws(() => parseCommand({ ...base, kind: 'command', payload: { text: '/model', attachments: ['u1'] } }), /invalid_payload/);
  assert.throws(() => parseCommand({ ...base, kind: 'prompt', payload: { text: 'x', attachments: ['u1', 'u1'] } }), /duplicate_attachment/);
  assert.throws(() => parseCommand({ ...base, kind: 'prompt', payload: { text: 'x', attachments: Array.from({ length: 11 }, (_, i) => `u${i}`) } }), /too_many_attachments/);
  assert.throws(() => parseCommand({ ...base, kind: 'prompt', payload: { text: 'x', attachments: ['../x'] } }), /invalid_id/);
  assert.throws(() => parseCommand({ ...base, kind: 'prompt', payload: { text: '/model', attachments: ['u1'] } }), /slash_commands_disabled/);
});

test('HTTP: chunked upload, then a message carries the files to Pi as paths on disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-upload-http-')); const port = await freePort(); const secret = randomBytes(32).toString('base64url');
  const app = await startServer({ dataDir: dir, secret, port }); let socket: Socket | undefined;
  const origin = `http://127.0.0.1:${port}`;
  try {
    socket = connect(app.socketPath); socket.setEncoding('utf8'); await once(socket, 'connect');
    const commands: any[] = [];
    const lines = new JsonLines(m => { if (m.type === 'command') { commands.push(m); socket!.write(JSON.stringify({ type: 'result', commandId: m.commandId, status: 'dispatched_unconfirmed' }) + '\n'); } });
    socket.on('data', (chunk: string) => lines.push(chunk));
    const session = { sessionId: 's1', runtimeId: 'r1', bindingEpoch: 1, branchId: 'b1', title: 'Upload', cwd: '/tmp', mode: 'attach', workState: 'idle', capabilities: ['prompt', 'steer', 'follow_up', 'abort', 'attachments'], messages: [] };
    socket.write(JSON.stringify({ type: 'register', secret, session }) + '\n');
    for (let i = 0; i < 50 && !app.core.sessions.has('s1'); i++) await new Promise(r => setTimeout(r, 10));
    const owner = app.core.claim(app.core.makePairing(['s1'], true, true).token, 'Phone');
    const viewer = app.core.claim(app.core.makePairing(['s1'], false).token, 'Viewer');
    const api = async (cookie: string, path: string, method = 'GET', data?: unknown) => {
      const response = await fetch(origin + path, { method, headers: { Origin: origin, 'X-Pi-Remote': '1', 'Content-Type': 'application/json', Cookie: `pi_remote=${cookie}` }, body: data === undefined ? undefined : JSON.stringify(data) });
      return { status: response.status, data: await response.json() as any };
    };
    assert.equal((await api(viewer.secret, '/api/sessions/s1/uploads', 'POST', { name: 'a.txt', size: 3 })).data.error, 'forbidden', 'read-only devices cannot upload');
    const file = Buffer.concat([PNG, randomBytes(UPLOAD_CHUNK_BYTES)]);
    const created = await api(owner.secret, '/api/sessions/s1/uploads', 'POST', { name: 'layar.png', size: file.length, type: 'image/png' });
    assert.equal(created.status, 200); assert.equal(created.data.chunkSize, UPLOAD_CHUNK_BYTES);
    const id = created.data.uploadId as string;
    assert.equal((await api(viewer.secret, `/api/uploads/${id}`, 'POST', { offset: 0, data: 'AAAA' })).data.error, 'upload_not_found');
    assert.equal((await api(owner.secret, `/api/uploads/${id}`, 'POST', { offset: 0, data: 'not base64!' })).data.error, 'upload_chunk_invalid');
    for (let offset = 0; offset < file.length; offset += UPLOAD_CHUNK_BYTES) {
      const r = await api(owner.secret, `/api/uploads/${id}`, 'POST', { offset, data: file.subarray(offset, offset + UPLOAD_CHUNK_BYTES).toString('base64') });
      assert.equal(r.status, 200, JSON.stringify(r.data));
    }
    const lease = (await api(owner.secret, '/api/sessions/s1/lease', 'POST', {})).data;
    const envelope = (payload: unknown) => ({ commandId: randomUUID(), sessionId: 's1', runtimeId: 'r1', bindingEpoch: 1, branchId: 'b1', leaseEpoch: lease.leaseEpoch, kind: 'prompt', payload, expiresAt: Date.now() + 20_000 });
    assert.equal((await api(owner.secret, '/api/sessions/s1/commands', 'POST', envelope({ text: 'x', attachments: ['missingmissingmi'] }))).data.error, 'upload_not_found');
    assert.equal(commands.length, 0, 'nothing reaches Pi when a file is missing');
    // An older Pi extension does not advertise attachments and would drop the files: refused up front.
    socket.write(JSON.stringify({ type: 'snapshot', session: { ...session, capabilities: ['prompt'] } }) + '\n');
    for (let i = 0; i < 50 && app.core.sessions.get('s1')!.session.capabilities.includes('attachments'); i++) await new Promise(r => setTimeout(r, 10));
    assert.equal((await api(owner.secret, '/api/sessions/s1/commands', 'POST', envelope({ text: 'x', attachments: [id] }))).data.error, 'attachments_unsupported');
    socket.write(JSON.stringify({ type: 'snapshot', session }) + '\n');
    for (let i = 0; i < 50 && !app.core.sessions.get('s1')!.session.capabilities.includes('attachments'); i++) await new Promise(r => setTimeout(r, 10));
    const sent = await api(owner.secret, '/api/sessions/s1/commands', 'POST', envelope({ text: 'look at this', attachments: [id] }));
    assert.equal(sent.data.status, 'dispatched_unconfirmed');
    const dispatched = commands[0];
    assert.equal(dispatched.payload.text, 'look at this');
    assert.equal(dispatched.payload.attachments.length, 1);
    const attachment = dispatched.payload.attachments[0];
    assert.equal(attachment.name, 'layar.png'); assert.equal(attachment.mimeType, 'image/png'); assert.equal(attachment.size, file.length);
    assert.ok(attachment.path.startsWith(join(dir, 'uploads')));
    assert.deepEqual(await readFile(attachment.path), file);
    assert.equal(JSON.stringify(app.store.replay(0)).includes(attachment.path), false, 'file paths are not journaled');
    const del = await api(owner.secret, `/api/uploads/${id}`, 'DELETE');
    assert.equal(del.status, 200);
    await assert.rejects(stat(attachment.path));
  } finally { socket?.destroy(); await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('Wi-Fi path: a full 512 KiB chunk fits in one sealed request and plaintext uploads are refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-upload-seal-')); const port = await freePort(); const secret = randomBytes(32).toString('base64url');
  const app = await startServer({ dataDir: dir, secret, port, host: '0.0.0.0', allowHttp: true, interfaceAddresses: () => ['127.0.0.1', '192.168.1.10'], hiddenAddresses: () => [], remoteAddressOf: req => String(req.headers['x-test-peer'] ?? req.socket.remoteAddress) });
  const origin = `http://127.0.0.1:${port}`; let ipc: Socket | undefined;
  try {
    ipc = connect(app.socketPath); await once(ipc, 'connect');
    ipc.write(JSON.stringify({ type: 'register', secret, session: { sessionId: 's1', runtimeId: 'r1', bindingEpoch: 1, branchId: 'b', title: 'x', cwd: '/tmp', mode: 'attach', workState: 'idle', capabilities: ['prompt'], messages: [] } }) + '\n');
    for (let i = 0; i < 50 && !app.core.sessions.has('s1'); i++) await new Promise(r => setTimeout(r, 10));
    const pairing = app.core.makeWifiPairing(['s1']);
    const sealedFetch = async (creds: { device: string; key: string }, method: string, path: string, payload?: unknown) => {
      const sealed = browserSeal.sealRequest(creds, method, path, payload, Date.now());
      const response = await fetch(origin + path, { method, headers: { 'X-Test-Peer': '192.168.1.20', Origin: origin, 'X-Pi-Remote': '1', ...sealed.headers }, body: sealed.body });
      const text = await response.text();
      return { status: response.status, text, data: (response.headers.get('content-type') ?? '').startsWith(seal.SEAL_CONTENT_TYPE) ? browserSeal.openResponse(creds, sealed.context, text) : JSON.parse(text || '{}') };
    };
    const claim = await sealedFetch({ device: `pair:${pairing.requestId}`, key: pairing.key }, 'POST', '/api/pair', {});
    const creds = { device: claim.data.clientId, key: pairing.key };
    const chunk = randomBytes(UPLOAD_CHUNK_BYTES);
    const created = await sealedFetch(creds, 'POST', '/api/sessions/s1/uploads', { name: 'data.bin', size: chunk.length });
    assert.equal(created.status, 200);
    const plain = await fetch(`${origin}/api/uploads/${created.data.uploadId}`, { method: 'POST', headers: { 'X-Test-Peer': '192.168.1.20', Origin: origin, 'X-Pi-Remote': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ offset: 0, data: chunk.toString('base64') }) });
    assert.equal(plain.status, 401);
    const put = await sealedFetch(creds, 'POST', `/api/uploads/${created.data.uploadId}`, { offset: 0, data: chunk.toString('base64') });
    assert.equal(put.status, 200, put.text.slice(0, 200)); assert.equal(put.data.done, true);
    assert.ok(!put.text.includes('data.bin'), 'the response is sealed');
    assert.deepEqual(await readFile(join(dir, 'uploads', created.data.uploadId, 'data.bin')), chunk);
  } finally { ipc?.destroy(); await app.close(); await rm(dir, { recursive: true, force: true }); }
});

test('bridge: images go inline and every file is listed by path; snapshots never carry image bytes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-attach-files-'));
  const socketPath = join(dir, 'bridge.sock'); const secretFile = join(dir, 'bridge.secret');
  await writeFile(secretFile, 'test-secret', { mode: 0o600 });
  const results: Record<string, any>[] = [];
  const server = createServer(socket => {
    socket.setEncoding('utf8');
    const lines = new JsonLines(record => { if (record.type === 'register') socket.write('{"type":"registered"}\n'); if (record.type === 'result') results.push(record); });
    socket.on('data', (chunk: string) => lines.push(chunk));
  });
  server.listen(socketPath); await once(server, 'listening');
  const image = join(dir, 'layar.png'); await writeFile(image, PNG);
  const csv = join(dir, 'data.csv'); await writeFile(csv, 'a,b\n');
  const sent: { content: any; options: any }[] = [];
  const messages: unknown[] = [];
  const pi: AttachPi = { on: () => {}, registerCommand: () => {}, getThinkingLevel: () => 'off', sendUserMessage: (content, options) => { sent.push({ content, options }); } };
  let model: any = { provider: 'p', id: 'm', input: ['text', 'image'] };
  let idle = true;
  const ctx: AttachContext = {
    mode: 'tui', cwd: dir, get model() { return model; }, isIdle: () => idle, abort: () => {}, ui: { notify: () => {} },
    sessionManager: { getSessionId: () => 'sess', getLeafId: () => 'leaf', getSessionName: () => 'T', buildSessionProjection: () => ({ messages }) },
  };
  const bridge = new AttachBridge(pi, { socketPath, secretFile, binding: { runtimeId: 'rt', epoch: 0, enabled: false } });
  const files = [
    { name: 'layar.png', path: image, mimeType: 'image/png', size: PNG.length },
    { name: 'data.csv', path: csv, mimeType: 'text/csv', size: 4 },
  ];
  const waitResult = async (id: string) => { for (let i = 0; i < 100 && !results.some(r => r.commandId === id); i++) await new Promise(r => setTimeout(r, 10)); return results.find(r => r.commandId === id); };
  try {
    await bridge.start(ctx); await new Promise(r => setTimeout(r, 10));
    const session = bridge.snapshot();
    const command: BridgeCommand = { type: 'command', commandId: 'f1', sessionId: session.sessionId, runtimeId: session.runtimeId, bindingEpoch: session.bindingEpoch, branchId: session.branchId, kind: 'prompt', payload: { text: 'fix this layout', attachments: files } };
    assert.equal(bridge.handleCommand(command).status, 'dispatched_unconfirmed');
    assert.equal((await waitResult('f1'))?.status, 'dispatched_unconfirmed');
    const [first] = sent;
    assert.ok(Array.isArray(first?.content));
    assert.equal(first!.content[0].type, 'text');
    assert.equal(first!.content[0].text, `fix this layout\n\n${ATTACHMENT_HEADING}\n- ${image} (image/png, 16 B)\n- ${csv} (text/csv, 4 B)`);
    assert.deepEqual(first!.content.slice(1), [{ type: 'image', data: PNG.toString('base64'), mimeType: 'image/png' }]);
    assert.equal(first!.options.expandPromptTemplates, false);
    // A model without image input gets paths only.
    model = { provider: 'p', id: 'text-only', input: ['text'] };
    bridge.handleCommand({ ...command, commandId: 'f2', payload: { text: '', attachments: files } });
    await waitResult('f2');
    assert.equal(sent[1]!.content.length, 1);
    assert.ok(sent[1]!.content[0].text.startsWith(ATTACHMENT_HEADING), 'files alone need no typed text');
    // Busy Pi: a follow-up with files is queued, a plain prompt is refused.
    idle = false;
    bridge.handleCommand({ ...command, commandId: 'f3' });
    assert.match(String((await waitResult('f3'))?.error), /busy/);
    bridge.handleCommand({ ...command, commandId: 'f4', kind: 'follow_up' });
    assert.equal((await waitResult('f4'))?.status, 'dispatched_unconfirmed');
    assert.equal(sent[2]!.options.deliverAs, 'followUp');
    // A file that vanished from disk is a clear rejection.
    model = { provider: 'p', id: 'm', input: ['text', 'image'] };
    bridge.handleCommand({ ...command, commandId: 'f5', kind: 'steer', payload: { text: 'x', attachments: [{ ...files[0]!, path: join(dir, 'gone.png') }] } });
    assert.match(String((await waitResult('f5'))?.error), /not found on this computer/);
    // Malformed attachment records from the daemon are refused.
    bridge.handleCommand({ ...command, commandId: 'f6', payload: { text: 'x', attachments: [{ name: 'a', path: 'relative', mimeType: 'x', size: 1 }] } });
    assert.match(String((await waitResult('f6'))?.error), /Invalid attachments/);
    // Pi keeps the image in the session; the phone's snapshot only learns that there was one.
    messages.push({ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', data: 'A'.repeat(500_000), mimeType: 'image/png' }], timestamp: 1 });
    messages.push({ role: 'toolResult', toolCallId: 't', content: [{ type: 'image', data: 'B'.repeat(500_000), mimeType: 'image/jpeg' }], timestamp: 2 });
    const snap = bridge.snapshot();
    assert.equal(snap.truncated, undefined);
    assert.deepEqual((snap.messages[0] as any).content[1], { type: 'image', mimeType: 'image/png' });
    assert.deepEqual((snap.messages[1] as any).content[0], { type: 'image', mimeType: 'image/jpeg' });
    assert.ok((messages[0] as any).content[1].data.length === 500_000, 'Pi\'s own message is untouched');
  } finally { bridge.stop(); server.close(); await rm(dir, { recursive: true, force: true }); }
});

test('web shows typed text and file chips from the message the bridge builds', () => {
  assert.equal(WEB_HEADING, ATTACHMENT_HEADING);
  const files = [{ name: 'photo.jpg', path: '/home/u/.pi/remote-control/uploads/abc/photo.jpg', mimeType: 'image/jpeg', size: 2_200_000 }, { name: 'log (1).txt', path: '/x/log (1).txt', mimeType: 'text/plain', size: 900 }];
  const text = attachmentText('Why the error?\n', files);
  // Pi appends image notes after the prompt and the web shows image blocks as "[image]".
  const parsed = splitAttachments(`${text}\n\n[Image: original 4000x3000, displayed at 2000x1500.]\n[image]`);
  assert.equal(parsed.text, 'Why the error?');
  assert.deepEqual(parsed.files.map((f: any) => [f.name, f.size]), [['photo.jpg', '2.1 MB'], ['log (1).txt', '900 B']]);
  assert.equal(splitAttachments(attachmentText('', files)).text, '');
  // Typed text that merely mentions the heading stays as typed.
  const typed = `${ATTACHMENT_HEADING}\nthis is not a file list`;
  assert.deepEqual(splitAttachments(typed), { text: typed, files: [] });
  assert.equal(formatBytes(1536), '1.5 KB'); assert.equal(fileBadge('report.pdf'), 'PDF'); assert.equal(fileBadge('Makefile'), 'FILE');
});
