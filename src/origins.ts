import { networkInterfaces } from 'node:os';
import { isIP } from 'node:net';
import { assert, RemoteError } from './errors.js';

/**
 * Decides which browser origins may talk to the daemon.
 *
 * The Host/Origin allowlist exists to stop DNS rebinding and cross-site requests.
 * IP literals that belong to this machine are not a rebinding vector, so when the
 * owner explicitly opens a wildcard listener with --allow-http, every interface
 * address (LAN, Tailscale 100.x, loopback) is accepted automatically. Names are
 * only accepted when configured with --origin or detected from Tailscale itself.
 */
export interface OriginPolicyOptions {
  port: number;
  host: string;
  origins?: string[];
  allowHttp?: boolean;
  /** Extra DNS names of this machine (e.g. the Tailscale MagicDNS name) usable over HTTP on a wildcard listener. */
  hostnames?: string[];
  /** Injectable for tests; returns the IP addresses currently assigned to this machine. */
  interfaceAddresses?: () => string[];
  /** Addresses that are accepted but not advertised (container bridges etc.). Defaults to Docker/libvirt/CNI interfaces. */
  hiddenAddresses?: () => string[];
}

const VIRTUAL_INTERFACE = /^(docker\d*|br-[0-9a-f]+|veth|virbr|cni|flannel|podman|lxc|lxd|vboxnet|vmnet)/;
export function virtualInterfaceAddresses(): string[] {
  const out: string[] = [];
  for (const [name, list] of Object.entries(networkInterfaces())) if (VIRTUAL_INTERFACE.test(name)) for (const entry of list ?? []) out.push(entry.address);
  return out;
}

const LOOPBACK_BIND = new Set(['127.0.0.1', 'localhost', '::1']);
const WILDCARD_BIND = new Set(['0.0.0.0', '::']);

export function parseOrigin(value: string, allowHttp: boolean): URL {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new RemoteError('invalid_origin'); }
  assert(url.pathname === '/' && !url.search && !url.hash && !url.username && !url.password, 'invalid_origin');
  assert(['http:', 'https:'].includes(url.protocol), 'invalid_origin');
  assert(url.protocol === 'https:' || ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || allowHttp, 'https_required');
  return url;
}

export function systemInterfaceAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family === 'IPv6' && entry.address.toLowerCase().startsWith('fe80')) continue; // link-local needs a zone id
      out.push(entry.address);
    }
  }
  return out;
}

function hostLiteral(ip: string): string { return isIP(ip) === 6 ? `[${ip}]` : ip; }
function isTailscaleIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127;
}
function isPrivateIPv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168);
}
function isLoopbackIp(ip: string): boolean { return ip === '::1' || ip.startsWith('127.'); }
function rank(ip: string): number {
  if (isTailscaleIPv4(ip) || ip.toLowerCase().startsWith('fd7a:115c:a1e0')) return 0;
  if (isPrivateIPv4(ip)) return 1;
  if (isLoopbackIp(ip)) return 4;
  return isIP(ip) === 6 ? 3 : 2;
}

export class OriginPolicy {
  readonly explicit: URL[];
  private readonly port: number;
  private readonly bindHost: string;
  private readonly allowHttp: boolean;
  private readonly hostnames: string[];
  private readonly readAddresses: () => string[];
  private readonly readHidden: () => string[];
  private cache?: { at: number; addresses: string[] };

  constructor(options: OriginPolicyOptions) {
    this.port = options.port;
    this.bindHost = options.host;
    this.allowHttp = options.allowHttp === true;
    this.explicit = [];
    for (const value of options.origins ?? []) {
      const url = parseOrigin(value, this.allowHttp);
      if (!this.explicit.some(u => u.origin === url.origin)) this.explicit.push(url);
    }
    this.hostnames = (options.hostnames ?? []).map(h => h.toLowerCase().replace(/\.$/, '')).filter(h => /^[a-z0-9.-]+$/.test(h));
    this.readAddresses = options.interfaceAddresses ?? systemInterfaceAddresses;
    this.readHidden = options.hiddenAddresses ?? (options.interfaceAddresses ? () => [] : virtualInterfaceAddresses);
  }

  private get wildcard(): boolean { return WILDCARD_BIND.has(this.bindHost); }
  private get listensOnLoopback(): boolean { return this.wildcard || LOOPBACK_BIND.has(this.bindHost); }
  /** Plain-HTTP access through a non-loopback address is only automatic after an explicit --allow-http. */
  private get interfaceHttp(): boolean { return this.allowHttp && !LOOPBACK_BIND.has(this.bindHost); }

  private addresses(): string[] {
    const now = Date.now();
    if (!this.cache || now - this.cache.at > 10_000) {
      let addresses: string[] = [];
      try { addresses = this.readAddresses(); } catch { addresses = []; }
      this.cache = { at: now, addresses };
    }
    if (this.wildcard) return this.cache.addresses.filter(ip => this.bindHost === '::' || isIP(ip) === 4);
    return isIP(this.bindHost) ? [this.bindHost] : [];
  }

  /** Returns the canonical origin for an incoming Host header, or undefined when that host is not allowed. */
  originForHost(hostHeader: string | undefined): string | undefined {
    if (!hostHeader || hostHeader.length > 300) return undefined;
    const host = hostHeader.toLowerCase();
    for (const url of this.explicit) if (url.host === host) return url.origin;
    const suffix = `:${this.port}`;
    if (!host.endsWith(suffix)) return undefined;
    const name = host.slice(0, -suffix.length);
    if (this.listensOnLoopback && ['127.0.0.1', 'localhost', '[::1]'].includes(name)) return `http://${host}`;
    if (!this.interfaceHttp) return undefined;
    const ip = name.startsWith('[') && name.endsWith(']') ? name.slice(1, -1) : name;
    if (isIP(ip) && this.addresses().some(a => a.toLowerCase() === ip)) return `http://${host}`;
    if (this.wildcard && this.hostnames.includes(name)) return `http://${host}`;
    return undefined;
  }

  /** Origins to show the owner, best first: explicit, Tailscale, LAN, other, loopback. */
  advertised(): string[] {
    const out = this.explicit.map(u => u.origin);
    const add = (origin: string) => { if (!out.includes(origin)) out.push(origin); };
    if (this.interfaceHttp) {
      let hidden: string[] = [];
      try { hidden = this.readHidden(); } catch { hidden = []; }
      const ips = this.addresses().filter(ip => !isLoopbackIp(ip) && !hidden.includes(ip)).sort((a, b) => rank(a) - rank(b));
      for (const ip of ips) {
        add(`http://${hostLiteral(ip)}:${this.port}`);
        if (rank(ip) === 0 && this.wildcard) for (const name of this.hostnames) add(`http://${name}:${this.port}`);
      }
    }
    if (this.listensOnLoopback) add(`http://127.0.0.1:${this.port}`);
    return out;
  }

  primary(): string { return this.advertised()[0] ?? `http://127.0.0.1:${this.port}`; }
}
