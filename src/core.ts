import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { EventEmitter } from 'node:events';
import { assert, RemoteError } from './errors.js';
import { canonical, hash, object, parseCommand, parseSession, type Command, type CommandRecord, type Device, type Session } from './protocol.js';
import { Store } from './store.js';

type AdapterResult = { status: string; error?: string; output?: unknown };
export type Dispatch = (command: Command) => Promise<AdapterResult>;
type Binding = { session: Session; dispatch: Dispatch; owner: object; offlineAt?: number };
/** Ended sessions stay readable on paired devices for a while after Pi exits. */
export const OFFLINE_SESSION_TTL_MS=12*3_600_000;
const MAX_OFFLINE_SESSIONS=20;
type Lease = { clientId: string; leaseEpoch: number; expiresAt: number; until: number };
type Pairing = { requestId: string; tokenHash: string; sessionIds: string[]; control: boolean; owner: boolean; expiresAt: number; wifiKey?: string };
export const PAIRING_TTL_MS=5*60_000;
/** Paired browsers stay signed in for 30 days; revoke from the terminal with /remote-control devices. */
export const DEVICE_TTL_MS=30*24*3_600_000;

const STREAMING_EVENTS=new Set(['message_update','tool_execution_update']);
/** Session summary for the event log: identity and state, never the transcript. */
/** The last thing the user asked in a session, so sessions in the same folder can be told apart. */
export function sessionPreview(messages: unknown[]): string|undefined {
  for(let i=messages.length-1;i>=0;i--) {
    const m=messages[i] as {role?:string;content?:unknown};
    if(m?.role!=='user')continue;
    const c=m.content;
    let text=typeof c==='string'?c:Array.isArray(c)?c.filter(p=>(p as {type?:string})?.type==='text').map(p=>String((p as {text?:unknown}).text??'')).join(' '):'';
    // Drop the file list a message with attachments carries (see attachmentText in the bridge).
    text=text.replace(/\n*(Files from phone|Lampiran dari HP) \([^)]*\):\n[\s\S]*$/,'').replace(/\s+/g,' ').trim();
    if(text)return text.length>80?text.slice(0,79)+'…':text;
  }
  return undefined;
}
function summary(s: Session): Record<string,unknown> {
  return {sessionId:s.sessionId,runtimeId:s.runtimeId,bindingEpoch:s.bindingEpoch,branchId:s.branchId,leafEntryId:s.leafEntryId,title:s.title,mode:s.mode,workState:s.workState,connection:s.connection,messageCount:s.messages.length};
}
/** Keeps lifecycle metadata of adapter events and drops message/tool bodies. */
function compactEvent(payload: unknown): Record<string,unknown> {
  if(!payload||typeof payload!=='object'||Array.isArray(payload))return {};
  const out:Record<string,unknown>={};
  for(const [k,v] of Object.entries(payload as Record<string,unknown>)) {
    if(['messages','message','partialResult','result','args','content','assistantMessageEvent'].includes(k))continue;
    if(v===null||['string','number','boolean'].includes(typeof v))out[k]=typeof v==='string'?v.slice(0,500):v;
    else if(k==='model'||k==='previousModel')out[k]=v;
  }
  const message=(payload as Record<string,any>).message;
  if(message&&typeof message==='object'&&typeof message.role==='string')out.role=message.role;
  return out;
}

export class RemoteCore extends EventEmitter {
  readonly sessions = new Map<string,Binding>();
  private leases = new Map<string,Lease>();
  private epochs = new Map<string,number>();
  private pairings = new Map<string,Pairing>();
  private tails = new Map<string,Promise<unknown>>();
  private queued = new Map<string,number>();
  private inflight = new Set<Promise<CommandRecord>>();
  private digests = new Map<string,string>();
  constructor(readonly store: Store,private clock = { wall:()=>Date.now(),mono:()=>performance.now() }) { super(); }
  /** Sessions handed between a terminal Pi and a background Pi: briefly offline, expected back soon. */
  private moving=new Map<string,{until:number;from:string}>();
  markMoving(sessionId: string,ms=60_000): void {
    const b=this.sessions.get(sessionId);if(!b)return;
    this.moving.set(sessionId,{until:this.clock.wall()+ms,from:b.session.runtimeId});
    this.event('session.state',{...summary(b.session),moving:true},sessionId);
  }
  isMoving(sessionId: string): boolean {
    const m=this.moving.get(sessionId);
    if(m===undefined)return false;
    if(m.until>this.clock.wall())return true;
    this.moving.delete(sessionId);return false;
  }
  /** Turns upload ids of a message into files on disk (set by the server; see src/uploads.ts). */
  resolveAttachments?: (device: Device, ids: string[]) => unknown[];
  event(type: string,payload: unknown,sessionId?: string): void {
    const event = this.store.append(type,payload,sessionId); this.emit('event',event);
  }
  /**
   * Registers (or refreshes) the snapshot of an attached Pi session.
   * Snapshots arrive many times per second while Pi streams; only a compact summary is
   * journaled, and only when the snapshot actually changed. Clients fetch the full
   * transcript from the in-memory snapshot, so the event log never becomes a second
   * transcript copy.
   */
  register(value: unknown,dispatch: Dispatch,owner: object): Session & { followedDevices?: number } {
    const session = parseSession(value);
    const old = this.sessions.get(session.sessionId);
    assert(!old || old.owner === owner || old.session.connection === 'offline', 'session_already_attached',409);
    if(old && old.owner === owner && old.session.runtimeId === session.runtimeId) assert(session.bindingEpoch >= old.session.bindingEpoch,'stale_binding',409);
    const changed = old && ['runtimeId','bindingEpoch','branchId'].some(k=>old.session[k as keyof Session]!==session[k as keyof Session]);
    // A session arriving from another Pi process (attach, detach, /resume) also retires what this
    // process showed before, e.g. the empty session a fresh `pi` opened before /remote-control attach.
    const followedDevices = !old || old.session.runtimeId!==session.runtimeId ? this.followRuntime(session) : 0;
    // Moving ends when the session arrives in another Pi process; the old one may still send a last snapshot.
    if(this.moving.get(session.sessionId)?.from!==session.runtimeId)this.moving.delete(session.sessionId);
    session.connection = 'online'; this.sessions.set(session.sessionId,{session,dispatch,owner}); this.sweepOffline();
    if(changed) { this.leases.delete(session.sessionId); this.event('context.changed',summary(session),session.sessionId); }
    const digest=hash(JSON.stringify(session));
    if(changed||this.digests.get(session.sessionId)!==digest||old?.session.connection!=='online') {
      this.digests.set(session.sessionId,digest); this.event('session.state',summary(session),session.sessionId);
    }
    return followedDevices ? {...session,followedDevices} : session;
  }
  /**
   * A Pi process hosts one session at a time. When the same runtime registers a new session
   * (/new, /resume, /fork while remote control stays enabled in that TUI), devices that were
   * granted the previous session of this runtime keep the same access to the new one, and the
   * previous session is retired instead of lingering as "offline".
   */
  private followRuntime(session: Session): number {
    const previous=[...this.sessions.values()].filter(b=>b.session.runtimeId===session.runtimeId&&b.session.sessionId!==session.sessionId).map(b=>b.session.sessionId);
    if(!previous.length)return 0;
    let followed=0;
    for(const d of this.store.devices()) {
      if(d.revoked||d.grants.some(g=>g.sessionId===session.sessionId))continue;
      const grant=d.grants.find(g=>previous.includes(g.sessionId));
      if(!grant)continue;
      // Grants of retired sessions are dropped so the device list does not grow with every /new.
      const grants=[...d.grants.filter(g=>!previous.includes(g.sessionId)),{sessionId:session.sessionId,control:d.grants.filter(g=>previous.includes(g.sessionId)).some(g=>g.control)}];
      this.store.saveDevice({...d,grants});followed++;
    }
    for(const id of previous) {
      const b=this.sessions.get(id)!;
      // An empty session has nothing to read: it disappears instead of cluttering the list.
      if(!b.session.messages.length){this.sessions.delete(id);this.leases.delete(id);this.digests.delete(id);this.event('session.state',{...summary(b.session),connection:'offline',workState:'ended',removed:true},id);continue;}
      // The replaced session stays readable (offline) on paired devices; clients switch to the live one.if(b.session.connection==='online'||b.offlineAt===undefined)b.offlineAt=this.clock.wall();
      b.session.connection='offline';b.session.workState='ended';
      this.leases.delete(id);this.digests.delete(id);
      this.event('session.state',summary(b.session),id);
    }
    if(followed)this.event('grant.followed',{sessionId:session.sessionId,previous,devices:followed},session.sessionId);
    return followed;
  }
  /** Forgets ended sessions after OFFLINE_SESSION_TTL_MS, keeping at most MAX_OFFLINE_SESSIONS. */
  private sweepOffline(): void {
    const now=this.clock.wall();
    const offline=[...this.sessions.entries()].filter(([,b])=>b.session.connection==='offline'&&b.offlineAt!==undefined).sort((a,b)=>b[1].offlineAt!-a[1].offlineAt!);
    offline.forEach(([id,b],i)=>{if(i>=MAX_OFFLINE_SESSIONS||now-b.offlineAt!>OFFLINE_SESSION_TTL_MS){this.sessions.delete(id);this.digests.delete(id);}});
  }
  disconnect(owner: object): void {
    for(const [id,b] of this.sessions) if(b.owner===owner) {
      b.offlineAt=this.clock.wall();
      b.session.connection='offline'; this.leases.delete(id); this.digests.delete(id); this.event('session.state',summary(b.session),id);
    }
  }
  remove(sessionId: string,owner: object): void {
    const b=this.sessions.get(sessionId); if(!b||b.owner!==owner)return;
    b.offlineAt=this.clock.wall();
    b.session.connection='offline'; b.session.workState='ended'; this.leases.delete(sessionId); this.digests.delete(sessionId);
    this.event('session.state',summary(b.session),sessionId);
  }
  adapterEvent(sessionId: string,event: unknown,owner: object): void {
    const b=this.sessions.get(sessionId); assert(b?.owner===owner,'stale_binding',409);
    const e=object(event); assert(typeof e.type==='string','invalid_event');
    // The Pi snapshot is authoritative. Deltas are never used to infer command completion.
    // Streaming deltas are not journaled: the next snapshot carries the content, and storing
    // cumulative messages per token would rewrite the transcript into SQLite many times per second.
    if(STREAMING_EVENTS.has(e.type))return;
    this.event(e.type,compactEvent(e.payload),sessionId);
  }
  /**
   * Single-use pairing link. Opening the link (or scanning its QR) pairs the device directly:
   * whoever can see the terminal is trusted, so there is no second approval step. The link
   * expires quickly, works once, and the terminal is told which device joined so it can be revoked.
   */
  /** Live text deltas go straight to subscribed browsers and are never journaled. */
  adapterDelta(sessionId: string,delta: unknown,owner: object): void {
    const b=this.sessions.get(sessionId); assert(b?.owner===owner,'stale_binding',409);
    const d=object(delta);
    assert(['text','thinking'].includes(String(d.kind))&&Number.isSafeInteger(d.index)&&typeof d.text==='string'&&d.text.length<=16_384,'invalid_delta');
    this.emit('delta',sessionId,{kind:d.kind,index:d.index,text:d.text,messageTs:typeof d.messageTs==='number'?d.messageTs:undefined});
  }
  /** Session list entries without the transcript. */
  summaries(device: Device): unknown[] {
    this.checkDevice(device);
    this.sweepOffline();
    return [...this.sessions.values()].filter(b=>this.grantFor(device,b.session.sessionId)).map(b=>{const {messages,...rest}=b.session;const preview=sessionPreview(messages);return {...structuredClone(rest),messageCount:messages.length,...(preview?{preview}:{}),...(b.offlineAt?{offlineAt:b.offlineAt}:{}),...(b.session.connection==='offline'&&this.isMoving(b.session.sessionId)?{moving:true}:{})};});
  }
  makePairing(sessionIds: string[],control: boolean,owner=false,ttlMs=PAIRING_TTL_MS): {token:string;requestId:string;expiresAt:number} {
    assert(sessionIds.every(id=>this.sessions.has(id)), 'session_not_found',404);
    assert(sessionIds.length>0||owner,'session_required');
    this.sweepPairings(); assert(this.pairings.size<100,'too_many_pairings',429);
    const token=randomBytes(32).toString('base64url'); const requestId=randomUUID(); const expiresAt=this.clock.wall()+ttlMs;
    this.pairings.set(requestId,{requestId,tokenHash:hash(token),sessionIds,control,owner,expiresAt});
    return {token,requestId,expiresAt};
  }
  claim(token: unknown,name: unknown,tailscaleNode?: string): {clientId:string;name:string;secret:string;expiresAt:number;owner:boolean} {
    assert(typeof token==='string'&&token.length<200,'invalid_pairing',403);
    assert(typeof name==='string'&&name.trim().length>0&&name.length<=80,'invalid_device_name');
    this.sweepPairings(); const digest=hash(token);
    const p=[...this.pairings.values()].find(p=>p.tokenHash===digest&&p.expiresAt>this.clock.wall());
    assert(p,'invalid_pairing',403);
    this.pairings.delete(p.requestId); // single use, even if the device write below fails
    const sessionIds=p.sessionIds.filter(id=>this.sessions.get(id)?.session.connection==='online');
    assert(sessionIds.length>0||p.owner,'session_unavailable',409);
    const secret=randomBytes(32).toString('base64url');
    const d:Device={clientId:randomUUID(),name:name.trim(),grants:sessionIds.map(sessionId=>({sessionId,control:p.control})),owner:p.owner,revoked:false,createdAt:this.clock.wall(),expiresAt:this.clock.wall()+DEVICE_TTL_MS,via:'qr',...(tailscaleNode?{tailscaleNode}:{})};
    this.store.saveDevice(d,hash(secret));
    this.event('device.approved',{clientId:d.clientId,name:d.name});
    this.emit('paired',{clientId:d.clientId,name:d.name,sessionIds});
    return {clientId:d.clientId,name:d.name,secret,expiresAt:d.expiresAt,owner:d.owner};
  }
  /**
   * Signs in a browser on one of the owner's own Tailscale devices without a QR. Each browser gets
   * its own device record (cookie). Revoking a device of that node blocks automatic sign-in for the
   * node until it is paired again with a QR, so "Revoke" keeps its meaning.
   */
  tailscaleLogin(identity: {nodeId:string;nodeName:string}): {clientId:string;name:string;secret:string;expiresAt:number} {
    assert(typeof identity.nodeId==='string'&&identity.nodeId.length>0&&identity.nodeId.length<=128,'invalid_identity');
    const latest=this.store.devices().filter(d=>d.tailscaleNode===identity.nodeId).sort((a,b)=>b.createdAt-a.createdAt)[0];
    assert(!latest?.revoked,'device_revoked',401);
    const secret=randomBytes(32).toString('base64url');
    const name=`${identity.nodeName.slice(0,60)} · Tailscale`;
    const d:Device={clientId:randomUUID(),name,grants:[],owner:true,revoked:false,createdAt:this.clock.wall(),expiresAt:this.clock.wall()+DEVICE_TTL_MS,tailscaleNode:identity.nodeId,via:'tailscale'};
    this.store.saveDevice(d,hash(secret));
    this.event('device.approved',{clientId:d.clientId,name,via:'tailscale'});
    this.emit('paired',{clientId:d.clientId,name,sessionIds:[...this.sessions.values()].filter(b=>b.session.connection==='online').map(b=>b.session.sessionId)});
    return {clientId:d.clientId,name,secret,expiresAt:d.expiresAt};
  }
  /**
   * Wi-Fi pairing: the QR carries a short request id and a fresh 256-bit key. The browser proves it
   * holds the key by sealing its claim with it, so neither key nor any token crosses the network.
   */
  makeWifiPairing(sessionIds: string[],owner=true,ttlMs=PAIRING_TTL_MS): {requestId:string;key:string;expiresAt:number} {
    assert(sessionIds.every(id=>this.sessions.has(id)),'session_not_found',404);
    this.sweepPairings(); assert(this.pairings.size<100,'too_many_pairings',429);
    const requestId=randomBytes(9).toString('base64url'),key=randomBytes(32).toString('base64url'),expiresAt=this.clock.wall()+ttlMs;
    this.pairings.set(requestId,{requestId,tokenHash:'',sessionIds,control:true,owner,expiresAt,wifiKey:key});
    return {requestId,key,expiresAt};
  }
  /** Key of a pending Wi-Fi pairing, used only to open its sealed claim. */
  pairingKey(requestId: string): string|undefined {
    this.sweepPairings();const p=this.pairings.get(requestId);
    return p?.wifiKey&&p.expiresAt>this.clock.wall()?p.wifiKey:undefined;
  }
  claimWifi(requestId: string,name: unknown): {clientId:string;name:string;owner:boolean} {
    assert(typeof name==='string'&&name.trim().length>0&&name.length<=80,'invalid_device_name');
    this.sweepPairings();const p=this.pairings.get(requestId);
    assert(p?.wifiKey&&p.expiresAt>this.clock.wall(),'invalid_pairing',403);
    this.pairings.delete(requestId);
    const sessionIds=p.sessionIds.filter(id=>this.sessions.get(id)?.session.connection==='online');
    const d:Device={clientId:randomUUID(),name:name.trim(),grants:sessionIds.map(sessionId=>({sessionId,control:p.control})),owner:p.owner,revoked:false,createdAt:this.clock.wall(),expiresAt:this.clock.wall()+DEVICE_TTL_MS,via:'wifi',wifiKey:p.wifiKey};
    // The cookie secret is never issued for Wi-Fi devices: the sealed key is their only credential.
    this.store.saveDevice(d,hash(randomBytes(32).toString('base64url')));
    this.event('device.approved',{clientId:d.clientId,name:d.name,via:'wifi'});
    this.emit('paired',{clientId:d.clientId,name:d.name,sessionIds});
    return {clientId:d.clientId,name:d.name,owner:d.owner};
  }
  /** A valid (not revoked, not expired) device by id, for sealed requests. */
  deviceById(clientId: string): Device|undefined {
    const d=this.store.devices().find(x=>x.clientId===clientId);
    return d&&!d.revoked&&d.expiresAt>this.clock.wall()?d:undefined;
  }
  private sweepPairings(): void {for(const [id,p]of this.pairings)if(p.expiresAt<=this.clock.wall())this.pairings.delete(id);}
  authenticate(secret?: string): Device {
    assert(secret&&secret.length<256,'unauthenticated',401);
    const d=this.store.deviceBySecret(hash(secret));assert(d,'unauthenticated',401);this.checkDevice(d);return d;
  }
  checkDevice(device: Device): Device {
    const d=this.store.devices().find(x=>x.clientId===device.clientId);
    assert(d&&!d.revoked,'device_revoked',401);assert(d.expiresAt>this.clock.wall(),'unauthenticated',401);return d;
  }
  /**
   * Owner devices (paired from the terminal QR) see and control every session this host exposes,
   * so a phone is paired once, not once per Pi process. Other devices keep per-session grants.
   */
  private grantFor(device: Device,sessionId: string): {sessionId:string;control:boolean}|undefined {
    if(device.owner)return {sessionId,control:true};
    return device.grants.find(g=>g.sessionId===sessionId);
  }
  permit(device: Device,sessionId: string,control=false): void {
    const d=this.checkDevice(device);const grant=this.grantFor(d,sessionId);
    assert(grant&&(!control||grant.control),'forbidden',403);
  }
  requireOwner(device: Device): void { assert(this.checkDevice(device).owner,'forbidden',403); }
  revoke(device: Device,id: string): void {
    this.requireOwner(device);this.revokeLocal(id);
  }
  revokeLocal(id: string): void {
    const d=this.store.devices().find(x=>x.clientId===id);assert(d,'device_not_found',404);
    this.store.saveDevice({...d,revoked:true});for(const [sid,l]of this.leases)if(l.clientId===id)this.leases.delete(sid);
    this.event('device.revoked',{clientId:id});
  }
  list(device: Device): Session[] {this.checkDevice(device);return [...this.sessions.values()].filter(b=>this.grantFor(device,b.session.sessionId)).map(b=>structuredClone(b.session));}
  snapshot(device: Device,id: string): unknown {
    this.permit(device,id);const b=this.sessions.get(id);assert(b,'session_not_found',404);
    const moving=b.session.connection==='offline'&&this.isMoving(id);
    return {session:{...structuredClone(b.session),...(moving?{moving:true}:{})},lease:this.getLease(id),commands:this.store.commands(id).filter(c=>c.clientId===device.clientId||device.owner).slice(-50),cursor:this.store.cursor()};
  }
  getLease(id: string): Omit<Lease,'until'> | undefined {
    const l=this.leases.get(id);if(!l||l.until<=this.clock.mono())return undefined;
    return {clientId:l.clientId,leaseEpoch:l.leaseEpoch,expiresAt:l.expiresAt};
  }
  acquire(device: Device,id: string,takeover=false): Omit<Lease,'until'> {
    this.permit(device,id,true); const b=this.sessions.get(id);assert(b?.session.connection==='online','session_offline',409);
    const old=this.getLease(id);assert(!old||old.clientId===device.clientId||takeover,'lease_held',409);
    const epoch=old?.clientId===device.clientId?old.leaseEpoch:(this.epochs.get(id)??0)+1;this.epochs.set(id,epoch);
    this.leases.set(id,{clientId:device.clientId,leaseEpoch:epoch,expiresAt:this.clock.wall()+30_000,until:this.clock.mono()+30_000});
    const lease=this.getLease(id)!;this.event('control.changed',lease,id);return lease;
  }
  release(device: Device,id: string): void {this.permit(device,id,true);assert(this.getLease(id)?.clientId===device.clientId,'lease_required',409);this.leases.delete(id);this.event('control.changed',{},id);}
  private guard(d: Device,c: Command): Binding {
    this.permit(d,c.sessionId,true);const b=this.sessions.get(c.sessionId);assert(b,'session_not_found',404);
    assert(b.session.connection==='online','session_offline',409);
    assert(b.session.runtimeId===c.runtimeId,'stale_runtime',409);assert(b.session.bindingEpoch===c.bindingEpoch,'stale_binding',409);assert(b.session.branchId===c.branchId,'stale_context',409);
    assert(c.expiresAt>this.clock.wall(),'expired',409);
    const l=this.getLease(c.sessionId);assert(l&&l.clientId===d.clientId,'lease_required',409);assert(l.leaseEpoch===c.leaseEpoch,'lease_stale',409);
    assert(b.session.capabilities.includes(c.kind),'unsupported_capability',409);
    if(c.kind==='prompt')assert(b.session.workState==='idle','session_busy',409);
    return b;
  }
  async command(device: Device,value: unknown): Promise<CommandRecord> {
    const raw=object(value);const previous=typeof raw.commandId==='string'?this.store.command(raw.commandId):undefined;
    if(previous) {
      this.permit(device,previous.sessionId,true);
      assert(previous.clientId===device.clientId&&previous.hash===hash(canonical(raw)),'command_id_conflict',409);
      return previous;
    }
    const c=parseCommand(value,this.clock.wall()); const target=this.guard(device,c);
    // Resolved before the command is journaled, so a missing or unfinished file is a plain rejection.
    // A Pi still running an older extension would drop the files, so it must advertise support.
    const ids=c.payload.attachments;
    if(ids)assert(this.resolveAttachments&&target.session.capabilities.includes('attachments'),'attachments_unsupported',409);
    const outgoing:Command=ids?{...c,payload:{...c.payload,attachments:this.resolveAttachments!(device,ids) as never}}:c;
    const count=this.queued.get(c.sessionId)??0;
    assert(c.kind==='abort'||(count<20&&[...this.queued.values()].reduce((a,b)=>a+b,0)<100),'queue_full',429);
    const record:CommandRecord={...c,clientId:device.clientId,hash:hash(canonical(c)),status:'received',recordedAt:this.clock.wall()};
    const received=this.store.acceptCommand(record);this.emit('event',received);
    this.queued.set(c.sessionId,count+1);
    let output:unknown;
    const run=async()=>{
      let started=false;
      try {
        const b=this.guard(device,c);record.status='dispatching';this.store.saveCommand(record);started=true;
        const result=await b.dispatch(outgoing);
        assert(['dispatched_unconfirmed','pi_acknowledged','completed','rejected','stale_context','indeterminate'].includes(result.status),'invalid_adapter_result');
        record.status=result.status;record.error=result.error;
        // Slash command output (messages, pickers) goes back to the caller only; it is never journaled.
        if(result.output&&typeof result.output==='object')output=result.output;
      }catch(error){record.status=started?'indeterminate':'rejected';record.error=error instanceof RemoteError?error.code:'adapter_unavailable';}
      finally {this.queued.set(c.sessionId,Math.max(0,(this.queued.get(c.sessionId)??1)-1));}
      record.recordedAt=this.clock.wall();this.store.saveCommand(record);this.event('command.status',record,c.sessionId);return output===undefined?{...record}:{...record,output} as CommandRecord;
    };
    // Stop gets a separate lane; regular dispatch serializes only adapter acceptance.
    const tail=c.kind==='abort'?run():(this.tails.get(c.sessionId)??Promise.resolve()).then(run,run);
    if(c.kind!=='abort')this.tails.set(c.sessionId,tail);
    this.inflight.add(tail);void tail.then(()=>this.inflight.delete(tail),()=>this.inflight.delete(tail));return tail;
  }
  async drain():Promise<void>{await Promise.allSettled([...this.inflight]);}
  replay(device: Device,cursor: number): unknown {
    this.checkDevice(device);const replay=this.store.replay(cursor);
    return {...replay,events:replay.events.filter(e=>e.sessionId?!!this.grantFor(device,e.sessionId):device.owner)};
  }
}
