#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { mkdir, lstat, chmod, readFile, writeFile, unlink } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { connect } from 'node:net';
import { execFile } from 'node:child_process';
import { tailscaleAuth } from './tailscale.js';
import { assert } from './errors.js';

const {values,positionals}=parseArgs({allowPositionals:true,options:{
  'data-dir':{type:'string'},port:{type:'string'},host:{type:'string'},origin:{type:'string',multiple:true},'allow-http':{type:'boolean'},
  owner:{type:'boolean'},viewer:{type:'boolean'},'no-tailscale-login':{type:'boolean'},session:{type:'string',multiple:true},help:{type:'boolean'},
}});
const action=positionals[0]??'start';
/** How to run this CLI again: the installed command, or npm start from a source checkout. */
const CMD=/\.ts$/.test(process.argv[1]??'')?'npm start --':'pi-remote-control';
const PAD=' '.repeat(CMD.length+9);
if(values.help||action==='help') {
  console.log(`Pi Remote Control: control Pi sessions from your phone or browser

Daemon
  ${CMD} start [--host 127.0.0.1] [--port 3141] [--allow-http] [--origin URL]...
${PAD}[--no-tailscale-login] [--data-dir PATH]
  ${CMD} status                      daemon, addresses, sessions, devices

Devices
  ${CMD} pair [--viewer] [--session ID]   single-use link, 5 minutes (owner unless --viewer)
  ${CMD} revoke ID_OR_PREFIX              revoke a device's access

Background sessions
  ${CMD} sessions                    list background sessions
  ${CMD} new [FOLDER]                start Pi in the background (default: this folder)
  ${CMD} stop pi-rc-XXXXXX           stop a background session

Start options
  --host 0.0.0.0 --allow-http   listen on all interfaces; every IP of this machine (LAN, Tailscale 100.x,
                                loopback) and its Tailscale MagicDNS name are allowed automatically
  --origin URL                  allow another exact origin (repeatable or comma-separated)
  --no-tailscale-login          turn off automatic sign-in for devices on the same Tailscale account
  --data-dir PATH               data location (default ~/.pi/remote-control, or PI_REMOTE_DATA_DIR)

In Pi: ${CMD==='npm start --'?'npm run pi:install':'pi install npm:@se-netizen/pi-remote-control'}, then type /remote-control. Docs: https://github.com/se-netizen/pi-remote-control#readme`);
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
      const origin=(values.origin??[]).flatMap(v=>v.split(',')).map(v=>v.trim()).filter(Boolean);
      const hostnames=['0.0.0.0','::'].includes(values.host??'')&&values['allow-http']?await tailscaleNames():[];
      const tailscale=values['no-tailscale-login']?undefined:tailscaleAuth();
      const tailscaleOwner=tailscale?await tailscale.ownerUserId():undefined;
      // node:sqlite is stable enough for this use; keep its "experimental" notice out of the daemon output.
      process.removeAllListeners('warning');
      process.on('warning',w=>{if(!(w.name==='ExperimentalWarning'&&/SQLite/i.test(w.message)))console.warn(`${w.name}: ${w.message}`);});
      const { startServer } = await import('./server.js');
      const app=await startServer({dataDir,secret,port,host:values.host,origin,hostnames,allowHttp:values['allow-http'],tailscale:tailscaleOwner?tailscale:undefined});
      console.log(`Pi Remote Control:\n${app.urls.map(u=>`  ${u}`).join('\n')}\nListen: ${app.bindHost}:${port}\nIPC: ${app.socketPath}\nTurn on /remote-control in Pi, then run ${CMD} pair.`);
      console.log(tailscaleOwner?'Tailscale sign-in: on. Devices on the same Tailscale account as this machine sign in without a QR (turn off: --no-tailscale-login).':'Tailscale sign-in: off (Tailscale is not running, or --no-tailscale-login).');
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
    socket.setEncoding('utf8');socket.on('error',()=>{clearTimeout(timer);fail(new Error(`The daemon is not running. Run ${CMD} start.`));});
    socket.on('connect',()=>socket.write(JSON.stringify(message)+'\n'));
    socket.on('data',chunk=>{buffer+=chunk;if(buffer.includes('\n')){clearTimeout(timer);socket.end();try{ok(JSON.parse(buffer.slice(0,buffer.indexOf('\n'))));}catch(error){fail(error);}}});
  });
  if(result.error)throw new Error(result.error);
  console.log(JSON.stringify(result,null,2));
}
