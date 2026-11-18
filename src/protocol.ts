import { createHash } from 'node:crypto';
import { assert } from './errors.js';

export const MAX_FRAME = 256 * 1024;
export const MAX_TEXT = 64 * 1024;
export const commandKinds = ['prompt', 'steer', 'follow_up', 'abort', 'command'] as const;
export type CommandKind = typeof commandKinds[number];
export interface Command {
  commandId: string; sessionId: string; runtimeId: string; bindingEpoch: number;
  branchId: string; leaseEpoch: number; kind: CommandKind; payload: { text?: string }; expiresAt: number;
}
export interface Session {
  sessionId: string; runtimeId: string; bindingEpoch: number; branchId: string;
  title: string; cwd: string; mode: 'attach' | 'managed'; workState: string;
  capabilities: string[]; messages: unknown[]; leafEntryId?: string;
  model?: { provider: string; id: string }; thinkingLevel?: string; connection?: 'online' | 'offline';
}
export interface CommandRecord extends Command {
  clientId: string; hash: string; status: string; error?: string; recordedAt: number;
}
export interface Device {
  clientId: string; name: string; grants: { sessionId: string; control: boolean }[];
  owner: boolean; revoked: boolean; expiresAt: number; createdAt: number;
  /** Tailscale node (StableID) this browser was signed in from, when known. */
  tailscaleNode?: string; via?: 'qr' | 'tailscale' | 'wifi';
  /** 256-bit key (base64url) for the encrypted Wi-Fi path; only devices paired with /remote-control pair wifi have one. */
  wifiKey?: string;
}
export interface StreamEvent { seq: number; type: string; payload: unknown; sessionId?: string; recordedAt: number }
export function object(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'invalid_object');
  return value as Record<string, unknown>;
}
export function identifier(value: unknown): string {
  assert(typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value), 'invalid_id');
  return value;
}
export function parseCommand(value: unknown, now = Date.now()): Command {
  const c = object(value);
  assert(Object.keys(c).every(k => ['commandId','sessionId','runtimeId','bindingEpoch','branchId','leaseEpoch','kind','payload','expiresAt'].includes(k)), 'unknown_field');
  for (const key of ['commandId','sessionId','runtimeId','branchId']) identifier(c[key]);
  assert(Number.isSafeInteger(c.bindingEpoch) && Number(c.bindingEpoch) >= 0, 'invalid_binding');
  assert(Number.isSafeInteger(c.leaseEpoch) && Number(c.leaseEpoch) > 0, 'invalid_lease');
  assert(commandKinds.includes(c.kind as CommandKind), 'unsupported_capability');
  const p = object(c.payload);
  assert(Object.keys(p).every(k => k === 'text'), 'unknown_field');
  if (c.kind !== 'abort') {
    assert(typeof p.text === 'string' && p.text.trim().length > 0, 'empty_prompt');
    assert(Buffer.byteLength(p.text) <= MAX_TEXT, 'prompt_too_large', 413);
    // Slash text is only accepted as an explicit `command`, never smuggled in as a prompt.
    if (c.kind === 'command') assert(/^\/[A-Za-z0-9][\w:.-]{0,63}(\s|$)/.test(p.text.trimStart()), 'invalid_command');
    else assert(!p.text.trimStart().startsWith('/'), 'slash_commands_disabled');
  } else assert(p.text === undefined, 'invalid_payload');
  assert(typeof c.expiresAt === 'number' && Number.isFinite(c.expiresAt), 'invalid_deadline');
  assert(c.expiresAt > now, 'expired', 409);
  assert(c.expiresAt <= now + 30_000, 'clock_skew', 409);
  return c as unknown as Command;
}
export function parseSession(value: unknown): Session {
  const s = object(value);
  for (const key of ['sessionId','runtimeId','branchId']) identifier(s[key]);
  assert(Number.isSafeInteger(s.bindingEpoch) && Number(s.bindingEpoch) >= 0, 'invalid_binding');
  assert(typeof s.title === 'string' && typeof s.cwd === 'string', 'invalid_session');
  assert(s.mode === 'attach' || s.mode === 'managed', 'invalid_session');
  assert(['idle','running','waiting_local_input','waiting_remote_approval','stopping','ended'].includes(String(s.workState)), 'invalid_state');
  assert(Array.isArray(s.capabilities) && s.capabilities.every(x=>typeof x === 'string'), 'invalid_capabilities');
  assert(Array.isArray(s.messages), 'invalid_messages');
  return structuredClone(s) as unknown as Session;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>JSON.stringify(k)+':'+canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export function hash(value: string): string { return createHash('sha256').update(value).digest('hex'); }
