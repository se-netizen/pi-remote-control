import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
// The browser helper is deliberately shared unchanged with the app.
// @ts-ignore -- buildless browser JavaScript has no emitted declaration file.
import { contextKey, draftKey, createCommandId, isConfirmed, messageParts, hasCapability, expiresAtMs, parseMarkdown, parseInline, toolSummary, mergeStreamText, resultText, matchCommands } from '../web/helpers.js';

test('browser distinguishes transport dispatch from Pi acceptance', () => {
  for (const status of ['received', 'dispatching', 'dispatched_unconfirmed', 'indeterminate', 'failed', 'rejected']) assert.equal(isConfirmed(status), false, status);
  for (const status of ['pi_acknowledged', 'accepted', 'observed', 'completed']) assert.equal(isConfirmed(status), true, status);
});

test('LAN HTTP command IDs use cryptographic randomness when randomUUID is unavailable', () => {
  let calls = 0;
  const id = createCommandId({ getRandomValues: (bytes: Uint8Array) => { calls++; return bytes.fill(255); } });
  assert.equal(id, 'ffffffff-ffff-4fff-bfff-ffffffffffff');
  assert.equal(calls, 1);
  assert.equal(createCommandId({ randomUUID: () => 'native-uuid' }), 'native-uuid');
});

test('draft identity is scoped to host origin and session, context identity includes binding and branch', () => {
  assert.notEqual(draftKey('https://host-a', 'session'), draftKey('https://host-b', 'session'));
  assert.notEqual(draftKey('https://host-a', 'one'), draftKey('https://host-a', 'two'));
  const session = { sessionId: 'one', runtimeId: 'runtime', bindingEpoch: 1, branchId: 'main', leafEntryId: 'one' };
  assert.equal(contextKey(session), contextKey({ ...session, leafEntryId: 'two' }));
  assert.notEqual(contextKey(session), contextKey({ ...session, bindingEpoch: 2 }));
  assert.notEqual(contextKey(session), contextKey({ ...session, branchId: 'fork' }));
});

test('message content remains plain text and tool payloads remain separate detail', () => {
  const parts = messageParts({ content: [{ type: 'text', text: '<img src=x onerror=alert(1)>' }, { type: 'toolCall', name: 'read', arguments: { path: 'README.md' } }, { type: 'image', data: 'secret-base64' }] });
  assert.equal(parts[0].text, '<img src=x onerror=alert(1)>');
  assert.equal(parts[1].type, 'detail');
  assert.equal(parts[1].label, 'Tool · read');
  assert.equal(parts[2].text.includes('secret-base64'), false);
  assert.deepEqual(messageParts({ content: null }), [{ type: 'text', text: '' }]);
});

test('composer follows explicit advertised capabilities and server lease expiry', () => {
  assert.equal(hasCapability({ capabilities: ['prompt'] }, 'steer'), false);
  assert.equal(hasCapability({ capabilities: ['followUp'] }, 'follow_up'), true);
  assert.equal(hasCapability({ capabilities: { stop: true } }, 'abort'), true);
  assert.equal(hasCapability({}, 'prompt'), false);
  assert.equal(expiresAtMs('2026-01-01T00:00:00.000Z'), 1767225600000);
  assert.equal(expiresAtMs('invalid'), 0);
});

test('service worker never intercepts API, authenticated, cross-origin, or mutation requests', async () => {
  const handlers = new Map<string, (event: any) => void>();
  const source = await readFile(new URL('../web/sw.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, { self: { location: { origin: 'https://pi.local' }, addEventListener: (type: string, callback: (event: any) => void) => handlers.set(type, callback) }, URL });
  const fetchHandler = handlers.get('fetch')!;
  for (const request of [
    new Request('https://pi.local/api/sessions'),
    new Request('https://pi.local/api/events?cursor=12'),
    new Request('https://other.local/app.js'),
    new Request('https://pi.local/app.js', { headers: { Authorization: 'Bearer secret' } }),
    new Request('https://pi.local/', { method: 'POST' }),
    new Request('https://pi.local/private.json'),
  ]) {
    let intercepted = false;
    fetchHandler({ request, respondWith: () => { intercepted = true; } });
    assert.equal(intercepted, false, `${request.method} ${request.url}`);
  }
});

test('markdown parser yields plain data and only http(s) links', () => {
  const blocks = parseMarkdown('# Judul\n\nTeks **tebal** dan `kode` <script>alert(1)</script>\n\n```ts\nconst a = "<b>";\n```\n- satu\n- dua\n\n> kutipan');
  assert.deepEqual(blocks.map((b: any) => b.type), ['heading', 'paragraph', 'code', 'list', 'quote']);
  assert.equal(blocks[2].text, 'const a = "<b>";');
  assert.ok(JSON.stringify(blocks).includes('<script>alert(1)</script>'), 'HTML stays literal text');
  const links = parseInline('[a](javascript:alert(1)) [b](https://pi.dev/x) [c](data:text/html,x)');
  assert.deepEqual(links.filter((p: any) => p.type === 'link').map((p: any) => p.href), ['https://pi.dev/x']);
  assert.deepEqual(parseMarkdown('```\nbelum ditutup'), [{ type: 'code', lang: '', text: 'belum ditutup' }], 'an unterminated fence while streaming still renders');
});

test('tool rows summarise the call the way Claude Code does', () => {
  assert.deepEqual(toolSummary('bash', { command: 'npm   test\n--watch' }), { label: 'Bash', detail: 'npm test --watch' });
  assert.deepEqual(toolSummary('read', { path: 'src/app.ts', offset: 10 }), { label: 'Read', detail: 'src/app.ts' });
  assert.deepEqual(toolSummary('grep', { pattern: 'TODO', path: 'src' }), { label: 'Grep', detail: 'TODO · src' });
  const long = toolSummary('custom_tool', { query: 'x'.repeat(300) }).detail; assert.ok(long.length <= 120 && long.endsWith('…'));
  assert.equal(resultText({ content: [{ type: 'text', text: 'ok' }, { type: 'image', data: 'AAAA' }] }), 'ok\n[gambar]');
});

test('streamed characters extend the snapshot without flicker and yield to a newer snapshot', () => {
  assert.equal(mergeStreamText('Hal', 'Halo dunia'), 'Halo dunia');
  assert.equal(mergeStreamText('Halo dunia!', 'Halo dunia'), 'Halo dunia!');
  assert.equal(mergeStreamText('Versi baru', 'Versi lama yang panjang'), 'Versi baru', 'divergent stream text never wins over the snapshot');
  assert.equal(mergeStreamText(undefined, 'abc'), 'abc');
});

test('slash palette ranks prefix matches first and also searches descriptions', async () => {
  const commands = [{ name: 'model' }, { name: 'compact', description: 'Padatkan konteks' }, { name: 'skill:commit', description: 'Buat commit' }, { name: 'mcp' }];
  assert.deepEqual(matchCommands(commands, '').map((c: any) => c.name), ['model', 'compact', 'skill:commit', 'mcp']);
  assert.deepEqual(matchCommands(commands, 'com').map((c: any) => c.name), ['compact', 'skill:commit']);
  assert.deepEqual(matchCommands(commands, 'konteks').map((c: any) => c.name), ['compact']);
  assert.deepEqual(matchCommands(commands, 'zzz'), []);
});
