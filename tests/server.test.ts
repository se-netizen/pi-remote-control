import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, connect, type Socket } from 'node:net';
import { once } from 'node:events';
import { randomBytes, randomUUID } from 'node:crypto';
import { startServer } from '../src/server.js';

async function freePort():Promise<number>{const server=createServer();server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as any).port;await new Promise<void>(r=>server.close(()=>r()));return port;}
test('HTTP + IPC: direct link pairing, cookie, CSRF, scope, dispatch, dedup, revoke and static shell',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'pi-server-'));const port=await freePort();const secret=randomBytes(32).toString('base64url');
  const app=await startServer({dataDir:dir,secret,port});let socket:Socket|undefined;
  const origin=`http://127.0.0.1:${port}`;let cookie='';
  async function api(path:string,method='GET',data?:unknown,extra:Record<string,string>={}){
    const response=await fetch(origin+path,{method,headers:{Origin:origin,'X-Pi-Remote':'1','Content-Type':'application/json',...(cookie?{Cookie:cookie}:{}),...extra},body:data?JSON.stringify(data):undefined});return {response,data:await response.json() as any};
  }
  try{
    assert.equal((await api('/api/sessions')).response.status,401);
    socket=connect(app.socketPath);socket.setEncoding('utf8');await once(socket,'connect');let buffer='';let dispatches=0;
    socket.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\n')){const i=buffer.indexOf('\n');const m=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);if(m.type==='command'){dispatches++;socket!.write(JSON.stringify({type:'result',commandId:m.commandId,status:'dispatched_unconfirmed'})+'\n');}}});
    const session={sessionId:'s1',runtimeId:'r1',bindingEpoch:1,branchId:'b1',title:'Real bridge fixture',cwd:'/tmp',mode:'attach',workState:'idle',capabilities:['prompt','abort'],messages:[]};
    socket.write(JSON.stringify({type:'register',secret,session})+'\n');
    for(let i=0;i<20&&!app.core.sessions.has('s1');i++)await new Promise(r=>setTimeout(r,10));assert.ok(app.core.sessions.has('s1'));
    const pairing=app.core.makePairing(['s1'],true,true);
    const claim=await api('/api/pair','POST',{token:pairing.token},{'User-Agent':'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'});
    assert.equal(claim.response.status,200);assert.equal(claim.data.paired,true);assert.equal(claim.data.name,'iPhone · Safari');assert.equal(claim.data.secret,undefined);
    assert.equal((await api('/api/pair','POST',{token:pairing.token})).data.error,'invalid_pairing');
    const header=claim.response.headers.get('set-cookie')!;assert.match(header,/HttpOnly/);assert.match(header,/SameSite=Strict/);assert.match(header,/Max-Age=25\d{5}/);cookie=header.split(';')[0]!;
    const bootstrap=await api('/api/bootstrap');assert.equal(bootstrap.data.paired,true);
    assert.equal((await api('/api/sessions')).data.sessions.length,1);
    assert.equal((await api('/api/sessions/s1/lease','POST',{}, {'X-Pi-Remote':'0'})).data.error,'csrf_required');
    assert.equal((await api('/api/sessions/s1/lease','POST',{}, {Origin:'https://evil.example'})).data.error,'invalid_origin');
    const lease=(await api('/api/sessions/s1/lease','POST',{})).data;
    const command={commandId:randomUUID(),sessionId:'s1',runtimeId:'r1',bindingEpoch:1,branchId:'b1',leaseEpoch:lease.leaseEpoch,kind:'prompt',payload:{text:'test'},expiresAt:Date.now()+29_000};
    assert.equal((await api('/api/sessions/s1/commands','POST',command)).data.status,'dispatched_unconfirmed');
    await api('/api/sessions/s1/commands','POST',command);assert.equal(dispatches,1);
    for(const removed of ['/api/workflows','/api/config','/api/models'])assert.equal((await api(removed)).response.status,404,'the orchestrator API is gone');
    const shell=await fetch(origin+'/');assert.equal(shell.status,200);assert.match(shell.headers.get('content-security-policy')!,/frame-ancestors 'none'/);
    const traversal=await fetch(origin+'/%2e%2e/package.json');assert.equal(traversal.status,404);
    const devices=await api('/api/devices');const id=devices.data.devices[0].clientId;
    assert.equal((await api('/api/devices/'+id,'DELETE')).response.status,200);assert.equal((await api('/api/sessions')).response.status,401);
  }finally{socket?.destroy();await app.close();await rm(dir,{recursive:true,force:true});}
});

test('live stream sends a snapshot, per-token deltas, and closes when the device is revoked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pi-sse-')); const port = await freePort(); const secret = randomBytes(32).toString('base64url');
  const app = await startServer({ dataDir: dir, secret, port }); let socket: Socket | undefined;
  const origin = `http://127.0.0.1:${port}`;
  try {
    socket = connect(app.socketPath); socket.setEncoding('utf8'); await once(socket, 'connect');
    const session = { sessionId: 's1', runtimeId: 'r1', bindingEpoch: 1, branchId: 'b1', title: 'SSE', cwd: '/tmp', mode: 'attach', workState: 'running', capabilities: ['prompt'], messages: [{ role: 'user', content: 'hai', timestamp: 1 }] };
    socket.write(JSON.stringify({ type: 'register', secret, session }) + '\n');
    for (let i = 0; i < 50 && !app.core.sessions.has('s1'); i++) await new Promise(r => setTimeout(r, 10));
    const claim = app.core.claim(app.core.makePairing(['s1'], true, true).token, 'Phone');
    const controller = new AbortController();
    const response = await fetch(`${origin}/api/stream?session=s1`, { headers: { Cookie: `pi_remote=${claim.secret}` }, signal: controller.signal });
    assert.equal(response.status, 200); assert.match(response.headers.get('content-type')!, /text\/event-stream/);
    const reader = response.body!.getReader(); const decoder = new TextDecoder(); let text = '';
    const until = async (pattern: RegExp) => { for (let i = 0; i < 100 && !pattern.test(text); i++) { const { value, done } = await reader.read(); if (done) break; text += decoder.decode(value); } return pattern.test(text); };
    assert.ok(await until(/event: snapshot\ndata: .*"hai"/), 'initial snapshot carries the transcript');
    socket.write(JSON.stringify({ type: 'delta', sessionId: 's1', delta: { kind: 'text', index: 0, text: 'Halo', messageTs: 2 } }) + '\n');
    assert.ok(await until(/event: delta\ndata: \{"kind":"text","index":0,"text":"Halo","messageTs":2\}/), 'delta is forwarded immediately');
    socket.write(JSON.stringify({ type: 'snapshot', session: { ...session, workState: 'idle' } }) + '\n');
    assert.ok(await until(/"workState":"idle"/), 'changed snapshot is pushed');
    assert.equal(app.store.replay(0).events.some(e => e.type === 'delta'), false, 'deltas are never journaled');
    const unauth = await fetch(`${origin}/api/stream?session=s1`); assert.equal(unauth.status, 401);
    const other = await fetch(`${origin}/api/stream?session=nope`, { headers: { Cookie: `pi_remote=${claim.secret}` } }); assert.equal(other.status, 404);
    app.core.revokeLocal(claim.clientId);
    assert.ok(await until(/event: gone\ndata: \{"error":"device_revoked"\}/), 'revocation ends the stream');
    controller.abort();
  } finally { socket?.destroy(); await app.close(); await rm(dir, { recursive: true, force: true }); }
});
