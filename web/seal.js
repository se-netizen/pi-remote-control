// Browser twin of src/seal.ts: XChaCha20-Poly1305 envelopes for the Wi-Fi/LAN path (no TLS there).
// crypto.subtle is unavailable on plain HTTP, so the audited @noble/ciphers code is served by the daemon.
import { xchacha20poly1305 } from './vendor/noble/chacha.js';

export const SEAL_VERSION = 'v1';
export const SEAL_CONTENT_TYPE = 'application/x-pi-seal';
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export function b64u(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
export function fromB64u(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('seal_encoding');
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - value.length % 4) % 4));
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

export const requestAad = (method, path, device, t) => `pi-remote/${SEAL_VERSION}|c2s|${method.toUpperCase()}|${path}|${device}|${t}`;
export const responseAad = (method, path, device, t, requestNonce) => `pi-remote/${SEAL_VERSION}|s2c|${method.toUpperCase()}|${path}|${device}|${t}|${requestNonce}`;
export const eventAad = (device, t, requestNonce, seq) => `pi-remote/${SEAL_VERSION}|s2c|event|${device}|${t}|${requestNonce}|${seq}`;

export function seal(keyB64, plaintext, aad, cryptoApi = globalThis.crypto) {
  const key = fromB64u(keyB64);
  if (key.length !== 32) throw new Error('seal_key');
  const nonce = cryptoApi.getRandomValues(new Uint8Array(24));
  const data = xchacha20poly1305(key, nonce, encoder.encode(aad)).encrypt(encoder.encode(plaintext));
  return { nonce: b64u(nonce), data: b64u(data) };
}

export function open(keyB64, nonceB64, dataB64, aad) {
  const key = fromB64u(keyB64), nonce = fromB64u(nonceB64), data = fromB64u(dataB64);
  if (key.length !== 32 || nonce.length !== 24 || data.length < 16) throw new Error('seal_invalid');
  try { return decoder.decode(xchacha20poly1305(key, nonce, encoder.encode(aad)).decrypt(data)); }
  catch { throw new Error('seal_invalid'); }
}

/**
 * Seals one API request. Returns the headers to send, the body (for methods with a body) and the
 * context needed to open the response.
 */
export function sealRequest(creds, method, path, payload, now = Date.now()) {
  const t = Math.round(now);
  const plaintext = payload === undefined ? '' : JSON.stringify(payload);
  const { nonce, data } = seal(creds.key, plaintext, requestAad(method, path, creds.device, t));
  const headers = { 'X-Pi-Seal': `${SEAL_VERSION}.${creds.device}.${t}.${nonce}` };
  const bodyless = ['GET', 'HEAD', 'DELETE'].includes(method.toUpperCase());
  if (bodyless) headers['X-Pi-Seal-Data'] = data; else headers['Content-Type'] = SEAL_CONTENT_TYPE;
  return { headers, body: bodyless ? undefined : data, context: { method, path, device: creds.device, t, nonce } };
}

export function openResponse(creds, context, text) {
  const dot = text.indexOf('.');
  if (dot < 0) throw new Error('seal_invalid');
  const plaintext = open(creds.key, text.slice(0, dot), text.slice(dot + 1), responseAad(context.method, context.path, context.device, context.t, context.nonce));
  return plaintext ? JSON.parse(plaintext) : {};
}

/** Query value for an encrypted EventSource URL (EventSource cannot send headers). */
export function sealStream(creds, sessionId, now = Date.now()) {
  const t = Math.round(now);
  const { nonce, data } = seal(creds.key, JSON.stringify({ session: sessionId }), requestAad('GET', '/api/stream', creds.device, t));
  return { query: `${SEAL_VERSION}.${creds.device}.${t}.${nonce}.${data}`, context: { device: creds.device, t, nonce, seq: 0 } };
}

/** Opens one stream event; events must arrive with consecutive sequence numbers. */
export function openEvent(creds, context, text) {
  const [seqText, nonce, data] = String(text).split('.');
  const seq = Number(seqText);
  if (!Number.isSafeInteger(seq) || seq !== context.seq + 1) throw new Error('seal_sequence');
  const plaintext = open(creds.key, nonce, data, eventAad(context.device, context.t, context.nonce, seq));
  context.seq = seq;
  return JSON.parse(plaintext);
}
