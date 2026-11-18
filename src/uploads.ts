import { randomBytes } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { assert, RemoteError } from './errors.js';

/**
 * Files sent from a phone to a Pi session.
 *
 * The browser uploads in chunks (each a normal, small API request, so the sealed Wi-Fi path and the
 * request timeout work unchanged), the daemon writes them to `<dataDir>/uploads/<id>/<name>` (0700/0600),
 * and a prompt refers to finished uploads by id. Pi reads the file from disk itself: the path goes in
 * the message text and images are attached inline. Files stay for a week so the transcript keeps working.
 */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = 512 * 1024;
export const UPLOAD_MAX_PER_MESSAGE = 10;
const MAX_OPEN_PER_DEVICE = 20;
const TOTAL_BYTES = 1024 * 1024 * 1024;
const INCOMPLETE_TTL_MS = 60 * 60 * 1000;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

export interface Attachment { name: string; path: string; mimeType: string; size: number }
interface Upload extends Attachment { uploadId: string; clientId: string; received: number; createdAt: number; done: boolean; busy: boolean; dir: string }

/** A file name that is safe as one path segment and readable in a prompt. */
export function safeFileName(value: unknown): string {
  let name = String(value ?? '').split(/[\\/]/).pop() ?? '';
  name = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/^[\s.]+/, '').trim();
  if (Buffer.byteLength(name) > 120) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : '';
    let stem = name.slice(0, ext ? dot : undefined);
    while (Buffer.byteLength(stem + ext) > 120) stem = stem.slice(0, -1);
    name = stem + ext;
  }
  return name || 'file';
}

/** Image types Pi can attach inline, recognized from content rather than the browser's claim. */
export function sniffImage(head: Uint8Array): string | undefined {
  const at = (i: number, ...bytes: number[]) => bytes.every((b, j) => head[i + j] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return undefined;
}

function declaredType(value: unknown): string {
  const type = String(value ?? '').toLowerCase();
  // An image type is only believed after sniffing; anything else is informational for the model.
  return /^[a-z0-9.+-]{1,40}\/[a-z0-9.+-]{1,80}$/.test(type) && !type.startsWith('image/') ? type : 'application/octet-stream';
}

export class UploadStore {
  private readonly uploads = new Map<string, Upload>();
  private lastPrune = 0;
  constructor(private readonly root: string, private readonly limits = { maxBytes: UPLOAD_MAX_BYTES, totalBytes: TOTAL_BYTES }, private readonly now = () => Date.now()) {}

  async create(clientId: string, input: { name?: unknown; size?: unknown; type?: unknown }): Promise<{ uploadId: string; name: string; chunkSize: number }> {
    const size = Number(input.size);
    assert(Number.isSafeInteger(size) && size > 0, 'upload_empty');
    assert(size <= this.limits.maxBytes, 'upload_too_large', 413);
    assert([...this.uploads.values()].filter(u => u.clientId === clientId && !u.done).length < MAX_OPEN_PER_DEVICE, 'too_many_uploads', 429);
    if (await this.usage() + size > this.limits.totalBytes) { await this.prune(true); assert(await this.usage() + size <= this.limits.totalBytes, 'upload_quota', 507); }
    const uploadId = randomBytes(12).toString('base64url'), name = safeFileName(input.name), dir = join(this.root, uploadId);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await mkdir(dir, { mode: 0o700 });
    await (await open(join(dir, '.part'), 'wx', 0o600)).close();
    this.uploads.set(uploadId, { uploadId, clientId, name, size, path: join(dir, name), mimeType: declaredType(input.type), received: 0, createdAt: this.now(), done: false, busy: false, dir });
    return { uploadId, name, chunkSize: UPLOAD_CHUNK_BYTES };
  }

  /** Appends the next chunk; chunks must arrive in order, one at a time. */
  async append(clientId: string, uploadId: unknown, offset: unknown, data: Buffer): Promise<{ received: number; done: boolean } & Partial<Attachment>> {
    const u = this.own(clientId, uploadId);
    assert(!u.done, 'upload_complete', 409);
    assert(!u.busy, 'upload_busy', 409);
    assert(offset === u.received, 'upload_offset', 409);
    assert(data.length > 0 && data.length <= UPLOAD_CHUNK_BYTES && u.received + data.length <= u.size, 'upload_chunk_invalid', 413);
    u.busy = true;
    try {
      const file = await open(join(u.dir, '.part'), 'r+');
      try { await file.write(data, 0, data.length, u.received); } finally { await file.close(); }
      u.received += data.length;
      if (u.received === u.size) {
        const file = await open(join(u.dir, '.part'), 'r');
        try { const head = Buffer.alloc(16); await file.read(head, 0, 16, 0); u.mimeType = sniffImage(head) ?? u.mimeType; } finally { await file.close(); }
        await rename(join(u.dir, '.part'), u.path);
        u.done = true;
        return { received: u.received, done: true, name: u.name, mimeType: u.mimeType, size: u.size };
      }
      return { received: u.received, done: false };
    } finally { u.busy = false; }
  }

  async cancel(clientId: string, uploadId: unknown): Promise<void> {
    const u = this.own(clientId, uploadId);
    this.uploads.delete(u.uploadId);
    await rm(u.dir, { recursive: true, force: true });
  }

  /** Finished uploads of this device, in the given order, for a prompt. */
  resolve(clientId: string, ids: string[]): Attachment[] {
    return ids.map(id => {
      const u = this.uploads.get(id);
      assert(u && u.clientId === clientId, 'upload_not_found', 404);
      assert(u.done, 'upload_incomplete', 409);
      return { name: u.name, path: u.path, mimeType: u.mimeType, size: u.size };
    });
  }

  /** Drops unfinished uploads after an hour and everything after a week (also files from earlier daemon runs). */
  async prune(force = false): Promise<void> {
    const now = this.now();
    if (!force && now - this.lastPrune < 10 * 60_000) return;
    this.lastPrune = now;
    for (const u of [...this.uploads.values()]) {
      if (u.busy) continue;
      if ((!u.done && now - u.createdAt > INCOMPLETE_TTL_MS) || now - u.createdAt > KEEP_MS) { this.uploads.delete(u.uploadId); await rm(u.dir, { recursive: true, force: true }); }
    }
    for (const entry of await readdir(this.root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || this.uploads.has(entry.name)) continue;
      const dir = join(this.root, entry.name);
      const info = await stat(dir).catch(() => undefined);
      if (info && now - info.mtimeMs > KEEP_MS) await rm(dir, { recursive: true, force: true });
    }
  }

  /** Bytes reserved on disk: declared sizes of known uploads plus files left by earlier runs. */
  private async usage(): Promise<number> {
    let total = 0;
    for (const u of this.uploads.values()) total += u.size;
    for (const entry of await readdir(this.root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || this.uploads.has(entry.name)) continue;
      for (const file of await readdir(join(this.root, entry.name)).catch(() => [])) total += (await stat(join(this.root, entry.name, file)).catch(() => undefined))?.size ?? 0;
    }
    return total;
  }

  private own(clientId: string, uploadId: unknown): Upload {
    const u = typeof uploadId === 'string' ? this.uploads.get(uploadId) : undefined;
    if (!u || u.clientId !== clientId) throw new RemoteError('upload_not_found', 404);
    return u;
  }
}
