export const COMMAND_LABELS = {
  received: 'Diterima bridge', dispatching: 'Sedang diteruskan',
  dispatched_unconfirmed: 'Diteruskan · belum terkonfirmasi',
  pi_acknowledged: 'Diterima Pi', accepted: 'Diterima Pi', observed: 'Teramati di Pi',
  completed: 'Selesai teramati', rejected: 'Ditolak sebelum dispatch',
  stale_context: 'Konteks telah berubah', failed: 'Gagal',
  indeterminate: 'Belum dapat dipastikan', cancelled: 'Dibatalkan',
};

export const WORK_LABELS = {
  idle: 'Siap menerima instruksi', running: 'Pi sedang bekerja',
  waiting_local_input: 'Menunggu jawaban di terminal', waiting_remote_approval: 'Menunggu keputusan',
  stopping: 'Penghentian diminta', ended: 'Proses sesi berakhir',
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
    if (part.type === 'image') return [{ type: 'detail', label: 'Lampiran gambar', text: 'Pratinjau lampiran belum tersedia.' }];
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

export function workflowPlanExample() {
  return {
    plan: {
      goal: 'Perbarui dokumentasi proyek',
      maxConcurrency: 2,
      tasks: [{
        taskId: 'docs', goal: 'Perbarui README berdasarkan implementasi',
        role: 'worker', complexity: 'simple', scope: ['README.md'],
        acceptanceCriteria: ['README memuat petunjuk instalasi yang dapat dijalankan'],
        expectedArtifacts: ['README.md'], tools: ['read', 'edit', 'write'],
      }],
    },
    run: true,
  };
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
  return content.map(part => part?.type === 'text' ? String(part.text ?? '') : part?.type === 'image' ? '[gambar]' : '').filter(Boolean).join('\n');
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
