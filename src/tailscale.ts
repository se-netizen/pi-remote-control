import { execFile } from 'node:child_process';
import { isIP } from 'node:net';

/**
 * "Login with Tailscale": a request that arrives from a tailnet address is attributed by tailscaled
 * itself (`tailscale whois`), based on the WireGuard peer key, so the browser cannot forge it.
 * Only devices of the same Tailscale user as this machine are trusted; shared and tagged nodes are not.
 */
export interface TailscaleIdentity { nodeId: string; nodeName: string; userId: string; login: string; tagged: boolean }
export interface TailscaleAuth {
  /** Tailscale user that owns this machine, or undefined when Tailscale is not running. */
  ownerUserId(): Promise<string | undefined>;
  whois(ip: string): Promise<TailscaleIdentity | undefined>;
}

/** Strips the IPv4-mapped prefix that dual-stack sockets report. */
export function peerAddress(remote: string | undefined): string {
  const value = String(remote ?? '');
  return value.startsWith('::ffff:') && isIP(value.slice(7)) === 4 ? value.slice(7) : value;
}

/** True for Tailscale CGNAT IPv4 (100.64.0.0/10) and the Tailscale ULA IPv6 range (fd7a:115c:a1e0::/48). */
export function isTailscaleAddress(ip: string): boolean {
  const address = peerAddress(ip);
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 100 && b! >= 64 && b! <= 127;
  }
  return isIP(address) === 6 && address.toLowerCase().startsWith('fd7a:115c:a1e0:');
}

type Run = (args: string[]) => Promise<string>;
function cli(binary: string): Run {
  return args => new Promise((resolve, reject) => {
    execFile(binary, args, { timeout: 2500, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

export function parseWhois(json: string): TailscaleIdentity | undefined {
  const data = JSON.parse(json);
  const node = data?.Node, user = data?.UserProfile;
  if (!node || typeof node.StableID !== 'string') return undefined;
  const tags = Array.isArray(node.Tags) ? node.Tags : [];
  const name = String(node.ComputedName || node.Hostinfo?.Hostname || String(node.Name ?? '').split('.')[0] || 'Device');
  return {
    nodeId: node.StableID, nodeName: name.replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 60) || 'Device',
    userId: String(node.User ?? user?.ID ?? ''), login: String(user?.LoginName ?? ''), tagged: tags.length > 0,
  };
}

export function tailscaleAuth(run: Run = cli('tailscale')): TailscaleAuth {
  let owner: { at: number; value: string | undefined } | undefined;
  const cache = new Map<string, { at: number; value: TailscaleIdentity | undefined }>();
  return {
    async ownerUserId() {
      if (owner && Date.now() - owner.at < 300_000) return owner.value;
      let value: string | undefined;
      try { const self = JSON.parse(await run(['status', '--json']))?.Self; value = self?.UserID ? String(self.UserID) : undefined; } catch { value = undefined; }
      owner = { at: Date.now(), value };
      return value;
    },
    async whois(ip: string) {
      const address = peerAddress(ip);
      if (!isTailscaleAddress(address)) return undefined;
      const hit = cache.get(address);
      if (hit && Date.now() - hit.at < (hit.value ? 120_000 : 20_000)) return hit.value;
      let value: TailscaleIdentity | undefined;
      try { value = parseWhois(await run(['whois', '--json', address])); } catch { value = undefined; }
      cache.set(address, { at: Date.now(), value });
      if (cache.size > 500) cache.delete(cache.keys().next().value!);
      return value;
    },
  };
}

/** The identity if it belongs to the machine owner's own Tailscale account, else undefined. */
export async function ownerDevice(auth: TailscaleAuth | undefined, remote: string | undefined): Promise<TailscaleIdentity | undefined> {
  if (!auth || !isTailscaleAddress(peerAddress(remote))) return undefined;
  const [identity, owner] = await Promise.all([auth.whois(peerAddress(remote)), auth.ownerUserId()]);
  return identity && owner && !identity.tagged && identity.userId === owner ? identity : undefined;
}
