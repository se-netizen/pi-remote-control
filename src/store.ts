import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import type { CommandRecord, Device, StreamEvent } from './protocol.js';

export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY,secretHash TEXT UNIQUE NOT NULL,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands (id TEXT PRIMARY KEY,value TEXT NOT NULL,recordedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,sessionId TEXT,payload TEXT NOT NULL,recordedAt INTEGER NOT NULL);`);
    const version = this.get<number>('schemaVersion');
    if (version !== undefined && version !== 1) throw new Error('unsupported_database_schema');
    this.set('schemaVersion', 1);
    // A crash after dispatch can never justify automatically retrying the effect.
    for (const c of this.commands()) if (['received','dispatching','dispatched_unconfirmed'].includes(c.status)) {
      this.saveCommand({ ...c, status: c.status === 'received' ? 'rejected' : 'indeterminate', error: 'bridge_restarted', recordedAt: Date.now() });
    }
  }
  get<T>(key: string): T | undefined {
    const r = this.db.prepare('SELECT value FROM meta WHERE key=?').get(key);
    return r ? JSON.parse(String(r.value)) : undefined;
  }
  set(key: string,value: unknown): void { this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key,JSON.stringify(value)); }
  saveDevice(d: Device,secretHash?: string): void {
    if (secretHash) this.db.prepare('INSERT INTO devices VALUES (?,?,?)').run(d.clientId,secretHash,JSON.stringify(d));
    else this.db.prepare('UPDATE devices SET value=? WHERE id=?').run(JSON.stringify(d),d.clientId);
  }
  deviceBySecret(secretHash: string): Device | undefined {
    const r = this.db.prepare('SELECT value FROM devices WHERE secretHash=?').get(secretHash);
    return r ? JSON.parse(String(r.value)) : undefined;
  }
  devices(): Device[] { return this.db.prepare('SELECT value FROM devices').all().map(r=>JSON.parse(String(r.value))); }
  command(id: string): CommandRecord | undefined {
    const r = this.db.prepare('SELECT value FROM commands WHERE id=?').get(id);
    return r ? JSON.parse(String(r.value)) : undefined;
  }
  commands(sessionId?: string): CommandRecord[] {
    return this.db.prepare('SELECT value FROM commands ORDER BY recordedAt').all().map(r=>JSON.parse(String(r.value))).filter(c=>!sessionId||c.sessionId===sessionId);
  }
  saveCommand(c: CommandRecord): void { this.db.prepare('INSERT OR REPLACE INTO commands VALUES (?,?,?)').run(c.commandId,JSON.stringify(c),c.recordedAt); }
  acceptCommand(c: CommandRecord): StreamEvent {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.saveCommand(c);const event=this.append('command.status',c,c.sessionId);
      this.db.exec('COMMIT');return event;
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  append(type: string,payload: unknown,sessionId?: string): StreamEvent {
    const now = Date.now();
    const r = this.db.prepare('INSERT INTO events(type,sessionId,payload,recordedAt) VALUES (?,?,?,?)').run(type,sessionId??null,JSON.stringify(payload),now);
    return {seq:Number(r.lastInsertRowid),type,payload,sessionId,recordedAt:now};
  }
  cursor(): number { return Number(this.db.prepare('SELECT seq FROM sqlite_sequence WHERE name=?').get('events')?.seq ?? 0); }
  replay(after: number): { events: StreamEvent[]; cursor: number; resyncRequired: boolean } {
    const first=Number(this.db.prepare('SELECT MIN(seq) AS seq FROM events').get()?.seq??this.cursor()+1);
    const events = this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT 500').all(after).map(r=>({seq:Number(r.seq),type:String(r.type),payload:JSON.parse(String(r.payload)),sessionId:r.sessionId?String(r.sessionId):undefined,recordedAt:Number(r.recordedAt)}));
    return {events,cursor:events.at(-1)?.seq??this.cursor(),resyncRequired:after>this.cursor()||(after>0&&after<first-1)};
  }
  prune(now = Date.now()): void {
    this.db.prepare('DELETE FROM events WHERE recordedAt<?').run(now-86_400_000);
    // Bound replay to 100 MiB even on verbose sessions.
    const bytes=Number(this.db.prepare('SELECT COALESCE(SUM(length(CAST(payload AS BLOB))),0) AS n FROM events').get()?.n??0);
    if(bytes>100*1024*1024)this.db.prepare('DELETE FROM events WHERE seq IN (SELECT seq FROM (SELECT seq,SUM(length(CAST(payload AS BLOB))) OVER (ORDER BY seq DESC) AS bytes FROM events) WHERE bytes>?)').run(100*1024*1024);
    this.db.prepare('DELETE FROM commands WHERE recordedAt<?').run(now-7*86_400_000);
    for (const c of this.commands()) if(c.recordedAt<now-86_400_000&&c.payload.text) this.saveCommand({...c,payload:{}});
  }
  close(): void { this.db.close(); }
}
