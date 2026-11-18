import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { BackgroundManager } from '../src/background.js';

function fakeTmux(sessions = new Map<string, string>()) {
  const calls: string[][] = [];
  const exec = async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    if (args[0] === '-V') return { code: 0, stdout: 'tmux 3.4\n' };
    if (args[0] === 'new-session') { sessions.set(args[args.indexOf('-s') + 1]!, args[args.indexOf('-c') + 1]!); return { code: 0, stdout: '' }; }
    if (args[0] === 'list-sessions') return { code: 0, stdout: [...sessions].map(([n, cwd]) => `${n}\t1800000000\t${cwd}`).join('\n') };
    if (args[0] === 'has-session') return { code: sessions.has(args[2]!.slice(1)) ? 0 : 1, stdout: '' };
    if (args[0] === 'kill-session') { sessions.delete(args[2]!.slice(1)); return { code: 0, stdout: '' }; }
    return { code: 1, stdout: '' };
  };
  return { exec, calls, sessions };
}

test('folders must exist inside the home directory, also after resolving symlinks', async () => {
  const home = await mkdtemp(join(tmpdir(), 'pi-home-'));
  const outside = await mkdtemp(join(tmpdir(), 'pi-outside-'));
  try {
    await mkdir(join(home, 'proj'));
    await symlink(outside, join(home, 'escape'));
    const bg = new BackgroundManager({ home, exec: fakeTmux().exec });
    assert.equal(await bg.validateFolder(join(home, 'proj')), join(home, 'proj'));
    assert.equal(await bg.validateFolder('~/proj'), join(home, 'proj'));
    await assert.rejects(bg.validateFolder(outside), /folder_outside_home/);
    await assert.rejects(bg.validateFolder(join(home, 'escape')), /folder_outside_home/, 'a symlink cannot escape home');
    await assert.rejects(bg.validateFolder(join(home, 'nope')), /folder_not_found/);
    await assert.rejects(bg.validateFolder(''), /invalid_folder/);
  } finally { await rm(home, { recursive: true, force: true }); await rm(outside, { recursive: true, force: true }); }
});

test('tmux backend: hidden session with the registering Pi launcher and environment; stop asks Pi first, then kills', async () => {
  const tmux = fakeTmux();
  const bg = new BackgroundManager({ exec: tmux.exec, env: { PI_REMOTE_SOCKET: '/run/x.sock' } });
  assert.equal(await bg.backend(), 'tmux');
  bg.setLauncher({ node: '/opt/node/bin/node', cli: '/opt/pi/cli.js', path: '/opt/node/bin:/usr/bin', agentDir: '/home/u/.pi/agent', extensions: ['/opt/rc/remote-control.ts', '--evil'] });
  bg.setLauncher({ node: 'relative-node', cli: '/x' }); // ignored: launchers must be absolute
  const entry = await bg.start({ cwd: '/home/u/proj', sessionFile: '/home/u/.pi/agent/sessions/s.jsonl' });
  assert.match(entry.name, /^pi-rc-[a-f0-9]{6}$/); assert.equal(entry.backend, 'tmux');
  const call = tmux.calls.find(c => c[1] === 'new-session')!;
  assert.deepEqual(call.slice(call.indexOf('--') + 1), ['/opt/node/bin/node', '/opt/pi/cli.js', '-e', '/opt/rc/remote-control.ts', '--session', '/home/u/.pi/agent/sessions/s.jsonl'], 'extensions loaded with -e are passed on; flags are not injectable');
  const env = call.flatMap((v, i) => call[i - 1] === '-e' ? [v] : []);
  for (const pair of ['PI_REMOTE_AUTOSTART=1', `PI_REMOTE_BACKGROUND=${entry.name}`, 'PI_REMOTE_BACKGROUND_BACKEND=tmux', 'PI_REMOTE_SOCKET=/run/x.sock', 'PATH=/opt/node/bin:/usr/bin', 'PI_CODING_AGENT_DIR=/home/u/.pi/agent']) assert.ok(env.includes(pair), pair);
  assert.equal(bg.attachCommand(entry.name), `tmux attach -t ${entry.name}`);
  // Pi ignores the polite request: the tmux session is killed after the grace period.
  let asked = 0;
  await bg.stop(entry.name, () => { asked++; return true; }, 300);
  assert.equal(asked, 1); assert.ok(tmux.calls.some(c => c[1] === 'kill-session' && c[3] === `=${entry.name}`));
  assert.equal(bg.list().length, 0);
  await assert.rejects(bg.stop('pi-rc-000000', () => true), /background_not_found/);
});

test('tmux sessions survive a daemon restart: pi-rc-* sessions are adopted, others ignored, ended ones dropped', async () => {
  const sessions = new Map([['pi-rc-abc123', '/home/u/a'], ['work', '/home/u/b'], ['pi-rc-evil;rm', '/x']]);
  const bg = new BackgroundManager({ exec: fakeTmux(sessions).exec });
  await bg.reconcile();
  assert.deepEqual(bg.list().map(e => [e.name, e.cwd]), [['pi-rc-abc123', '/home/u/a']]);
  sessions.delete('pi-rc-abc123'); await bg.reconcile();
  assert.deepEqual(bg.list(), []);
});

test('without tmux (or on Windows) Pi runs in RPC mode; its dialogs are cancelled so it never hangs', async () => {
  const exec = async () => ({ code: 127, stdout: '' });
  let spawned: { command: string; args: string[]; env: NodeJS.ProcessEnv } | undefined;
  const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new PassThrough(), pid: 4242, exitCode: null, signalCode: null, kill(): boolean { (this as unknown as EventEmitter).emit('close'); return true; } });
  const answers: string[] = []; child.stdin.on('data', d => answers.push(String(d)));
  const bg = new BackgroundManager({ exec, spawnRpc: (command, args, opts) => { spawned = { command, args, env: opts.env }; return child as any; } });
  assert.equal(await bg.backend(), 'rpc');
  const entry = await bg.start({ cwd: '/home/u/proj' });
  assert.equal(entry.backend, 'rpc'); assert.equal(entry.pid, 4242);
  assert.deepEqual(spawned!.args.slice(-2), ['--mode', 'rpc']);
  assert.equal(spawned!.env.PI_REMOTE_BACKGROUND_BACKEND, 'rpc');
  child.stdout.write(JSON.stringify({ type: 'extension_ui_request', id: 'q1', method: 'confirm', title: 'Delete?' }) + '\n');
  child.stdout.write(JSON.stringify({ type: 'extension_ui_request', id: 'n1', method: 'notify', message: 'hi' }) + '\n');
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(answers.map(a => JSON.parse(a)), [{ type: 'extension_ui_response', id: 'q1', cancelled: true }]);
  assert.equal(bg.attachCommand(entry.name), undefined, 'no terminal to peek into');
  child.emit('close');
  assert.equal(bg.list().length, 0, 'the entry disappears when Pi exits');
});

test('detach handoff waits until the old Pi process has exited before starting the new one', async () => {
  const tmux = fakeTmux(); let alive = true; setTimeout(() => { alive = false; }, 300);
  const bg = new BackgroundManager({ exec: tmux.exec, isAlive: () => alive });
  const started = Date.now();
  await bg.start({ cwd: '/home/u/p', sessionFile: '/s.jsonl', afterPid: 999 });
  assert.ok(Date.now() - started >= 250, 'waited for the terminal Pi to exit');
  alive = true;
  await assert.rejects(bg.start({ cwd: '/home/u/p', afterPid: 999, waitMs: 200 }), /handoff_timeout/);
});
