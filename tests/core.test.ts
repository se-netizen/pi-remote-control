import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/store.js';
import { RemoteCore } from '../src/core.js';
import { hash, type Command, type Session, type Device } from '../src/protocol.js';
import { parseSettings } from '../src/settings.js';

const session:Session={sessionId:'session-1',runtimeId:'runtime-1',bindingEpoch:1,branchId:'branch-1',title:'Project',cwd:'/tmp/project',mode:'attach',workState:'idle',capabilities:['prompt','steer','follow_up','abort'],messages:[]};
function setup() {
  let now=10_000;const store=new Store(':memory:');const core=new RemoteCore(store,{wall:()=>now,mono:()=>now});
  const owner={};const calls:Command[]=[];
  core.register(session,async c=>{calls.push(c);return {status:'dispatched_unconfirmed'};},owner);
  const device:Device={clientId:'dev-1',name:'Phone',grants:[{sessionId:session.sessionId,control:true}],owner:true,revoked:false,createdAt:now,expiresAt:now+8*3600_000};
  store.saveDevice(device,hash('device-secret'));const lease=core.acquire(device,session.sessionId);
  const command=(changes:Partial<Command>={}):Command=>({commandId:randomUUID(),sessionId:session.sessionId,runtimeId:session.runtimeId,bindingEpoch:1,branchId:session.branchId,leaseEpoch:lease.leaseEpoch,kind:'prompt',payload:{text:'Hello'},expiresAt:now+30_000,...changes});
  return {store,core,owner,calls,device,command,setNow:(value:number)=>{now=value;}};
}
test('same envelope is dispatched once, conflicting reuse rejected, expired retry queries old status',async()=>{
  const f=setup();try {
    const c=f.command();const result=await f.core.command(f.device,c);
    assert.equal(result.status,'dispatched_unconfirmed');assert.equal((await f.core.command(f.device,c)).status,result.status);assert.equal(f.calls.length,1);
    await assert.rejects(f.core.command(f.device,{...c,payload:{text:'different'}}),/command_id_conflict/);
    f.setNow(50_000);assert.equal((await f.core.command(f.device,c)).status,result.status);assert.equal(f.calls.length,1);
  }finally{f.store.close();}
});
test('guards cover viewer, stale branch, revoked lease, slash commands, maximum TTL and size',async()=>{
  const f=setup();try{
    await assert.rejects(f.core.command(f.device,f.command({branchId:'old-branch'})),/stale_context/);
    await assert.rejects(f.core.command(f.device,f.command({payload:{text:'/bash dangerous'}})),/slash_commands_disabled/);
    await assert.rejects(f.core.command(f.device,f.command({payload:{text:'界'.repeat(30_000)}})),/prompt_too_large/);
    await assert.rejects(f.core.command(f.device,f.command({expiresAt:40_001})),/clock_skew/);
    const viewer={...f.device,clientId:'viewer',owner:false,grants:[{sessionId:session.sessionId,control:false}]};f.store.saveDevice(viewer,hash('viewer'));
    await assert.rejects(f.core.command(viewer,f.command()),/forbidden/);
    f.core.revoke(f.device,f.device.clientId);await assert.rejects(f.core.command(f.device,f.command()),/device_revoked/);assert.equal(f.calls.length,0);
  }finally{f.store.close();}
});
test('lease takeover and expiry invalidate stale controller without changing local TUI authority',async()=>{
  const f=setup();try{
    const other={...f.device,clientId:'dev-2'};f.store.saveDevice(other,hash('other'));
    assert.throws(()=>f.core.acquire(other,session.sessionId),/lease_held/);
    const old=f.command();const next=f.core.acquire(other,session.sessionId,true);assert.equal(next.leaseEpoch,2);
    await assert.rejects(f.core.command(f.device,old),/lease_required/);
    f.setNow(40_001);assert.equal(f.core.getLease(session.sessionId),undefined);
  }finally{f.store.close();}
});
test('queued command rechecks context; stop uses priority lane while adapter is pending',async()=>{
  const f=setup();let release!:()=>void;const gate=new Promise<void>(r=>release=r);
  f.core.register(session,async c=>{f.calls.push(c);if(c.kind==='prompt')await gate;return {status:'dispatched_unconfirmed'};},f.owner);
  try{
    const first=f.core.command(f.device,f.command());await new Promise(r=>setImmediate(r));
    const second=f.core.command(f.device,f.command());
    const stop=await f.core.command(f.device,f.command({kind:'abort',payload:{}}));assert.equal(stop.status,'dispatched_unconfirmed');assert.equal(f.calls.length,2);
    f.core.register({...session,branchId:'new-branch'},async()=>({status:'dispatched_unconfirmed'}),f.owner);
    release();await first;const queued=await second;assert.equal(queued.status,'rejected');assert.equal(queued.error,'stale_context');assert.equal(f.calls.length,2);
  }finally{release();f.store.close();}
});
test('pairing link pairs directly, works once, expires, and binds grants to the original session',()=>{
  const f=setup();try{
    const joined:any[]=[];f.core.on('paired',info=>joined.push(info));
    const p=f.core.makePairing([session.sessionId],false);
    const c=f.core.claim(p.token,'iPhone · Safari');
    assert.equal(c.name,'iPhone · Safari');
    assert.throws(()=>f.core.claim(p.token,'Attacker'),/invalid_pairing/,'second use of the same link fails');
    const device=f.core.authenticate(c.secret);assert.deepEqual(device.grants,[{sessionId:session.sessionId,control:false}]);
    assert.ok(device.expiresAt-10_000>=29*24*3_600_000,'paired browsers stay signed in for 30 days');
    assert.deepEqual(joined,[{clientId:c.clientId,name:'iPhone · Safari',sessionIds:[session.sessionId]}],'terminal is told who joined');
    assert.throws(()=>f.core.acquire(device,session.sessionId),/forbidden/,'viewer links cannot control');
    const expired=f.core.makePairing([session.sessionId],true);f.setNow(expired.expiresAt);assert.throws(()=>f.core.claim(expired.token,'Late'),/invalid_pairing/);
  }finally{f.store.close();}
});
test('replay filters session grants and reports retention gaps',()=>{
  const f=setup();try{
    f.core.event('message.completed',{text:'secret'},'different-session');f.core.event('message.completed',{text:'allowed'},session.sessionId);
    const replay=f.core.replay({...f.device,owner:false},0) as any;assert.equal(replay.events.some((e:any)=>e.payload.text==='secret'),false);
    f.store.db.exec('DELETE FROM events WHERE seq<3');assert.equal(f.store.replay(1).resyncRequired,true);
  }finally{f.store.close();}
});
test('restart changes dispatching to indeterminate and never automatically dispatches',()=>{
  const directory=mkdtempSync(join(tmpdir(),'pi-journal-'));try{
    const path=join(directory,'journal.sqlite');let store=new Store(path);
    const c=setup();const command=c.command();c.store.close();
    store.saveCommand({...command,clientId:'test',hash:'hash',status:'dispatching',recordedAt:Date.now()});store.close();
    store=new Store(path);assert.equal(store.command(command.commandId)?.status,'indeterminate');assert.equal(store.command(command.commandId)?.error,'bridge_restarted');store.close();
  }finally{rmSync(directory,{recursive:true});}
});
test('model config accepts role and complexity routing and rejects command injection fields',()=>{
  assert.equal(parseSettings({profiles:{planner:{thinkingLevel:'high'},complexity:{simple:{provider:'p',model:'m',thinkingLevel:'low'}}},maxConcurrency:2}).maxConcurrency,2);
  assert.throws(()=>parseSettings({profiles:{worker:{model:'missing provider'}},maxConcurrency:2}),/model_requires_provider/);
  assert.throws(()=>parseSettings({profiles:{worker:{executable:'curl'}},maxConcurrency:2}),/unknown_model_setting/);
  assert.throws(()=>parseSettings({profiles:{},maxConcurrency:99}),/invalid_concurrency/);
});
test('failure between received journal and event is atomic and permits a known-unsent retry',async()=>{
  const f=setup();const append=f.store.append.bind(f.store);const c=f.command();
  try {
    f.store.append=()=>{throw new Error('injected_disk_fault');};
    await assert.rejects(f.core.command(f.device,c),/injected_disk_fault/);
    assert.equal(f.store.command(c.commandId),undefined);assert.equal(f.calls.length,0);
    f.store.append=append;assert.equal((await f.core.command(f.device,c)).status,'dispatched_unconfirmed');assert.equal(f.calls.length,1);
  }finally{f.store.close();}
});
test('local revoke immediately frees the controller lease',()=>{
  const f=setup();try{
    const other={...f.device,clientId:'dev-other'};f.store.saveDevice(other,hash('other-local'));
    f.core.revokeLocal(f.device.clientId);assert.equal(f.core.getLease(session.sessionId),undefined);
    assert.equal(f.core.acquire(other,session.sessionId).clientId,other.clientId);
  }finally{f.store.close();}
});
test('repeated identical snapshots journal one compact session.state and never the transcript',()=>{
  const f=setup();try{
    const big={...session,messages:[{role:'user',content:'secret transcript text '.repeat(200)}]};
    f.core.register(big,async()=>({status:'dispatched_unconfirmed'}),f.owner);
    const before=f.store.cursor();
    for(let i=0;i<20;i++)f.core.register(big,async()=>({status:'dispatched_unconfirmed'}),f.owner);
    assert.equal(f.store.cursor(),before,'unchanged snapshots must not grow the event log');
    f.core.adapterEvent(session.sessionId,{type:'message_update',payload:{message:{role:'assistant',content:'x'.repeat(5000)}}},f.owner);
    assert.equal(f.store.cursor(),before,'streaming deltas are not journaled');
    f.core.adapterEvent(session.sessionId,{type:'message_end',payload:{type:'message_end',message:{role:'assistant',content:'y'.repeat(5000)}}},f.owner);
    const events=f.store.replay(0).events;
    const end=events.find(e=>e.type==='message_end')!;
    assert.deepEqual(end.payload,{type:'message_end',role:'assistant'});
    for(const e of events)assert.ok(!JSON.stringify(e.payload).includes('secret transcript'),`${e.type} leaked transcript content`);
    const state=events.filter(e=>e.type==='session.state').at(-1)!;
    assert.equal((state.payload as any).messageCount,1);
  }finally{f.store.close();}
});
test('a new session in the same Pi runtime (/new, /resume, /fork) keeps paired devices and retires the old session',()=>{
  const f=setup();try{
    const viewer:Device={clientId:'viewer',name:'Tablet',grants:[{sessionId:session.sessionId,control:false}],owner:false,revoked:false,createdAt:10_000,expiresAt:10_000+3600_000};
    const revoked:Device={clientId:'gone',name:'Old',grants:[{sessionId:session.sessionId,control:true}],owner:false,revoked:true,createdAt:10_000,expiresAt:10_000+3600_000};
    f.store.saveDevice(viewer,hash('viewer'));f.store.saveDevice(revoked,hash('gone'));
    f.core.disconnect(f.owner); // session_shutdown(reason new) closes the old socket first
    const owner2={};
    const next=f.core.register({...session,sessionId:'session-2',bindingEpoch:2,branchId:'branch-2'},async()=>({status:'dispatched_unconfirmed'}),owner2);
    assert.equal(next.followedDevices,2);
    const devices=new Map(f.store.devices().map(d=>[d.clientId,d]));
    assert.deepEqual(devices.get('dev-1')!.grants,[{sessionId:'session-2',control:true}]);
    assert.deepEqual(devices.get('viewer')!.grants,[{sessionId:'session-2',control:false}],'access level is preserved, never raised');
    assert.deepEqual(devices.get('gone')!.grants,[{sessionId:session.sessionId,control:true}],'revoked devices gain nothing');
    assert.deepEqual(f.core.list(devices.get('viewer')!).map(s=>s.sessionId),['session-2'],'non-owner devices follow by grant');
    const old=f.core.sessions.get(session.sessionId)!.session;
    assert.equal(old.connection,'offline');assert.equal(old.workState,'ended','the replaced session stays readable but is ended');
    // A different Pi process (other runtime) never inherits per-session grants.
    const other=f.core.register({...session,sessionId:'session-3',runtimeId:'runtime-2'},async()=>({status:'dispatched_unconfirmed'}),{});
    assert.equal(other.followedDevices,undefined);
    assert.equal(f.core.list(devices.get('viewer')!).some(s=>s.sessionId==='session-3'),false);
  }finally{f.store.close();}
});
test('slash text is accepted only as an explicit command, and its output is returned but never journaled',async()=>{
  const f=setup();try{
    let seen:Command|undefined;
    f.core.register({...session,capabilities:[...session.capabilities,'command']},async c=>{seen=c;return {status:'completed',output:{title:'Pilih model',choices:[{label:'a/b',value:'/model a/b'}]}};},f.owner);
    await assert.rejects(f.core.command(f.device,f.command({payload:{text:'/model'}})),/slash_commands_disabled/);
    await assert.rejects(f.core.command(f.device,f.command({kind:'command',payload:{text:'model tanpa garis miring'}})),/invalid_command/);
    const result=await f.core.command(f.device,f.command({kind:'command',payload:{text:'/model'}})) as any;
    assert.equal(result.status,'completed');assert.equal(seen?.kind,'command');
    assert.deepEqual(result.output.choices,[{label:'a/b',value:'/model a/b'}]);
    assert.equal(f.store.command(result.commandId)!.status,'completed');
    assert.equal(JSON.stringify(f.store.command(result.commandId)).includes('choices'),false,'picker output is not persisted');
  }finally{f.store.close();}
});
test('a phone paired once (owner) sees and controls sessions from any Pi process; ended sessions stay readable for a while',async()=>{
  let now=10_000;const store=new Store(':memory:');const core=new RemoteCore(store,{wall:()=>now,mono:()=>now});
  try{
    const ownerSocket={};core.register(session,async()=>({status:'dispatched_unconfirmed'}),ownerSocket);
    const phone=core.claim(core.makePairing([session.sessionId],true,true).token,'iPhone');
    const viewerLink=core.claim(core.makePairing([session.sessionId],false,false).token,'Tablet');
    const device=core.authenticate(phone.secret),tablet=core.authenticate(viewerLink.secret);
    // Pi is quit and started again: new process, new session id, no grant was ever issued for it.
    core.disconnect(ownerSocket);now+=1000;
    const calls:Command[]=[];
    core.register({...session,sessionId:'session-new',runtimeId:'runtime-new'},async c=>{calls.push(c);return {status:'dispatched_unconfirmed'};},{});
    const listed=core.summaries(device) as any[];
    assert.deepEqual(listed.map(s=>[s.sessionId,s.connection]),[[session.sessionId,'offline'],['session-new','online']]);
    assert.equal(typeof listed[0].offlineAt,'number');
    assert.ok((core.snapshot(device,session.sessionId) as any).session,'the ended transcript is still readable');
    const lease=core.acquire(device,'session-new');
    const result=await core.command(device,{commandId:randomUUID(),sessionId:'session-new',runtimeId:'runtime-new',bindingEpoch:1,branchId:'branch-1',leaseEpoch:lease.leaseEpoch,kind:'prompt',payload:{text:'lanjut'},expiresAt:now+20_000});
    assert.equal(result.status,'dispatched_unconfirmed');assert.equal(calls.length,1);
    assert.deepEqual((core.summaries(tablet) as any[]).map(s=>s.sessionId),[session.sessionId],'non-owner links stay scoped to their session');
    assert.throws(()=>core.snapshot(tablet,'session-new'),/forbidden/);
    now+=13*3_600_000;core.register({...session,sessionId:'session-new',runtimeId:'runtime-new'},async()=>({status:'dispatched_unconfirmed'}),core.sessions.get('session-new')!.owner);
    assert.deepEqual((core.summaries(device) as any[]).map(s=>s.sessionId),['session-new'],'ended sessions are forgotten after 12 hours');
  }finally{store.close();}
});
