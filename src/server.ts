import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createNetServer, isIP, type Socket } from 'node:net';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, chmod, unlink, stat } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RemoteCore, sessionPreview } from './core.js';
import { assert, RemoteError } from './errors.js';
import { MAX_FRAME, object, type Command, type Device } from './protocol.js';
import { Store } from './store.js';
import { BackgroundManager } from './background.js';
import { OriginPolicy } from './origins.js';
import { UploadStore, UPLOAD_CHUNK_BYTES } from './uploads.js';
import { isTailscaleAddress, ownerDevice, peerAddress, type TailscaleAuth } from './tailscale.js';
import { ReplayGuard, SEAL_CONTENT_TYPE, SEAL_DATA_HEADER, SEAL_HEADER, SEAL_MAX_SKEW_MS, eventAad, open as openSeal, parseSealHeader, requestAad, responseAad, seal, type PeerPath } from './seal.js';

export interface ServerOptions {
  dataDir: string; secret: string; port?: number; origin?: string | string[]; host?: string; allowHttp?: boolean;
  /** Extra DNS names of this machine (e.g. Tailscale MagicDNS) accepted over HTTP on a wildcard listener. */
  hostnames?: string[]; interfaceAddresses?: () => string[]; hiddenAddresses?: () => string[];
  /** Sign in the owner's own Tailscale devices automatically (see src/tailscale.ts). */
  tailscale?: TailscaleAuth;
  /** Background sessions (tmux or RPC); injectable for tests. */
  background?: BackgroundManager;
  /** Test hook: the peer address of a request (defaults to the TCP socket's remote address). */
  remoteAddressOf?: (req: IncomingMessage) => string | undefined;
}

export async function startServer(options: ServerOptions) {
  const port=options.port??3141;
  const host=options.host??'127.0.0.1';
  assert(isIP(host)!==0||host==='localhost','invalid_bind_host');
  const origins=new OriginPolicy({port,host,origins:options.origin===undefined?[]:Array.isArray(options.origin)?options.origin:[options.origin],allowHttp:options.allowHttp,hostnames:options.hostnames,interfaceAddresses:options.interfaceAddresses,hiddenAddresses:options.hiddenAddresses});
  const store=new Store(resolve(options.dataDir,'bridge.sqlite'));
  const core=new RemoteCore(store);
  core.setMaxListeners(500); // one listener pair per open browser stream
  const uploads=new UploadStore(resolve(options.dataDir,'uploads'));
  /**
   * Remote settings changed from `/remote-control settings` in Pi. Stored here so every Pi and every
   * phone sees the same values; each one is enforced by the daemon, not just hidden in a UI.
   */
  type RemoteSettings={tailscaleLogin:boolean;lan:boolean;uploads:boolean;activity:boolean};
  const SETTING_KEYS=['tailscaleLogin','lan','uploads','activity'] as const;
  function remoteSettings():RemoteSettings{
    const saved=store.get<Partial<RemoteSettings>>('remote')??{};
    return {tailscaleLogin:saved.tailscaleLogin!==false,lan:saved.lan!==false,uploads:saved.uploads!==false,activity:saved.activity!==false};
  }
  const lanAvailable=()=>!['127.0.0.1','::1','localhost'].includes(host)&&options.allowHttp===true;
  core.resolveAttachments=(device,ids)=>{assert(remoteSettings().uploads,'uploads_disabled',403);return uploads.resolve(device.clientId,ids);};
  void uploads.prune(true).catch(()=>{});
  const background=options.background??new BackgroundManager({env:{PI_REMOTE_SOCKET:resolve(options.dataDir,'bridge.sock'),PI_REMOTE_SECRET_FILE:resolve(options.dataDir,'bridge.secret')}});
  void background.reconcile().catch(()=>{});
  /** Folders of recently registered sessions, offered when starting a background session. */
  function rememberFolder(cwd:unknown){
    if(typeof cwd!=='string'||!cwd.startsWith('/')||cwd.length>1024)return;
    const list=(store.get<string[]>('recentFolders')??[]).filter(f=>f!==cwd);
    store.set('recentFolders',[cwd,...list].slice(0,15));
  }
  /** Asks the Pi of a background session to quit through its own extension. */
  function askShutdown(name:string):boolean{
    for(const b of core.sessions.values()){
      const bg=(b.session as unknown as {background?:{name?:string}}).background;
      const socket=b.owner as Socket;
      if(bg?.name===name&&b.session.connection==='online'&&!socket.destroyed){socket.write(JSON.stringify({type:'shutdown'})+'\n');return true;}
    }
    return false;
  }
  async function backgroundState(){
    await background.reconcile().catch(()=>{});
    const backend=await background.backend();
    const sessions=background.list().map(e=>{
      const live=[...core.sessions.values()].find(b=>(b.session as unknown as {background?:{name?:string}}).background?.name===e.name&&b.session.connection==='online');
      const info=(live?.session as unknown as {background?:{sessionFile?:string}}|undefined)?.background;
      const messages=live?.session.messages??[];
      return {...e,sessionId:live?.session.sessionId,title:live?.session.title,workState:live?.session.workState,sessionFile:e.sessionFile??info?.sessionFile,attach:background.attachCommand(e.name),...(live?{messageCount:messages.length,preview:sessionPreview(messages)}:{})};
    });
    return {backend,tmux:await background.tmuxAvailable(),sessions,folders:store.get<string[]>('recentFolders')??[]};
  }
  let shuttingDown=false;
  if(!store.get('hostId'))store.set('hostId',randomUUID());
  const sockets=new Set<Socket>();const pending=new Map<string,{resolve:(value:any)=>void;timer:ReturnType<typeof setTimeout>;socket:Socket}>();
  const socketPath=resolve(options.dataDir,'bridge.sock');
  const ipc=createNetServer(socket=>{
    if(shuttingDown){socket.destroy();return;}
    sockets.add(socket);socket.setEncoding('utf8');let buffer='';let authenticated=false;
    const deadline=setTimeout(()=>socket.destroy(),5000);
    const send=(value:unknown)=>{if(!socket.destroyed&&socket.writableLength<MAX_FRAME*2)socket.write(JSON.stringify(value)+'\n');else socket.destroy();};
    const dispatch=(c:Command)=>new Promise<any>((resolve,reject)=>{
      if(socket.destroyed)return reject(new Error('adapter_offline'));
      const timer=setTimeout(()=>{pending.delete(c.commandId);reject(new Error('adapter_timeout'));},5000);
      pending.set(c.commandId,{resolve,timer,socket});send({type:'command',...c});
    });
    socket.on('data',chunk=>{
      if(shuttingDown){socket.destroy();return;}
      buffer+=chunk;
      if(Buffer.byteLength(buffer)>MAX_FRAME*2){socket.destroy();return;}
      while(buffer.includes('\n')) {
        const i=buffer.indexOf('\n'),line=buffer.slice(0,i);buffer=buffer.slice(i+1);
        try {
          assert(Buffer.byteLength(line)<=MAX_FRAME,'frame_too_large',413);
          const m=object(JSON.parse(line));
          if(!authenticated) {
            assert(typeof m.secret==='string'&&m.secret.length===options.secret.length&&timingSafeEqual(Buffer.from(m.secret),Buffer.from(options.secret)),'unauthenticated',401);
            authenticated=true;clearTimeout(deadline);
            if(m.type==='admin'){const reply=admin(m);if(reply instanceof Promise){reply.then(v=>{send(v);socket.end();},e=>{send({error:e instanceof RemoteError?e.code:'admin_failed'});socket.end();});}else{send(reply);socket.end();}continue;}
            assert(m.type==='register','registration_required');background.setLauncher(m.launcher);const registered=core.register(m.session,dispatch,socket);rememberFolder(registered.cwd);send({type:'registered',hostId:store.get('hostId'),url:origins.primary(),urls:origins.advertised(),followedDevices:registered.followedDevices??0,settings:remoteSettings()});continue;
          }
          if(m.type==='register'||m.type==='snapshot')core.register(m.session,dispatch,socket);
          else if(m.type==='event'){assert(typeof m.sessionId==='string','invalid_id');core.adapterEvent(m.sessionId,m.event,socket);}
          else if(m.type==='delta'){assert(typeof m.sessionId==='string','invalid_id');core.adapterDelta(m.sessionId,m.delta,socket);}
          else if(m.type==='unregister'){assert(typeof m.sessionId==='string','invalid_id');core.remove(m.sessionId,socket);}
          else if(m.type==='ping')send({type:'pong'});
          else if(m.type==='result') {
            const p=pending.get(String(m.commandId));if(p&&p.socket===socket){clearTimeout(p.timer);pending.delete(String(m.commandId));p.resolve(m);}
          } else throw new RemoteError('unknown_ipc_message');
        } catch(error) {send({type:'error',error:error instanceof RemoteError?error.code:'invalid_message'});socket.end();}
      }
    });
    socket.on('error',()=>{});
    socket.on('close',()=>{
      clearTimeout(deadline);sockets.delete(socket);try{core.disconnect(socket);}catch{/* durable storage unavailable or shutdown */}
      for(const [id,p]of pending)if(p.socket===socket){clearTimeout(p.timer);pending.delete(id);p.resolve({status:'indeterminate',error:'adapter_disconnected'});}
    });
  });
  function admin(m: Record<string,unknown>): unknown {
    if(m.action==='settings.get')return {settings:remoteSettings(),available:{tailscaleLogin:!!options.tailscale,lan:lanAvailable()},pid:process.pid,version:'0.1.0',dataDir:options.dataDir};
    if(m.action==='settings.set') {
      const key=String(m.key) as typeof SETTING_KEYS[number];
      assert(SETTING_KEYS.includes(key)&&typeof m.value==='boolean','invalid_setting');
      const next={...remoteSettings(),[key]:m.value};store.set('remote',next);
      // Every connected Pi learns the new values (e.g. whether to show remote activity notices).
      const notified=new Set<Socket>();
      for(const b of core.sessions.values()){const owner=b.owner as Socket;if(b.session.connection!=='online'||notified.has(owner)||owner.destroyed)continue;notified.add(owner);owner.write(JSON.stringify({type:'settings',settings:next})+'\n');}
      return {settings:next};
    }
    if(m.action==='pair'&&m.wifi===true) {
      assert(remoteSettings().lan,'lan_disabled',409);
      const ids=Array.isArray(m.sessionIds)?m.sessionIds.map(String):[...core.sessions.keys()];
      const pairing=core.makeWifiPairing(ids,m.owner!==false);
      // Wi-Fi/LAN addresses only: Tailscale and loopback do not need the sealed path.
      const lanOrigins=origins.advertised().filter(o=>{try{const h=new URL(o).hostname.replace(/^\[|\]$/g,'');return !isTailscaleAddress(h)&&!h.endsWith('.ts.net')&&h!=='localhost'&&!h.startsWith('127.')&&h!=='::1';}catch{return false;}});
      assert(lanOrigins.length,'no_lan_address',409);
      const urls=lanOrigins.map(o=>`${o}/#w=${pairing.requestId}.${pairing.key}`);
      return {requestId:pairing.requestId,expiresAt:pairing.expiresAt,url:urls[0],urls,wifi:true};
    }
    if(m.action==='pair') {
      const ids=Array.isArray(m.sessionIds)?m.sessionIds.map(String):[...core.sessions.keys()];
      const pairing=core.makePairing(ids,m.control!==false,m.owner===true);
      const urls=origins.advertised().map(o=>`${o}/#pair=${pairing.token}`);
      return {...pairing,url:urls[0],urls};
    }
    if(m.action==='background.list')return backgroundState();
    if(m.action==='background.new')return background.validateFolder(m.cwd).then(cwd=>background.start({cwd}));
    if(m.action==='background.stop')return background.stop(String(m.name),()=>askShutdown(String(m.name))).then(()=>({status:'stopped'}));
    if(m.action==='background.handoff')return (async()=>{
      // /remote-control detach: start the same session in the background once the terminal Pi has exited.
      const cwd=await background.validateFolder(m.cwd,true);
      const file=String(m.sessionFile??'');assert(file.startsWith('/')&&file.endsWith('.jsonl'),'invalid_session_file');
      // Pi writes the session file with the first message; an empty session simply starts fresh.
      const exists=await stat(file).then(s=>s.isFile()).catch(()=>false);
      const pid=Number(m.pid);assert(Number.isSafeInteger(pid)&&pid>1,'invalid_pid');
      const name=background.newName(),backend=await background.backend();
      // Phones keep showing this session while it moves instead of jumping to another one.
      if(typeof m.sessionId==='string')core.markMoving(m.sessionId,90_000);
      void background.start({cwd,...(exists?{sessionFile:file}:{}),afterPid:pid,name}).catch(()=>{});
      return {name,backend,attach:backend==='tmux'?`tmux attach -t ${name}`:undefined,fresh:!exists};
    })();
    if(m.action==='background.release') {
      // /remote-control attach: this session comes back in a terminal Pi right after the background one quits.
      const live=[...core.sessions.values()].find(b=>(b.session as unknown as {background?:{name?:string}}).background?.name===String(m.name)&&b.session.connection==='online');
      if(live&&m.moving!==false)core.markMoving(live.session.sessionId,60_000);
      return background.stop(String(m.name),()=>askShutdown(String(m.name)),20_000).then(()=>({status:'released'}));
    }
    if(m.action==='revoke') {
      const id=String(m.clientId??'');assert(id.length>=4,'device_id_required');
      const matches=store.devices().filter(d=>!d.revoked&&(d.clientId===id||d.clientId.startsWith(id)));
      assert(matches.length===1,matches.length?'device_ambiguous':'device_not_found',matches.length?409:404);
      core.revokeLocal(matches[0]!.clientId);return {status:'revoked',clientId:matches[0]!.clientId,name:matches[0]!.name};
    }
    if(m.action==='status')return {hostId:store.get('hostId'),url:origins.primary(),urls:origins.advertised(),bindHost:host,port,sessions:[...core.sessions.values()].map(b=>{const {messages,...rest}=b.session;return rest;}),devices:store.devices().map(({clientId,name,grants,owner,revoked,expiresAt,via})=>({clientId,name,grants,owner,revoked,expiresAt,via}))};
    throw new RemoteError('unknown_admin_action');
  }
  // Tell the terminal that owns a session which device just joined it.
  core.on('paired',(info:{name:string;sessionIds:string[]})=>{
    const notified=new Set<object>();
    for(const id of info.sessionIds){const owner=core.sessions.get(id)?.owner as Socket|undefined;if(!owner||notified.has(owner)||owner.destroyed)continue;notified.add(owner);owner.write(JSON.stringify({type:'paired',name:info.name})+'\n');}
  });

  const staticDir=resolve(dirname(fileURLToPath(import.meta.url)),'../web');
  const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
  const rates=new Map<string,{count:number;until:number}>();
  function rate(req: IncomingMessage,limit:number,key:string) {
    const now=Date.now(),id=(req.socket.remoteAddress??'?')+key;let b=rates.get(id);
    if(!b||b.until<now){b={count:0,until:now+60_000};rates.set(id,b);}
    assert(++b.count<=limit,'rate_limited',429);
    if(rates.size>1000)for(const[k,v]of rates)if(v.until<now)rates.delete(k);
  }
  type SealContext = { key: string; device: string; t: number; nonce: string; method: string; path: string; body?: unknown };
  const sealedRequests=new WeakMap<IncomingMessage,SealContext>(),sealedResponses=new WeakMap<ServerResponse,SealContext>();
  const replay=new ReplayGuard();
  function json(res:ServerResponse,status:number,data:unknown) {
    const ctx=sealedResponses.get(res);
    if(ctx) {
      // Wi-Fi path: the response is bound to the request it answers.
      const out=seal(ctx.key,JSON.stringify(data),responseAad(ctx.method,ctx.path,ctx.device,ctx.t,ctx.nonce));
      res.writeHead(status,{'Content-Type':SEAL_CONTENT_TYPE,'Cache-Control':'no-store'});res.end(`${out.nonce}.${out.data}`);return;
    }
    res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));
  }
  /** Loopback, Tailscale (WireGuard-encrypted) or anything else, which is treated as untrusted Wi-Fi/LAN. */
  function peerPath(req:IncomingMessage):PeerPath {
    const ip=peerAddress(peerOf(req));
    if(ip==='::1'||ip.startsWith('127.'))return 'loopback';
    return isTailscaleAddress(ip)?'tailscale':'lan';
  }
  /** Upload chunks are the only requests larger than a frame (512 KiB of file, base64 in JSON, maybe sealed). */
  const UPLOAD_BODY=Math.ceil(UPLOAD_CHUNK_BYTES*4/3)+4096;
  const isUploadChunk=(url:URL)=>url.pathname.startsWith('/api/uploads/');
  async function rawBody(req:IncomingMessage,limit=MAX_FRAME*2):Promise<string> {
    let size=0;const chunks:Buffer[]=[];
    for await(const chunk of req){size+=chunk.length;assert(size<=limit,'frame_too_large',413);chunks.push(chunk);}
    return Buffer.concat(chunks).toString('utf8');
  }
  /** Opens a sealed request; the result authenticates the device (no cookie on the Wi-Fi path). */
  async function openSealedRequest(req:IncomingMessage,url:URL,header:string,dataFromQuery?:string,fixedPath?:string):Promise<SealContext> {
    const h=parseSealHeader(header);assert(h,'seal_invalid',401);
    if(Math.abs(Date.now()-h.t)>SEAL_MAX_SKEW_MS)throw new RemoteError('seal_clock',401);
    const pairing=h.device.startsWith('pair:');
    assert(!pairing||(url.pathname==='/api/pair'&&req.method==='POST'),'seal_invalid',401);
    const key=pairing?core.pairingKey(h.device.slice(5)):core.deviceById(h.device)?.wifiKey;
    assert(key,'seal_invalid',401);
    const method=req.method??'GET',path=fixedPath??url.pathname+url.search;
    const bodyless=['GET','HEAD','DELETE'].includes(method);
    let data=dataFromQuery;
    if(data===undefined) {
      if(bodyless)data=String(req.headers[SEAL_DATA_HEADER]??'');
      else {assert(req.headers['content-type']?.split(';')[0]===SEAL_CONTENT_TYPE,'seal_invalid',401);data=(await rawBody(req,isUploadChunk(url)?Math.ceil(UPLOAD_BODY*4/3)+1024:MAX_FRAME*2)).trim();}
    }
    let plaintext:string;
    try{plaintext=openSeal(key,h.nonce,data,requestAad(method,path,h.device,h.t));}catch{throw new RemoteError('seal_invalid',401);}
    // Only an authentic request may consume its nonce; a captured one cannot be sent twice.
    assert(replay.remember(h.nonce),'seal_replay',401);
    return {key,device:h.device,t:h.t,nonce:h.nonce,method,path,...(plaintext?{body:JSON.parse(plaintext)}:{})};
  }
  async function body(req:IncomingMessage,limit=MAX_FRAME):Promise<any> {
    const sealed=sealedRequests.get(req);
    if(sealed){assert(!shuttingDown,'shutting_down',503);return sealed.body??{};}
    let size=0;const chunks:Buffer[]=[];
    for await(const chunk of req){size+=chunk.length;assert(size<=limit,'frame_too_large',413);chunks.push(chunk);}
    assert(req.headers['content-type']?.split(';')[0]==='application/json','json_required',415);
    assert(!shuttingDown,'shutting_down',503);
    try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new RemoteError('invalid_json');}
  }
  function cookie(req:IncomingMessage):string|undefined {return /(?:^|;\s*)pi_remote=([A-Za-z0-9_-]+)/.exec(req.headers.cookie??'')?.[1];}
  const cookieValue=(token:string,age:number,secure:boolean)=>`pi_remote=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure?'; Secure':''}`;
  const escapeHtml=(v:string)=>v.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
  const peerOf=(req:IncomingMessage)=>options.remoteAddressOf?options.remoteAddressOf(req):req.socket.remoteAddress;
  /** A readable default name from the browser, e.g. "iPhone · Safari". Only a label, never trusted. */
  function deviceName(agent: unknown): string {
    const ua=String(agent??'');
    const os=/iPhone/.test(ua)?'iPhone':/iPad/.test(ua)?'iPad':/Android/.test(ua)?'Android':/Mac OS X/.test(ua)?'Mac':/Windows/.test(ua)?'Windows':/Linux/.test(ua)?'Linux':'Device';
    const browser=/EdgA?\//.test(ua)?'Edge':/SamsungBrowser/.test(ua)?'Samsung Internet':/Firefox|FxiOS/.test(ua)?'Firefox':/Chrome|CriOS/.test(ua)?'Chrome':/Safari/.test(ua)?'Safari':'Browser';
    return `${os} · ${browser}`;
  }
  const streams=new Map<string,number>();
  /**
   * Server-sent events for one session: a full snapshot whenever it changes (coalesced), plus live
   * text deltas between snapshots. Access is re-checked on every heartbeat and on revocation.
   */
  function stream(req:IncomingMessage,res:ServerResponse,device:Device,sessionId:string,sealed?:SealContext) {
    core.snapshot(device,sessionId); // permission + existence check before opening the stream
    const open=streams.get(device.clientId)??0;assert(open<6,'too_many_streams',429);streams.set(device.clientId,open+1);
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no','Connection':'keep-alive'});
    req.socket.setNoDelay(true);
    let closed=false,timer:ReturnType<typeof setTimeout>|undefined,lastSent=0;
    let seq=0;
    const write=(event:string,data:unknown)=>{
      if(closed)return;
      if(!sealed){res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);return;}
      // Wi-Fi path: every event is sealed and numbered, so events cannot be dropped, reordered or replayed unnoticed.
      const out=seal(sealed.key,JSON.stringify(data),eventAad(sealed.device,sealed.t,sealed.nonce,++seq));
      res.write(`event: ${event}\ndata: ${seq}.${out.nonce}.${out.data}\n\n`);
    };
    const end=()=>{if(closed)return;closed=true;clearTimeout(timer);clearInterval(beat);core.off('event',onEvent);core.off('delta',onDelta);streams.set(device.clientId,Math.max(0,(streams.get(device.clientId)??1)-1));res.end();};
    const sendSnapshot=()=>{timer=undefined;lastSent=Date.now();try{write('snapshot',core.snapshot(device,sessionId));}catch(error){write('gone',{error:error instanceof RemoteError?error.code:'unavailable'});end();}};
    const schedule=()=>{if(!timer)timer=setTimeout(sendSnapshot,Math.max(0,lastSent+120-Date.now()));};
    const onEvent=(e:{type:string;sessionId?:string;payload?:any})=>{
      if(e.type==='device.revoked'&&e.payload?.clientId===device.clientId){write('gone',{error:'device_revoked'});end();return;}
      if(e.sessionId===sessionId)schedule();
    };
    const onDelta=(id:string,delta:unknown)=>{if(id===sessionId)write('delta',delta);};
    const beat=setInterval(()=>{try{core.checkDevice(device);res.write(': ping\n\n');}catch{write('gone',{error:'unauthenticated'});end();}},15_000);
    core.on('event',onEvent);core.on('delta',onDelta);
    req.on('close',end);res.on('error',end);
    sendSnapshot();
  }
  function hostRejected(req:IncomingMessage,res:ServerResponse) {
    const shown=escapeHtml(String(req.headers.host??'').slice(0,200));
    if((req.url??'/').startsWith('/api/')||(req.method!=='GET'&&req.method!=='HEAD')){json(res,403,{error:'invalid_host',message:'invalid_host'});return;}
    res.writeHead(403,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'});
    res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Address not allowed</title><body style="font-family:system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.5"><h1>Address not allowed</h1><p>The Pi Remote Control daemon received a request for <code>${shown}</code>, but that address is not in its list of allowed origins.</p><p>Restart the daemon with <code>--origin http://${shown}</code> (you can repeat this option), or use <code>--host 0.0.0.0 --allow-http</code> so every IP address of this machine, including its Tailscale IP, is allowed automatically. Run <code>/remote-control status</code> in Pi to see the active addresses.</p></body></html>`);
  }
  const http=createHttpServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      assert(!shuttingDown,'shutting_down',503);
      const origin=origins.originForHost(req.headers.host);
      if(!origin){hostRejected(req,res);return;}
      const secure=origin.startsWith('https:');
      const url=new URL(req.url??'/',origin);
      if(req.method!=='GET'&&req.method!=='HEAD') {
        assert(req.headers.origin===origin,'invalid_origin',403);
        assert(req.headers['x-pi-remote']==='1','csrf_required',403);
        // A 25 MiB file is 50 chunk requests; they get their own budget so uploads never starve messages.
        if(isUploadChunk(url))rate(req,600,'upload-chunks');else rate(req,120,'mutations');
      } else if(req.headers.origin)assert(req.headers.origin===origin,'invalid_origin',403);
      // Wi-Fi/LAN has no transport encryption: every API call there must be sealed, and cookies are ignored.
      const lan=url.pathname.startsWith('/api/')&&peerPath(req)==='lan';
      if(lan&&!remoteSettings().lan) {
        // Turned off in /remote-control settings: the page still loads and explains, nothing else answers.
        if(url.pathname==='/api/bootstrap'&&req.method==='GET'){
          const tailscaleUrl=options.tailscale?origins.advertised().find(o=>{try{return isTailscaleAddress(new URL(o).hostname)||new URL(o).hostname.endsWith('.ts.net');}catch{return false;}}):undefined;
          json(res,200,{product:'Pi Remote Control',version:'0.1.0',protocol:{major:1,minor:0},paired:false,lanDisabled:true,sealRequired:true,now:Date.now(),...(tailscaleUrl?{tailscaleUrl}:{})});return;
        }
        json(res,403,{error:'lan_disabled'});return;
      }
      let sealed:SealContext|undefined;
      if(lan) {
        try {
          const query=url.pathname==='/api/stream'?url.searchParams.get('seal'):null;
          if(query){const parts=query.split('.');assert(parts.length===5,'seal_invalid',401);sealed=await openSealedRequest(req,url,parts.slice(0,4).join('.'),parts[4],'/api/stream');}
          else if(req.headers[SEAL_HEADER])sealed=await openSealedRequest(req,url,String(req.headers[SEAL_HEADER]));
        }catch(error){
          if(error instanceof RemoteError&&error.code==='seal_clock'){json(res,401,{error:'seal_clock',now:Date.now()});return;}
          throw error;
        }
        if(sealed){sealedRequests.set(req,sealed);sealedResponses.set(res,sealed);}
        else if(!(url.pathname==='/api/bootstrap'&&req.method==='GET')){json(res,401,{error:'encryption_required',now:Date.now()});return;}
      }
      const sealedDevice=()=>{assert(sealed&&!sealed.device.startsWith('pair:'),'unauthenticated',401);const d=core.deviceById(sealed.device);assert(d,'device_revoked',401);return core.checkDevice(d);};
      if(url.pathname==='/api/bootstrap'&&lan) {
        // Unsealed: only enough for the page to know it must pair over Wi-Fi (or switch to Tailscale).
        const d=sealed?sealedDevice():undefined;
        const tailscaleUrl=!d&&options.tailscale?origins.advertised().find(o=>{try{return isTailscaleAddress(new URL(o).hostname)||new URL(o).hostname.endsWith('.ts.net');}catch{return false;}}):undefined;
        json(res,200,{product:'Pi Remote Control',version:'0.1.0',protocol:{major:1,minor:0},paired:!!d,clientId:d?.clientId,owner:d?.owner,hostId:d?store.get('hostId'):undefined,sealRequired:true,now:Date.now(),...(d?{uploads:remoteSettings().uploads}:{}),...(tailscaleUrl?{tailscaleUrl}:{})});return;
      }
      if(url.pathname==='/api/pair'&&req.method==='POST'&&lan) {
        rate(req,10,'pair');
        if(!sealed||!sealed.device.startsWith('pair:'))throw new RemoteError('invalid_pairing',403);
        const b=object(await body(req));
        const name=typeof b.name==='string'&&b.name.trim()?b.name:`${deviceName(req.headers['user-agent'])} · Wi-Fi`;
        const paired=core.claimWifi(sealed.device.slice(5),name);
        json(res,200,{paired:true,clientId:paired.clientId,name:paired.name,owner:paired.owner});return;
      }
      if(url.pathname==='/api/bootstrap') {
        let d:Device|undefined;try{d=core.authenticate(cookie(req));}catch{}
        let via:string|undefined,blocked=false;
        if(!d) {
          // Login with Tailscale: the owner's own tailnet devices need no QR.
          const identity=remoteSettings().tailscaleLogin?await ownerDevice(options.tailscale,peerOf(req)):undefined;
          if(identity) {
            rate(req,30,'tailscale-login');
            try{const login=core.tailscaleLogin(identity);res.setHeader('Set-Cookie',cookieValue(login.secret,Math.floor((login.expiresAt-Date.now())/1000),secure));d=core.authenticate(login.secret);via='tailscale';}
            catch(error){if(error instanceof RemoteError&&error.code==='device_revoked')blocked=true;else throw error;}
          }
        }
        const tailscaleUrl=!d&&options.tailscale&&!isTailscaleAddress(peerAddress(peerOf(req)))?origins.advertised().find(o=>{try{return isTailscaleAddress(new URL(o).hostname)||new URL(o).hostname.endsWith('.ts.net');}catch{return false;}}):undefined;
        json(res,200,{product:'Pi Remote Control',version:'0.1.0',protocol:{major:1,minor:0},paired:!!d,clientId:d?.clientId,owner:d?.owner,hostId:store.get('hostId'),...(d?{uploads:remoteSettings().uploads}:{}),...(via?{via}:{}),...(blocked?{tailscaleBlocked:true}:{}),...(tailscaleUrl?{tailscaleUrl}:{})});return;
      }
      if(url.pathname==='/api/pair'&&req.method==='POST'){
        rate(req,10,'pair');const b=object(await body(req));
        const name=typeof b.name==='string'&&b.name.trim()?b.name:deviceName(req.headers['user-agent']);
        const identity=await ownerDevice(options.tailscale,peerOf(req));
        const paired=core.claim(b.token,name,identity?.nodeId);
        res.setHeader('Set-Cookie',cookieValue(paired.secret,Math.floor((paired.expiresAt-Date.now())/1000),secure));
        json(res,200,{paired:true,clientId:paired.clientId,name:paired.name,owner:paired.owner});return;
      }
      if(!url.pathname.startsWith('/api/')) {
        assert(req.method==='GET'||req.method==='HEAD','method_not_allowed',405);
        const file=url.pathname==='/'?'index.html':url.pathname.slice(1);
        assert(['index.html','app.js','styles.css','manifest.webmanifest','sw.js','icon.svg','helpers.js','seal.js','vendor/noble/chacha.js','vendor/noble/_arx.js','vendor/noble/_poly1305.js','vendor/noble/utils.js'].includes(file),'not_found',404);
        const content=await readFile(resolve(staticDir,file));res.writeHead(200,{'Content-Type':mime[extname(file)]??'application/octet-stream','Cache-Control':file==='sw.js'?'no-cache':'no-cache'});res.end(req.method==='HEAD'?undefined:content);return;
      }
      const device=lan?sealedDevice():core.authenticate(cookie(req));
      if(url.pathname==='/api/logout'&&req.method==='POST'){
        // A Wi-Fi device's key is its only credential, so signing out retires the device.
        if(lan)core.revokeLocal(device.clientId);else res.setHeader('Set-Cookie',cookieValue('',0,secure));
        json(res,200,{status:'logged_out'});return;
      }
      if(url.pathname==='/api/sessions'&&req.method==='GET'){json(res,200,{sessions:core.summaries(device)});return;}
      if(url.pathname==='/api/stream'&&req.method==='GET'){
        const sessionId=sealed?String((sealed.body as {session?:unknown}|undefined)?.session??''):url.searchParams.get('session')??'';
        if(sealed)sealedResponses.delete(res); // stream events are sealed one by one instead
        stream(req,res,device,sessionId,sealed);return;
      }
      const sessionMatch=/^\/api\/sessions\/([^/]+)(?:\/(lease|commands|uploads))?$/.exec(url.pathname);
      if(sessionMatch){
        const id=decodeURIComponent(sessionMatch[1]!),action=sessionMatch[2];
        if(!action&&req.method==='GET'){json(res,200,core.snapshot(device,id));return;}
        if(action==='lease'&&req.method==='POST'){const b=object(await body(req));json(res,200,core.acquire(device,id,b.takeover===true));return;}
        if(action==='lease'&&req.method==='DELETE'){core.release(device,id);json(res,200,{status:'released'});return;}
        if(action==='commands'&&req.method==='POST'){const b=object(await body(req));assert(b.sessionId===id,'target_mismatch');json(res,200,await core.command(device,b));return;}
        if(action==='uploads'&&req.method==='POST'){
          // Only devices that may send messages to this session may upload files for it.
          core.permit(device,id,true);assert(core.sessions.has(id),'session_not_found',404);
          assert(remoteSettings().uploads,'uploads_disabled',403);
          const b=object(await body(req));json(res,200,await uploads.create(device.clientId,{name:b.name,size:b.size,type:b.type}));return;
        }
      }
      const uploadMatch=/^\/api\/uploads\/([A-Za-z0-9_-]{16})$/.exec(url.pathname);
      if(uploadMatch&&req.method==='POST'){
        core.checkDevice(device);
        const b=object(await body(req,UPLOAD_BODY));
        assert(typeof b.data==='string'&&b.data.length%4===0&&/^[A-Za-z0-9+/]*={0,2}$/.test(b.data),'upload_chunk_invalid');
        json(res,200,await uploads.append(device.clientId,uploadMatch[1],b.offset,Buffer.from(b.data,'base64')));return;
      }
      if(uploadMatch&&req.method==='DELETE'){core.checkDevice(device);await uploads.cancel(device.clientId,uploadMatch[1]);json(res,200,{status:'deleted'});return;}
      if(url.pathname==='/api/events'&&req.method==='GET'){
        const cursor=Number(url.searchParams.get('cursor')??0);assert(Number.isSafeInteger(cursor)&&cursor>=0,'invalid_cursor');json(res,200,core.replay(device,cursor));return;
      }
      if(url.pathname==='/api/background') {
        core.requireOwner(device);
        if(req.method==='GET'){json(res,200,await backgroundState());return;}
        if(req.method==='POST'){const b=object(await body(req));const cwd=await background.validateFolder(b.cwd);rememberFolder(cwd);json(res,200,await background.start({cwd}));return;}
      }
      const backgroundStop=/^\/api\/background\/(pi-rc-[a-f0-9]{6})\/stop$/.exec(url.pathname);
      if(backgroundStop&&req.method==='POST'){core.requireOwner(device);await background.stop(backgroundStop[1]!,()=>askShutdown(backgroundStop[1]!));json(res,200,{status:'stopped'});return;}
      if(url.pathname==='/api/devices'&&req.method==='GET'){core.requireOwner(device);json(res,200,{devices:store.devices().map(({wifiKey,...rest})=>rest)});return;}
      const deviceMatch=/^\/api\/devices\/([^/]+)$/.exec(url.pathname);
      if(deviceMatch&&req.method==='DELETE'){core.revoke(device,decodeURIComponent(deviceMatch[1]!));json(res,200,{status:'revoked'});return;}
      throw new RemoteError('not_found',404);
    }catch(error){if(!res.headersSent)json(res,error instanceof RemoteError?error.status:400,{error:error instanceof RemoteError?error.code:'request_failed',message:error instanceof Error?error.message:'Request failed'});else res.end();}
  });
  http.requestTimeout=15_000;http.headersTimeout=10_000;
  try {
    await new Promise<void>((ok,fail)=>{ipc.once('error',fail);ipc.listen(socketPath,()=>{ipc.removeListener('error',fail);ok();});});await chmod(socketPath,0o600);
    await new Promise<void>((ok,fail)=>{http.once('error',fail);http.listen(port,host,()=>{http.removeListener('error',fail);ok();});});
  }catch(error){for(const s of sockets)s.destroy();ipc.close();store.close();throw error;}
  const retention=setInterval(()=>{try{store.prune();}catch{/* mutations fail through durable write path */}void uploads.prune().catch(()=>{});},60_000);retention.unref();
  let closed=false;
  return {core,store,http,ipc,url:origins.primary(),urls:origins.advertised(),bindHost:host,socketPath,async close(){
    if(closed)return;closed=true;shuttingDown=true;clearInterval(retention);background.close();
    for(const s of sockets){try{core.disconnect(s);}catch{}s.destroy();}http.closeAllConnections();
    await Promise.all([new Promise<void>(ok=>http.close(()=>ok())),new Promise<void>(ok=>ipc.close(()=>ok()))]);
    await core.drain();
    store.close();try{await unlink(socketPath);}catch{}
  }};
}
