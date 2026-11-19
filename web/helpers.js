export const COMMAND_LABELS = {
  received: 'Received by bridge', dispatching: 'Forwarding',
  dispatched_unconfirmed: 'Forwarded · unconfirmed',
  pi_acknowledged: 'Received by Pi', accepted: 'Received by Pi', observed: 'Seen in Pi',
  completed: 'Completed', rejected: 'Rejected before dispatch',
  stale_context: 'Context changed', failed: 'Failed',
  indeterminate: 'Not confirmed yet', cancelled: 'Cancelled',
};

export const WORK_LABELS = {
  idle: 'Ready for instructions', running: 'Pi is working',
  waiting_local_input: 'Waiting for an answer in the terminal', waiting_remote_approval: 'Waiting for a decision',
  stopping: 'Stop requested', ended: 'Session process ended',
};

export function contextKey(session) {
  return session ? JSON.stringify([session.sessionId, session.runtimeId, session.bindingEpoch, session.branchId]) : '';
}

export function draftKey(origin, sessionId) {
  return `pi-remote:draft:${encodeURIComponent(origin)}:${encodeURIComponent(sessionId)}`;
}

// getRandomValues is available on HTTP LAN origins where randomUUID requires HTTPS.
export function createCommandId(cryptoApi = globalThis.crypto) {
  if (typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export function isConfirmed(status) {
  return ['pi_acknowledged', 'accepted', 'observed', 'completed'].includes(status);
}

export function messageParts(message) {
  const content = message?.content ?? message?.text ?? '';
  const parts = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : [];
  return parts.flatMap(part => {
    if (typeof part === 'string') return [{ type: 'text', text: part }];
    if (!part || typeof part !== 'object') return [];
    if (part.type === 'text') return [{ type: 'text', text: String(part.text ?? '') }];
    if (part.type === 'thinking') return [{ type: 'detail', label: 'Reasoning', text: String(part.thinking ?? part.text ?? '') }];
    if (part.type === 'toolCall') return [{ type: 'detail', label: `Tool · ${part.name ?? 'tool'}`, text: JSON.stringify(part.arguments ?? {}, null, 2) }];
    if (part.type === 'image') return [{ type: 'detail', label: 'Image attachment', text: 'Attachment preview isn’t available yet.' }];
    return [];
  });
}

export function statusTone(status) {
  if (['failed', 'rejected', 'stale_context', 'ended'].includes(status)) return 'error';
  if (['indeterminate', 'dispatched_unconfirmed', 'waiting_input', 'waiting_local_input', 'stopping'].includes(status)) return 'warning';
  if (['cancelled', 'proposed', 'blocked'].includes(status)) return 'muted';
  return '';
}

export function expiresAtMs(value) {
  return typeof value === 'number' ? value : Date.parse(value ?? '') || 0;
}

export function hasCapability(session, kind) {
  const aliases = { prompt: ['prompt', 'session.prompt'], steer: ['steer'], follow_up: ['follow_up', 'followUp'], abort: ['abort', 'stop', 'session.stop'] };
  const capabilities = session?.capabilities;
  return (aliases[kind] ?? [kind]).some(key => Array.isArray(capabilities) ? capabilities.includes(key) : capabilities?.[key] === true);
}

/**
 * Minimal Markdown parser for assistant text. Produces plain data (no HTML strings), so the
 * renderer can only ever create text nodes and a fixed set of elements.
 * Blocks: code, heading, quote, list, paragraph. Inlines: code, bold, italic, link (http/https only).
 */
export function parseMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/.exec(line);
    if (fence) {
      const close = fence[1];
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(close)) body.push(lines[i++]);
      i++;
      blocks.push({ type: 'code', lang: fence[2] || '', text: body.join('\n') });
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { blocks.push({ type: 'heading', level: heading[1].length, inlines: parseInline(heading[2]) }); i++; continue; }
    if (/^\s*>/.test(line)) {
      const body = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ''));
      blocks.push({ type: 'quote', blocks: parseMarkdown(body.join('\n')) });
      continue;
    }
    const item = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
    if (item.test(line)) {
      const ordered = /\d/.test(item.exec(line)[2]);
      const items = [];
      while (i < lines.length && item.test(lines[i])) {
        const m = item.exec(lines[i]);
        const text = [m[3]];
        i++;
        while (i < lines.length && lines[i].trim() && !item.test(lines[i]) && /^\s{2,}/.test(lines[i])) text.push(lines[i++].trim());
        items.push({ indent: m[1].length, inlines: parseInline(text.join(' ')) });
      }
      blocks.push({ type: 'list', ordered, items });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { blocks.push({ type: 'rule' }); i++; continue; }
    const body = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~)/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !item.test(lines[i]) && !/^\s*>/.test(lines[i])) body.push(lines[i++]);
    blocks.push({ type: 'paragraph', inlines: parseInline(body.join('\n')) });
  }
  return blocks;
}

export function parseInline(text) {
  const out = [];
  const pattern = /(`+)([\s\S]*?[^`])\1(?!`)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*?)\*|(?<![\w])_([^_\s][^_]*?)_(?![\w])|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  for (const m of String(text ?? '').matchAll(pattern)) {
    if (m.index > last) out.push({ type: 'text', text: text.slice(last, m.index) });
    if (m[1]) out.push({ type: 'code', text: m[2].trim() || m[2] });
    else if (m[3] || m[4]) out.push({ type: 'bold', text: m[3] ?? m[4] });
    else if (m[5] || m[6]) out.push({ type: 'italic', text: m[5] ?? m[6] });
    else if (m[7]) {
      const href = safeLink(m[8]);
      out.push(href ? { type: 'link', text: m[7], href } : { type: 'text', text: m[0] });
    }
    last = m.index + m[0].length;
  }
  if (last < String(text ?? '').length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

export function safeLink(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch { return ''; }
}

const TOOL_ARG = { bash: 'command', read: 'path', write: 'path', edit: 'path', ls: 'path', find: 'pattern', grep: 'pattern' };

/** One-line description of a tool call, e.g. Bash(npm test) or Read(src/app.ts). */
export function toolSummary(name, args) {
  const tool = String(name ?? 'tool');
  const label = tool.charAt(0).toUpperCase() + tool.slice(1);
  const a = args && typeof args === 'object' ? args : {};
  let detail = TOOL_ARG[tool] ? a[TOOL_ARG[tool]] ?? a.file_path ?? a.path : undefined;
  if (tool === 'grep' && a.path) detail = `${a.pattern ?? ''} · ${a.path}`;
  if (detail === undefined) {
    const first = Object.values(a).find(v => typeof v === 'string' || typeof v === 'number');
    detail = first ?? '';
  }
  const flat = String(detail).replace(/\s+/g, ' ').trim();
  return { label, detail: flat.length > 120 ? `${flat.slice(0, 117)}…` : flat };
}

/** Plain text of a tool result's content. Images become a placeholder. */
export function resultText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(part => part?.type === 'text' ? String(part.text ?? '') : part?.type === 'image' ? '[image]' : '').filter(Boolean).join('\n');
}

/**
 * Combines streamed characters with the latest snapshot without flicker: keep the streamed text
 * while it extends the snapshot, otherwise trust the snapshot (it is authoritative).
 */
export function mergeStreamText(snapshotText, streamedText) {
  const snap = String(snapshotText ?? ''), live = String(streamedText ?? '');
  return live.length > snap.length && live.startsWith(snap) ? live : snap;
}

/**
 * Commands matching what was typed after "/": prefix matches first, then substring matches,
 * then matches in the description. Bridge built-ins keep their order among equals.
 */
export function matchCommands(commands, query) {
  const q = String(query ?? '').toLowerCase();
  const list = Array.isArray(commands) ? commands.filter(c => c && typeof c.name === 'string') : [];
  if (!q) return list;
  const rank = c => {
    const name = c.name.toLowerCase();
    if (name === q) return 0;
    if (name.startsWith(q)) return 1;
    if (name.split(/[:._-]/).some(part => part.startsWith(q))) return 2;
    if (name.includes(q)) return 3;
    if (String(c.description ?? '').toLowerCase().includes(q)) return 4;
    return 9;
  };
  return list.map((c, i) => ({ c, r: rank(c), i })).filter(x => x.r < 9).sort((a, b) => a.r - b.r || a.i - b.i).map(x => x.c);
}

/* ---------- attachments ---------- */
export const UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
export const UPLOAD_MAX_FILES = 10;
/** Must match ATTACHMENT_HEADING in src/pi/attach-bridge.ts (a test checks both). */
export const ATTACHMENT_HEADING = 'Files from phone (saved on this computer):';
/** Heading used before the English UI; existing transcripts still contain it. */
export const LEGACY_ATTACHMENT_HEADING = 'Lampiran dari HP (tersimpan di komputer ini):';

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Splits a user message sent with files into what was typed and the file list the bridge appended.
 * Lines Pi adds after it (image resize notes, "[image]" placeholders) are dropped from view.
 * Accepts the current and the legacy heading, whichever occurs last.
 */
export function splitAttachments(text) {
  const value = String(text ?? '');
  const [at, heading] = [ATTACHMENT_HEADING, LEGACY_ATTACHMENT_HEADING]
    .map(h => [value.lastIndexOf(h), h]).reduce((best, next) => next[0] > best[0] ? next : best);
  if (at < 0) return { text: value, files: [] };
  const lines = value.slice(at + heading.length).split('\n').filter(line => line.trim());
  const files = [];
  let i = 0;
  for (; i < lines.length; i++) {
    const m = /^- (\/.+) \(([^(),]+), ([\d.]+ [KM]?B)\)$/.exec(lines[i]);
    if (!m) break;
    files.push({ path: m[1], name: m[1].slice(m[1].lastIndexOf('/') + 1), type: m[2], size: m[3] });
  }
  const rest = lines.slice(i);
  if (!files.length || rest.some(line => !line.trimStart().startsWith('['))) return { text: value, files: [] };
  return { text: value.slice(0, at).trimEnd(), files };
}

/** Short label for a file without a preview, e.g. "PDF" or "CSV". */
export function fileBadge(name) {
  const dot = String(name ?? '').lastIndexOf('.');
  const ext = dot > 0 ? String(name).slice(dot + 1) : '';
  return /^[A-Za-z0-9]{1,4}$/.test(ext) ? ext.toUpperCase() : 'FILE';
}
