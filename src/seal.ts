import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { randomBytes } from 'node:crypto';

/**
 * "Seal": application-level encryption for the Wi-Fi/LAN path, where there is no TLS.
 *
 * Each device shares one 256-bit key with the daemon, delivered in the QR fragment (never sent over
 * the network). Every request, response and stream event is XChaCha20-Poly1305 with a random 192-bit
 * nonce. The associated data binds protocol version, direction, method, path, device, timestamp and
 * (for responses/events) the request nonce and event sequence, so ciphertext cannot be modified,
 * replayed, reflected to the other direction, or swapped between requests.
 *
 * The browser twin of this file is web/seal.js; tests check that both produce the same format.
 */
export const SEAL_VERSION = 'v1';
export const SEAL_HEADER = 'x-pi-seal';
export const SEAL_DATA_HEADER = 'x-pi-seal-data';
export const SEAL_CONTENT_TYPE = 'application/x-pi-seal';
export const SEAL_MAX_SKEW_MS = 60_000;

export function b64u(bytes: Uint8Array): string { return Buffer.from(bytes).toString('base64url'); }
export function fromB64u(value: string): Uint8Array {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('seal_encoding');
  return new Uint8Array(Buffer.from(value, 'base64url'));
}
export function newSealKey(): string { return b64u(randomBytes(32)); }

export const requestAad = (method: string, path: string, device: string, t: number) => `pi-remote/${SEAL_VERSION}|c2s|${method.toUpperCase()}|${path}|${device}|${t}`;
export const responseAad = (method: string, path: string, device: string, t: number, requestNonce: string) => `pi-remote/${SEAL_VERSION}|s2c|${method.toUpperCase()}|${path}|${device}|${t}|${requestNonce}`;
export const eventAad = (device: string, t: number, requestNonce: string, seq: number) => `pi-remote/${SEAL_VERSION}|s2c|event|${device}|${t}|${requestNonce}|${seq}`;

export function seal(keyB64: string, plaintext: string, aad: string): { nonce: string; data: string } {
  const key = fromB64u(keyB64);
  if (key.length !== 32) throw new Error('seal_key');
  const nonce = new Uint8Array(randomBytes(24));
  const data = xchacha20poly1305(key, nonce, new TextEncoder().encode(aad)).encrypt(new TextEncoder().encode(plaintext));
  return { nonce: b64u(nonce), data: b64u(data) };
}

export function open(keyB64: string, nonceB64: string, dataB64: string, aad: string): string {
  const key = fromB64u(keyB64), nonce = fromB64u(nonceB64), data = fromB64u(dataB64);
  if (key.length !== 32 || nonce.length !== 24 || data.length < 16) throw new Error('seal_invalid');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(xchacha20poly1305(key, nonce, new TextEncoder().encode(aad)).decrypt(data)); }
  catch { throw new Error('seal_invalid'); }
}

/** Parsed `X-Pi-Seal: v1.<device>.<timestamp>.<nonce>` header. */
export interface SealHeader { device: string; t: number; nonce: string }
export function parseSealHeader(value: unknown): SealHeader | undefined {
  if (typeof value !== 'string' || value.length > 300) return undefined;
  const parts = value.split('.');
  if (parts.length !== 4 || parts[0] !== SEAL_VERSION) return undefined;
  const [, device, t, nonce] = parts;
  if (!/^[A-Za-z0-9:_-]{1,80}$/.test(device!) || !/^\d{10,16}$/.test(t!) || !/^[A-Za-z0-9_-]{32}$/.test(nonce!)) return undefined;
  return { device: device!, t: Number(t), nonce: nonce! };
}

/** Remembers recent request nonces so a captured request cannot be sent again. */
export class ReplayGuard {
  private seen = new Map<string, number>();
  constructor(private readonly windowMs = 2 * SEAL_MAX_SKEW_MS + 10_000, private readonly max = 20_000) {}
  /** Returns false if the nonce was already used inside the window. */
  remember(nonce: string, now = Date.now()): boolean {
    if (this.seen.size > this.max / 2) for (const [key, at] of this.seen) if (now - at > this.windowMs) this.seen.delete(key);
    if (this.seen.has(nonce)) return false;
    if (this.seen.size >= this.max) this.seen.delete(this.seen.keys().next().value!);
    this.seen.set(nonce, now);
    return true;
  }
}

/** Network path of a request, from the TCP peer address. */
export type PeerPath = 'loopback' | 'tailscale' | 'lan';
