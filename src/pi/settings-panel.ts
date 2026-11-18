import { homedir } from 'node:os';
import { basename } from 'node:path';
import { preferredPhoneUrl } from './qr.js';

/**
 * `/remote-control settings`: one panel in the Pi terminal for everything about remote control.
 *
 *   Settings    on/off switches (this session, auto mode, and daemon-wide settings the daemon enforces)
 *   Status      daemon, addresses, devices, background sessions, data folder
 *   Devices     pair a new device, revoke one
 *   Background  attach, look at (tmux), stop, or detach this session
 *
 * Actions that need the whole terminal (QR, detach, attach) close the panel and return the
 * `/remote-control` arguments to run next.
 */

/** What the panel needs from the bridge; kept small so the panel can be tested on its own. */
export interface PanelHost {
  isEnabled(): boolean;
  autoStart(): boolean;
  setAutoStart(on: boolean): void;
  start(ctx: PanelContext): Promise<void>;
  stop(): void;
  admin(action: 'status' | 'revoke' | 'background.list' | 'background.stop' | 'settings.get' | 'settings.set', fields?: Record<string, unknown>): Promise<Record<string, any>>;
  readonly url: string;
  readonly urls: string[];
}
export interface PanelContext {
  sessionManager: { getSessionId(): string; getSessionName(): string | undefined };
  ui: { custom?<T>(factory: (tui: any, theme: unknown, keybindings: unknown, done: (result: T) => void) => PanelComponent): Promise<T> };
}
export interface PanelComponent { render(width: number): string[]; handleInput?(data: string): void; invalidate(): void }

export const TABS = ['Settings', 'Status', 'Devices', 'Background'] as const;
type Tone = 'success' | 'muted' | 'warning' | 'error' | 'accent' | 'text';
interface Row {
  key: string;
  label: string;
  value?: string;
  tone?: Tone;
  /** Shown under the list while the row is selected. */
  about?: string;
  /** Enter. Returning a string closes the panel and runs `/remote-control <string>`. */
  act?: () => Promise<string | void> | string | void;
  /** Extra keys on this row (Background: s = look, x = stop). */
  keys?: Record<string, () => Promise<string | void> | string | void>;
  info?: boolean;
}
interface Data {
  loading: boolean;
  daemon: boolean;
  error?: string;
  settings?: { tailscaleLogin: boolean; lan: boolean; uploads: boolean; activity: boolean };
  available?: { tailscaleLogin: boolean; lan: boolean };
  pid?: number;
  version?: string;
  dataDir?: string;
  status?: { urls?: string[]; bindHost?: string; port?: number; devices?: any[] };
  background?: { backend?: string; tmux?: boolean; sessions?: any[] };
}

type ThemeLike = { fg?(color: string, text: string): string; bold?(text: string): string; inverse?(text: string): string } | undefined;
type KeysLike = { matches?(data: string, id: string): boolean } | undefined;

const clean = (value: unknown) => String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
const chars = (text: string) => Array.from(text);
function cut(text: string, room: number): string {
  const c = chars(text);
  return c.length <= room ? text : room <= 1 ? c.slice(0, Math.max(0, room)).join('') : `${c.slice(0, room - 1).join('')}…`;
}
function wrap(text: string, width: number): string[] {
  const out: string[] = []; let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && chars(line).length + 1 + chars(word).length > width) { out.push(line); line = ''; }
    line = line ? `${line} ${word}` : cut(word, width);
  }
  if (line) out.push(line);
  return out;
}
function ago(at: unknown): string {
  const ms = Date.now() - Number(at);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 48 * 60 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`;
}
const home = (path: string) => path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path;

async function loadData(host: PanelHost): Promise<Data> {
  const [settings, status, background] = await Promise.allSettled([host.admin('settings.get'), host.admin('status'), host.admin('background.list')]);
  if (status.status === 'rejected') return { loading: false, daemon: false, error: status.reason instanceof Error ? status.reason.message : 'The daemon is not running.' };
  const s = settings.status === 'fulfilled' ? settings.value : undefined;
  return {
    loading: false, daemon: true,
    ...(s ? { settings: s.settings, available: s.available, pid: s.pid, version: s.version, dataDir: s.dataDir } : {}),
    status: status.value,
    ...(background.status === 'fulfilled' ? { background: background.value } : {}),
  };
}

export async function openSettingsPanel(host: PanelHost, ctx: PanelContext, startTab = 0): Promise<string | undefined> {
  if (!ctx.ui.custom) throw new Error('This Pi version cannot show the settings panel.');
  return ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
    const t = theme as ThemeLike, keys = keybindings as KeysLike;
    const paint = (tone: Tone | undefined, text: string) => { if (!tone || tone === 'text') return text; try { return t?.fg ? t.fg(tone, text) : text; } catch { return text; } };
    const bold = (text: string) => { try { return t?.bold ? t.bold(text) : text; } catch { return text; } };
    const inverse = (text: string) => { try { return t?.inverse ? t.inverse(text) : `[${text}]`; } catch { return `[${text}]`; } };
    let tab = Math.max(0, Math.min(TABS.length - 1, startTab));
    const selected = TABS.map(() => 0);
    let data: Data = { loading: true, daemon: false };
    let note: { text: string; tone: Tone } | undefined;
    let confirm = '';
    let busy = false;
    let closed = false;
    const redraw = () => { try { tui?.requestRender?.(); } catch { /* closing */ } };
    const reload = async () => { data = await loadData(host); redraw(); };
    void reload();
    const finish = (value: string | undefined) => { if (closed) return; closed = true; done(value); };

    const daemonDown = 'The daemon is not running. Start it with pi-remote-control start (from source: npm start -- start).';
    const toggle = (key: string, label: string, on: boolean, about: string, act: () => Promise<void> | void): Row =>
      ({ key, label, value: on ? '● on' : '○ off', tone: on ? 'success' : 'muted', about, act: async () => { await act(); } });
    const daemonSetting = (key: 'tailscaleLogin' | 'lan' | 'uploads' | 'activity', label: string, about: string, unavailable?: string): Row => {
      if (!data.daemon) return { key, label, value: data.loading ? '…' : 'daemon off', tone: 'muted', about: data.loading ? about : daemonDown, act: () => { if (!data.loading) note = { text: daemonDown, tone: 'warning' }; } };
      if (unavailable) return { key, label, value: 'unavailable', tone: 'muted', about: unavailable, act: () => { note = { text: unavailable, tone: 'warning' }; } };
      const on = data.settings?.[key] !== false;
      return toggle(key, label, on, about, async () => {
        const reply = await host.admin('settings.set', { key, value: !on });
        if (data.settings && reply.settings) data.settings = reply.settings;
        note = { text: `${label}: ${!on ? 'on' : 'off'}.`, tone: 'success' };
      });
    };

    const rows = (): Row[] => {
      if (TABS[tab] === 'Settings') return [
        toggle('remote', 'Remote for this session', host.isEnabled(), 'Paired devices can open and control this Pi session.', async () => {
          if (host.isEnabled()) { host.stop(); note = { text: 'Remote access for this session is off. Pi keeps working.', tone: 'success' }; }
          else { await host.start(ctx); note = { text: 'Remote access for this session is on.', tone: 'success' }; }
        }),
        toggle('auto', 'Auto remote for new Pi sessions', host.autoStart(), 'Every new Pi on this computer shows up on your phone without typing /remote-control.', () => {
          host.setAutoStart(!host.autoStart()); note = { text: `Auto remote: ${host.autoStart() ? 'on' : 'off'}.`, tone: 'success' };
        }),
        daemonSetting('tailscaleLogin', 'Sign in with Tailscale', 'Phones on your own Tailscale account open the web app without a QR.',
          data.available && !data.available.tailscaleLogin ? 'Unavailable: Tailscale was not running when the daemon started, or the daemon runs with --no-tailscale-login.' : undefined),
        daemonSetting('lan', 'Wi-Fi/LAN devices', 'Devices paired with /remote-control pair wifi can connect over your local network, encrypted. Off: only Tailscale and this computer.',
          data.available && !data.available.lan ? 'Unavailable: the daemon only listens on 127.0.0.1. Start it with --host 0.0.0.0 --allow-http.' : undefined),
        daemonSetting('uploads', 'Files from phone', 'Phones can attach files and photos to messages. Files are kept on this computer for 7 days.'),
        daemonSetting('activity', 'Remote activity in this terminal', 'Show a notice here when a phone sends a message or runs a command. Stop requests and new devices are always shown.'),
      ];
      if (TABS[tab] === 'Status') {
        const info = (label: string, value: string, tone: Tone = 'text'): Row => ({ key: label, label, value, tone, info: true });
        if (!data.daemon) return [info('Daemon', data.loading ? 'checking…' : 'not running', data.loading ? 'muted' : 'error'), ...(data.loading ? [] : [info('Start it', 'pi-remote-control start', 'muted')])];
        const urls: string[] = Array.isArray(data.status?.urls) ? data.status!.urls! : host.urls;
        const phone = preferredPhoneUrl(urls) ?? host.url;
        const devices = (data.status?.devices ?? []).filter((d: any) => !d.revoked);
        const bg = data.background?.sessions ?? [];
        const s = data.settings;
        return [
          info('Daemon', `running${data.pid ? ` · pid ${data.pid}` : ''}${data.version ? ` · v${data.version}` : ''}`, 'success'),
          info('Phone address', phone, 'accent'),
          ...(urls.filter(u => u !== phone).length ? [info('Other addresses', urls.filter(u => u !== phone).join('  '), 'muted')] : []),
          info('Listening', `${data.status?.bindHost ?? '?'}:${data.status?.port ?? '?'}`),
          info('This session', [host.isEnabled() ? 'remote on' : 'remote off', clean(ctx.sessionManager.getSessionName() ?? ''), clean(ctx.sessionManager.getSessionId()).slice(0, 8)].filter(Boolean).join(' · '), host.isEnabled() ? 'success' : 'muted'),
          info('Auto remote', host.autoStart() ? 'on' : 'off', host.autoStart() ? 'success' : 'muted'),
          info('Devices', `${devices.length} connected`),
          info('Background', `${bg.length} ${bg.length === 1 ? 'session' : 'sessions'} · ${data.background?.backend ?? '?'}`),
          info('Tailscale sign-in', data.available?.tailscaleLogin === false ? 'unavailable' : s?.tailscaleLogin === false ? 'off' : 'on', s?.tailscaleLogin === false || data.available?.tailscaleLogin === false ? 'muted' : 'success'),
          info('Wi-Fi/LAN', data.available?.lan === false ? 'unavailable (127.0.0.1 only)' : s?.lan === false ? 'off' : 'on', s?.lan === false || data.available?.lan === false ? 'muted' : 'success'),
          info('Files from phone', s?.uploads === false ? 'off' : 'on · up to 10 × 25 MB, kept 7 days', s?.uploads === false ? 'muted' : 'success'),
          info('Data folder', home(String(data.dataDir ?? '~/.pi/remote-control')), 'muted'),
        ];
      }
      if (TABS[tab] === 'Devices') {
        const list: Row[] = [
          { key: 'pair', label: '+ Pair a new device', value: 'QR', tone: 'accent', about: 'Close this panel and show a QR. Scan it with the phone camera.', act: () => 'pair' },
        ];
        const wifiOff = data.available?.lan === false ? 'Unavailable: the daemon only listens on 127.0.0.1. Start it with --host 0.0.0.0 --allow-http.'
          : data.settings?.lan === false ? 'Wi-Fi/LAN devices are turned off in the Settings tab.' : undefined;
        list.push(wifiOff
          ? { key: 'pair-wifi', label: '+ Pair over Wi-Fi', value: 'unavailable', tone: 'muted', about: wifiOff, act: () => { note = { text: wifiOff, tone: 'warning' }; } }
          : { key: 'pair-wifi', label: '+ Pair over Wi-Fi', value: 'encrypted QR', tone: 'accent', about: 'A QR for the Wi-Fi/LAN address with a per-device encryption key. For phones without Tailscale.', act: () => 'pair wifi' });
        if (!data.daemon) return [...list, { key: 'none', label: data.loading ? 'Loading…' : 'The daemon is not running.', info: true, tone: 'muted' }];
        const devices = (data.status?.devices ?? []).filter((d: any) => !d.revoked);
        if (!devices.length) list.push({ key: 'none', label: 'No devices yet.', info: true, tone: 'muted' });
        for (const d of devices) {
          const id = clean(d.clientId).slice(0, 8);
          const days = Math.max(0, Math.round((Number(d.expiresAt) - Date.now()) / 86_400_000));
          const key = `device:${d.clientId}`;
          list.push({
            key, label: clean(d.name) || 'Device', value: `${id} · ${d.owner ? 'owner' : 'viewer'} · ${clean(d.via ?? 'qr')} · ${days}d left`, tone: confirm === key ? 'error' : 'muted',
            about: confirm === key ? `Press enter again to revoke ${clean(d.name)}. It will need a new QR to come back.` : 'Enter: revoke this device.',
            act: async () => {
              if (confirm !== key) { confirm = key; return; }
              confirm = '';
              await host.admin('revoke', { clientId: d.clientId });
              note = { text: `${clean(d.name)} revoked.`, tone: 'success' };
              await reload();
            },
          });
        }
        return list;
      }
      const list: Row[] = [
        { key: 'detach', label: '+ Move this session to the background', value: 'detach', tone: 'accent', about: 'Pi keeps working after this terminal closes. Come back with /remote-control attach.', act: () => 'detach' },
      ];
      if (!data.daemon) return [...list, { key: 'none', label: data.loading ? 'Loading…' : 'The daemon is not running.', info: true, tone: 'muted' }];
      const sessions = data.background?.sessions ?? [];
      if (!sessions.length) list.push({ key: 'none', label: 'No background sessions.', info: true, tone: 'muted' });
      for (const e of sessions) {
        const name = clean(e.name), key = `bg:${name}`;
        const what = e.preview ? `"${clean(e.preview)}"` : e.messageCount === 0 ? '(empty)' : clean(e.title || basename(String(e.cwd ?? '')) || name);
        const facts = [typeof e.messageCount === 'number' ? `${e.messageCount} msg` : '', ago(e.createdAt), e.workState && e.workState !== 'idle' ? 'working' : '', clean(e.backend), name].filter(Boolean).join(' · ');
        const stop = async () => {
          if (confirm !== key) { confirm = key; return; }
          confirm = '';
          await host.admin('background.stop', { name });
          note = { text: `${name} stopped. Its conversation is saved; open it again with pi --resume.`, tone: 'success' };
          await reload();
        };
        list.push({
          key, label: what, value: facts, tone: confirm === key ? 'error' : 'muted',
          about: confirm === key ? `Press x again to stop ${name}.` : `Enter: bring it into this terminal${e.backend === 'tmux' ? ' · s: look at it (Ctrl-b d to come back)' : ''} · x: stop it`,
          act: () => `attach ${name}`,
          keys: { ...(e.backend === 'tmux' ? { s: () => `attach show ${name}` } : {}), x: stop },
        });
      }
      return list;
    };

    const selectable = (list: Row[]) => list.map((r, i) => (r.info ? -1 : i)).filter(i => i >= 0);
    const current = (list: Row[]) => {
      const options = selectable(list);
      if (!options.length) return -1;
      if (!options.includes(selected[tab]!)) selected[tab] = options[0]!;
      return selected[tab]!;
    };
    const run = async (fn: (() => Promise<string | void> | string | void) | undefined) => {
      if (!fn || busy) return;
      busy = true; note = undefined; redraw();
      try {
        const next = await fn();
        if (typeof next === 'string') { finish(next); return; }
      } catch (error) { note = { text: error instanceof Error ? error.message : 'That did not work.', tone: 'error' }; }
      finally { busy = false; redraw(); }
    };
    const is = (input: string, id: string, ...raw: string[]) => { try { if (keys?.matches?.(input, id)) return true; } catch { /* unknown id */ } return raw.includes(input); };

    return {
      render(width: number): string[] {
        const w = Math.max(20, width);
        const line = (parts: [string, Tone | 'bold' | 'tab' | undefined][]) => {
          let room = w, out = '';
          for (const [text, tone] of parts) {
            if (room <= 0) break;
            const piece = cut(text, room); room -= chars(piece).length;
            out += tone === 'bold' ? bold(paint('accent', piece)) : tone === 'tab' ? inverse(piece) : paint(tone as Tone | undefined, piece);
          }
          return out;
        };
        const out: string[] = [paint('accent', '─'.repeat(w))];
        const header: [string, Tone | 'bold' | 'tab' | undefined][] = [[' Remote Control ', 'bold'], ['  ', undefined]];
        TABS.forEach((name, i) => { header.push([` ${name} `, i === tab ? 'tab' : 'muted'], [' ', undefined]); });
        out.push(line(header), '');
        const list = rows();
        const at = current(list);
        const labelWidth = Math.min(Math.max(12, ...list.map(r => chars(r.label).length)) + 2, Math.floor(w * 0.5));
        // Long lists scroll around the selection.
        const max = 12, first = list.length <= max ? 0 : Math.max(0, Math.min(list.length - max, at - Math.floor(max / 2)));
        if (first > 0) out.push(line([['   ↑ more', 'muted']]));
        list.slice(first, first + max).forEach((r, offset) => {
          const i = first + offset, mark = i === at ? '› ' : '  ';
          const label = r.value === undefined ? r.label : cut(r.label, labelWidth - 1).padEnd(labelWidth);
          out.push(line([[` ${mark}`, i === at ? 'accent' : undefined], [label, r.info ? 'text' : i === at ? 'accent' : 'text'], [r.value ?? '', r.tone]]));
        });
        if (first + max < list.length) out.push(line([['   ↓ more', 'muted']]));
        out.push('');
        const about = at >= 0 ? list[at]?.about : undefined;
        if (about) for (const l of wrap(about, w - 3)) out.push(line([[`   ${l}`, 'muted']]));
        if (busy) out.push(line([['   Working…', 'muted']]));
        else if (note) for (const l of wrap(note.text, w - 3)) out.push(line([[`   ${l}`, note.tone]]));
        const extra = TABS[tab] === 'Background' ? ' · s look · x stop' : '';
        out.push(line([[` ←/→ tabs · ↑/↓ move · enter ${TABS[tab] === 'Settings' ? 'switch' : 'select'}${extra} · r refresh · esc close`, 'muted']]));
        out.push(paint('accent', '─'.repeat(w)));
        return out;
      },
      handleInput(input: string): void {
        if (closed) return;
        if (is(input, 'tui.select.cancel', '\x1b', '\x03') || input === 'q') {
          if (confirm) { confirm = ''; redraw(); return; }
          finish(undefined); return;
        }
        const list = rows(), at = current(list), options = selectable(list);
        if (is(input, 'tui.editor.cursorRight', '\x1b[C', '\t') || input === 'l') { tab = (tab + 1) % TABS.length; confirm = ''; note = undefined; redraw(); return; }
        if (is(input, 'tui.editor.cursorLeft', '\x1b[D', '\x1b[Z') || input === 'h') { tab = (tab + TABS.length - 1) % TABS.length; confirm = ''; note = undefined; redraw(); return; }
        if (is(input, 'tui.select.down', '\x1b[B') || input === 'j') { const k = options.indexOf(at); if (k >= 0 && k < options.length - 1) selected[tab] = options[k + 1]!; confirm = ''; redraw(); return; }
        if (is(input, 'tui.select.up', '\x1b[A') || input === 'k') { const k = options.indexOf(at); if (k > 0) selected[tab] = options[k - 1]!; confirm = ''; redraw(); return; }
        if (input === 'r') { note = undefined; void reload(); return; }
        const row = at >= 0 ? list[at] : undefined;
        if (is(input, 'tui.select.confirm', '\r', '\n') || input === ' ') { void run(row?.act); return; }
        const extra = row?.keys?.[input];
        if (extra) void run(extra);
      },
      invalidate(): void {},
    };
  });
}
