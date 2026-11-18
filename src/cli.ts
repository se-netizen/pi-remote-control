#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { mkdir, lstat, chmod, readFile, writeFile, unlink, realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { execFile } from 'node:child_process';
import { startServer } from './server.js';
import { tailscaleAuth } from './tailscale.js';
import { assert } from './errors.js';

const {values,positionals}=parseArgs({allowPositionals:true,options:{
  'data-dir':{type:'string'},port:{type:'string'},host:{type:'string'},origin:{type:'string',multiple:true},'allow-http':{type:'boolean'},workspace:{type:'string'},tools:{type:'string'},
  network:{type:'boolean'},'allow-checks':{type:'boolean'},owner:{type:'boolean'},viewer:{type:'boolean'},'no-tailscale-login':{type:'boolean'},session:{type:'string',multiple:true},help:{type:'boolean'},
}});
const action=positionals[0]??'start';
if(values.help||action==='help') {
  console.log(`Pi Remote Control: kendalikan sesi Pi dari HP/browser

Daemon
  npm start -- start [--host 127.0.0.1] [--port 3141] [--allow-http] [--origin URL]...
                     [--no-tailscale-login] [--data-dir PATH]
                     [--workspace /repo/git] [--tools read,grep,find,ls,edit,write,bash] [--network] [--allow-checks]
  npm start -- status                      daemon, alamat, sesi, perangkat

Perangkat
  npm start -- pair [--viewer] [--session ID]   tautan sekali pakai, 5 menit (owner kecuali --viewer)
  npm start -- revoke ID_ATAU_PREFIX            cabut akses perangkat

Sesi background
  npm start -- sessions                    daftar sesi background
  npm start -- new [FOLDER]                jalankan Pi di background (default: folder ini)
  npm start -- stop pi-rc-XXXXXX           hentikan sesi background

Opsi start
  --host 0.0.0.0 --allow-http   dengarkan semua antarmuka; semua IP mesin ini (LAN, Tailscale 100.x,
                                loopback) dan nama MagicDNS Tailscale otomatis diizinkan
  --origin URL                  izinkan origin persis lain (boleh diulang/dipisah koma)
  --no-tailscale-login          matikan login otomatis perangkat di akun Tailscale yang sama
  --data-dir PATH               lokasi data (default ~/.pi/remote-control, atau PI_REMOTE_DATA_DIR)
  --workspace PATH              aktifkan orchestrator workflow pada repo Git ini
  --tools LIST / --network / --allow-checks   kebijakan tool worker workflow (bukan sandbox OS)

Di Pi: pasang paket ini (npm run pi:install) lalu ketik /remote-control. Panduan: docs/PANDUAN.md`);
} else await main();

/** Best effort: the MagicDNS name of this machine, so http://NAME:PORT works on a wildcard listener. */
function tailscaleNames():Promise<string[]> {
  return new Promise(ok=>{
    execFile('tailscale',['status','--json'],{timeout:2000,maxBuffer:4*1024*1024},(error,stdout)=>{
      if(error)return ok([]);
      try{const name=String(JSON.parse(stdout)?.Self?.DNSName??'').replace(/\.$/,'');ok(/^[a-z0-9.-]+$/i.test(name)?[name.toLowerCase()]:[]);}catch{ok([]);}
    });
  });
}
async function privateDirectory(path: string):Promise<void> {
  await mkdir(path,{recursive:true,mode:0o700});const stat=await lstat(path);
  assert(stat.isDirectory()&&!stat.isSymbolicLink(),'unsafe_data_directory');
  if(process.getuid)assert(stat.uid===process.getuid(),'data_directory_not_owned');
  await chmod(path,0o700);
}
async function main() {
  process.umask(0o077);
  const dataDir=resolve(values['data-dir']??process.env.PI_REMOTE_DATA_DIR??join(homedir(),'.pi','remote-control'));
  await privateDirectory(dataDir);
  const secretFile=join(dataDir,'bridge.secret');
  let secret:string;
  try {
    const stat=await lstat(secretFile);assert(stat.isFile()&&!stat.isSymbolicLink(),'unsafe_secret_file');
    if(process.getuid)assert(stat.uid===process.getuid(),'secret_not_owned');
    await chmod(secretFile,0o600);secret=(await readFile(secretFile,'utf8')).trim();assert(secret.length>=40,'invalid_secret');
  }catch(error){
    if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;
    secret=randomBytes(32).toString('base64url');await writeFile(secretFile,secret+'\n',{flag:'wx',mode:0o600});
  }
  if(action==='start'||action==='serve') {
    const lockPath=join(dataDir,'daemon.lock');
    try {await writeFile(lockPath,String(process.pid),{flag:'wx',mode:0o600});}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;
      const st=await lstat(lockPath);assert(st.isFile()&&!st.isSymbolicLink(),'unsafe_lock_file');
      const pid=Number(await readFile(lockPath,'utf8'));assert(Number.isSafeInteger(pid)&&pid>1,'invalid_daemon_lock');
      let alive=true;try{process.kill(pid,0);}catch(e){alive=(e as NodeJS.ErrnoException).code!=='ESRCH';}
      assert(!alive,'daemon_already_running',409);await unlink(lockPath);await writeFile(lockPath,String(process.pid),{flag:'wx',mode:0o600});
    }
    try {
      const socketPath=join(dataDir,'bridge.sock');
      try{const st=await lstat(socketPath);assert(st.isSocket()&&(!process.getuid||st.uid===process.getuid()),'unsafe_socket');await unlink(socketPath);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      const dbPath=join(dataDir,'bridge.sqlite');
      try{const st=await lstat(dbPath);assert(st.isFile()&&!st.isSymbolicLink()&&(!process.getuid||st.uid===process.getuid()),'unsafe_database');}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}
      const port=Number(values.port??3141);assert(Number.isInteger(port)&&port>0&&port<=65535,'invalid_port');
      const tools=(values.tools??'read,grep,find,ls').split(',');assert(tools.every(t=>['read','grep','find','ls','edit','write','bash'].includes(t)),'invalid_tools');
      const workspace=values.workspace?await realpath(values.workspace):undefined;
      const origin=(values.origin??[]).flatMap(v=>v.split(',')).map(v=>v.trim()).filter(Boolean);
      const hostnames=['0.0.0.0','::'].includes(values.host??'')&&values['allow-http']?await tailscaleNames():[];
      const tailscale=values['no-tailscale-login']?undefined:tailscaleAuth();
      const tailscaleOwner=tailscale?await tailscale.ownerUserId():undefined;
      const app=await startServer({dataDir,secret,port,host:values.host,origin,hostnames,allowHttp:values['allow-http'],tailscale:tailscaleOwner?tailscale:undefined,workspace,tools,network:values.network,allowChecks:values['allow-checks']});
      console.log(`Pi Remote Control:\n${app.urls.map(u=>`  ${u}`).join('\n')}\nListen: ${app.bindHost}:${port}\nIPC: ${app.socketPath}\nAktifkan /remote-control di Pi, lalu jalankan npm start -- pair.`);
      console.log(tailscaleOwner?'Login Tailscale: aktif. Perangkat di akun Tailscale yang sama dengan mesin ini masuk tanpa QR (matikan: --no-tailscale-login).':'Login Tailscale: tidak aktif (Tailscale tidak berjalan atau --no-tailscale-login).');
      if(workspace)console.log(`Workspace orchestrator: ${workspace}; tools: ${tools.join(',')}; concurrency default: 2`);
      let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await app.close();await unlink(lockPath).catch(()=>{});};
      process.once('SIGINT',()=>void stop());process.once('SIGTERM',()=>void stop());
    }catch(error){await unlink(lockPath).catch(()=>{});throw error;}
    return;
  }
  const message:Record<string,unknown>={type:'admin',secret,action};
  if(action==='pair'){message.sessionIds=values.session;message.control=!values.viewer;message.owner=!values.viewer||!!values.owner;}
  if(action==='revoke'){assert(positionals[1],'device_id_required');message.clientId=positionals[1];}
  if(action==='sessions')message.action='background.list';
  if(action==='new'){message.action='background.new';message.cwd=resolve(positionals[1]??process.cwd());}
  if(action==='stop'){assert(positionals[1],'background_name_required');message.action='background.stop';message.name=positionals[1];}
  const result=await new Promise<any>((ok,fail)=>{
    const socket=connect(join(dataDir,'bridge.sock'));let buffer='';
    const timer=setTimeout(()=>{socket.destroy();fail(new Error('Daemon request timed out'));},action==='stop'?20000:8000);
    socket.setEncoding('utf8');socket.on('error',()=>{clearTimeout(timer);fail(new Error('Daemon belum berjalan. Jalankan npm start -- start.'));});
    socket.on('connect',()=>socket.write(JSON.stringify(message)+'\n'));
    socket.on('data',chunk=>{buffer+=chunk;if(buffer.includes('\n')){clearTimeout(timer);socket.end();try{ok(JSON.parse(buffer.slice(0,buffer.indexOf('\n'))));}catch(error){fail(error);}}});
  });
  if(result.error)throw new Error(result.error);
  console.log(JSON.stringify(result,null,2));
}
