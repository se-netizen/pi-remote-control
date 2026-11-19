import { draftKey, createCommandId, parseMarkdown, toolSummary, resultText, mergeStreamText, matchCommands, splitAttachments, formatBytes, fileBadge, UPLOAD_MAX_BYTES, UPLOAD_MAX_FILES } from './helpers.js';
import { SEAL_CONTENT_TYPE, sealRequest, openResponse, sealStream, openEvent } from './seal.js';

const $ = id => document.getElementById(id);
const desktop = window.matchMedia('(pointer: fine)').matches;
const OFFLINE_GRACE_MS = 15000;
const VERBS = ['Working', 'Thinking', 'Exploring', 'Composing', 'Brewing', 'Pondering'];
const state = {
  clientId: null, owner: false,
  sessions: [], sessionId: null, session: null, lease: null,
  live: new Map(), open: new Set(), nodes: new Map(), pending: [], notes: [], slash: { items: [], index: 0, open: false }, pickerChoices: [], attachments: [],
  stream: null, streamFailures: 0, online: null, mode: 'steer', sending: false,
  workingSince: 0, stick: true, renderQueued: false, pinnedEnded: false, sessionsTimer: null, tickTimer: null, retryTimer: null,
  offlineSince: new Map(), settleTimer: null,
};

/* ---------- small utilities ---------- */
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}
function storageGet(key) { try { return localStorage.getItem(key) ?? ''; } catch { return ''; } }
function storageSet(key, value) { try { if (value) localStorage.setItem(key, value); else localStorage.removeItem(key); } catch { /* storage may be blocked */ } }
let toastTimer;
function toast(message, tone = '') {
  const node = $('toast');
  node.textContent = message; node.className = `toast ${tone}`; node.hidden = !message;
  clearTimeout(toastTimer);
  if (message) toastTimer = setTimeout(() => { node.hidden = true; }, tone === 'error' ? 6000 : 3500);
}
function banner(message, tone = '') { $('banner').textContent = message; $('banner').className = `banner ${tone}`; $('banner').hidden = !message; }
const basename = path => String(path ?? '').split('/').filter(Boolean).pop() ?? '';

/* ---------- Wi-Fi encryption (sealed path) ---------- */
// On Wi-Fi/LAN there is no transport encryption, so the daemon only accepts sealed requests there.
// The per-device key comes from the /remote-control pair wifi QR and never crosses the network.
const SEAL_STORE = `pi-remote:seal:${location.origin}`;
let clockOffset = 0;
function sealCreds() { try { const c = JSON.parse(storageGet(SEAL_STORE) || 'null'); return c && typeof c.device === 'string' && typeof c.key === 'string' ? c : null; } catch { return null; } }
function setSealCreds(creds) { storageSet(SEAL_STORE, creds ? JSON.stringify(creds) : ''); }

async function api(path, options = {}, creds = sealCreds(), retried = false) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const method = options.method ?? 'GET';
  const target = new URL(path, location.origin);
  const relative = target.pathname + target.search;
  let headers = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-Pi-Remote'] = '1';
  let body = options.body === undefined ? undefined : JSON.stringify(options.body);
  let context;
  if (creds) {
    const sealed = sealRequest(creds, method, relative, options.body, Date.now() + clockOffset);
    headers = { ...headers, ...sealed.headers }; body = sealed.body; context = sealed.context;
  } else if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    const response = await fetch(relative, { method, headers, credentials: 'same-origin', cache: 'no-store', body, signal: controller.signal });
    const type = response.headers.get('content-type') ?? '';
    let data = {};
    if (type.startsWith(SEAL_CONTENT_TYPE)) data = openResponse(creds, context, await response.text());
    else if (type.includes('application/json')) data = await response.json();
    if (!response.ok) {
      // The phone clock is off: adopt the daemon's time once and retry with a fresh envelope.
      if (data.error === 'seal_clock' && typeof data.now === 'number' && !retried) { clockOffset = data.now - Date.now(); return api(path, options, creds, true); }
      if (creds && ['seal_invalid', 'device_revoked'].includes(data.error) && creds === sealCreds()) setSealCreds(null);
      const error = new Error(friendlyError(data.error, response.status));
      error.status = response.status; error.code = data.error;
      throw error;
    }
    if (typeof data.now === 'number' && Math.abs(data.now - Date.now() - clockOffset) > 30000) clockOffset = data.now - Date.now();
    return data;
  } finally { clearTimeout(timeout); }
}

const ERRORS = {
  invalid_pairing: 'This link was already used or has expired. Run /remote-control in the Pi terminal for a new QR.',
  session_unavailable: 'The Pi session for this link is no longer active. Run /remote-control in the Pi terminal again.',
  unauthenticated: 'This device isn’t paired. Run /remote-control pair in the Pi terminal, then scan the QR.', device_revoked: 'Access for this device was revoked. Run /remote-control pair in the Pi terminal to pair it again.',
  session_offline: 'The Pi session is offline.', session_busy: 'Pi is busy. Try again in a moment.', queue_full: 'Too many messages are waiting. Wait a moment, then try again.',
  rate_limited: 'Too many requests. Try again in a moment.', prompt_too_large: 'Message is too long (max 64 KiB). Shorten it or attach it as a file.',
  slash_commands_disabled: 'Slash commands are sent as commands, not messages.', invalid_command: 'Invalid command format.',
  forbidden: 'This device doesn’t have permission to do that.',
  folder_outside_home: 'The folder must be inside your home directory.', folder_not_found: 'Folder not found. Check the path.', invalid_folder: 'Enter the path of a project folder.', background_start_failed: 'Couldn’t start the background session.', background_not_found: 'Background session not found.',
  tailscale_blocked: 'Access for this device was revoked, so it can’t sign in automatically. Run /remote-control pair in the Pi terminal, then scan the QR.',
  encryption_required: 'On Wi-Fi, all data is encrypted. Run /remote-control pair wifi in the Pi terminal, then scan the QR.',
  seal_invalid: 'This device’s Wi-Fi key is no longer valid. Run /remote-control pair wifi in the Pi terminal, then scan the new QR.',
  seal_replay: 'Request rejected because it looked like a replay. Try again.', no_lan_address: 'The daemon has no Wi-Fi address. Connect the computer to Wi-Fi, or use Tailscale.',
  upload_too_large: 'File is too large (max 25 MB).', upload_empty: 'File is empty.', upload_quota: 'File storage on the computer is full (1 GB). Try again later.',
  too_many_uploads: 'Too many unfinished uploads. Wait for them to finish, then try again.', upload_not_found: 'The file is no longer on the computer. Upload it again.', upload_incomplete: 'Upload isn’t finished yet. Wait for it, then send again.',
  lan_disabled: 'Wi-Fi access is turned off on the computer. Open the Tailscale address, or turn it back on with /remote-control settings in Pi.',
  uploads_disabled: 'Files from the phone are turned off on the computer (/remote-control settings in Pi).',
  too_many_attachments: 'Up to 10 files per message.', attachments_unsupported: 'Pi in this session is running an older version of the extension. Run /reload in that Pi terminal.', frame_too_large: 'Data is too large.',
};
function friendlyError(code, status) {
  if (typeof code === 'string' && ERRORS[code]) return ERRORS[code];
  if (typeof code === 'string') return code.replaceAll('_', ' ');
  return `Request failed (${status}).`;
}

/* ---------- pairing ---------- */
function takePairToken() {
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get('pair') ?? fragment.get('token');
  const wifi = fragment.get('w');
  // The single-use secret leaves the address bar before any request is made.
  if (token || wifi) history.replaceState(null, '', location.pathname + location.search);
  return wifi ? { wifi } : token;
}

function showPair(message, tailscaleUrl) {
  closeStream();
  clearInterval(state.sessionsTimer);
  $('chat-screen').hidden = true; $('panel').hidden = true; closeDrawer();
  $('pair-screen').hidden = false; $('pair-busy').hidden = true; $('pair-form').hidden = false;
  if (message) $('pair-message').textContent = message;
  // Opened over Wi-Fi/LAN: the same host over Tailscale signs this phone in without a QR.
  const link = $('pair-tailscale');
  link.hidden = !tailscaleUrl;
  if (tailscaleUrl) link.href = tailscaleUrl;
}

/** Access ended (cookie expired or revoked): try a silent Tailscale sign-in before asking for a QR. */
let reauthenticating = false;
async function signedOut(message) {
  if (reauthenticating) return;
  reauthenticating = true;
  try {
    const info = await api('/api/bootstrap');
    if (info.paired) { await boot(); return; }
    showPair(info.tailscaleBlocked ? ERRORS.tailscale_blocked : message, info.tailscaleUrl);
  } catch { showPair(message); } finally { reauthenticating = false; }
}

async function pair(token) {
  $('pair-screen').hidden = false; $('chat-screen').hidden = true;
  $('pair-busy').hidden = false; $('pair-form').hidden = true;
  try {
    if (typeof token === 'object' && token.wifi) {
      // Wi-Fi pairing: the claim is sealed with the key from the QR, which proves we scanned it.
      const [requestId, key] = token.wifi.split('.');
      const result = await api('/api/pair', { method: 'POST', body: {} }, { device: `pair:${requestId}`, key });
      setSealCreds({ device: result.clientId, key });
    } else await api('/api/pair', { method: 'POST', body: { token } }, null);
    await boot();
  } catch (error) { showPair(error.message); }
}

function submitPairLink(event) {
  event.preventDefault();
  const value = $('pair-link').value.trim();
  if (!value) return;
  try {
    const url = new URL(value);
    const fragment = new URLSearchParams(url.hash.slice(1));
    const token = fragment.get('w') ? { wifi: fragment.get('w') } : fragment.get('pair');
    // Credentials belong to one origin: a link for another address must be opened there.
    if (url.origin !== location.origin) { location.href = url.href; return; }
    if (token) { $('pair-link').value = ''; void pair(token); }
  } catch {
    $('pair-link').value = ''; void pair(value);
  }
}

/* ---------- boot & sessions ---------- */
async function boot() {
  const token = takePairToken();
  if (token) { await pair(token); return; }
  try {
    let info = await api('/api/bootstrap').catch(error => { if (error.status === 401 && sealCreds()) { setSealCreds(null); return api('/api/bootstrap', {}, null); } throw error; });
    if (!info.paired && info.sealRequired && sealCreds()) { setSealCreds(null); info = await api('/api/bootstrap', {}, null); }
    if (!info.paired) { showPair(info.lanDisabled ? ERRORS.lan_disabled : info.tailscaleBlocked ? ERRORS.tailscale_blocked : info.sealRequired ? ERRORS.encryption_required : undefined, info.tailscaleUrl); return; }
    if (info.sealRequired) toast('Connected over Wi-Fi · all data is encrypted.');
    state.clientId = info.clientId; state.owner = info.owner === true; state.uploads = info.uploads !== false;
    if (info.via === 'tailscale') toast('Signed in automatically with your Tailscale account.');
    banner('');
    $('pair-screen').hidden = true; $('chat-screen').hidden = false;
    document.querySelectorAll('[data-owner]').forEach(node => { node.hidden = !state.owner; });
    $('host-info').textContent = location.host;
    await refreshSessions(true);
    clearInterval(state.sessionsTimer);
    state.sessionsTimer = setInterval(() => void refreshSessions(false).catch(() => {}), 8000);
  } catch (error) {
    if (error.status === 401) { showPair(); return; }
    $('pair-screen').hidden = true; $('chat-screen').hidden = false;
    banner('Can’t reach the Pi host. Check your network (Tailscale/LAN). Retrying…', 'error');
    clearTimeout(state.retryTimer); state.retryTimer = setTimeout(() => void boot(), 5000);
  }
}

async function refreshSessions(choose) {
  let data;
  try { data = await api('/api/sessions'); }
  catch (error) { if (error.status === 401) void signedOut(error.message); throw error; }
  // Live sessions first (newest first), then ended ones that are still readable.
  const all = data.sessions ?? [];
  const live = all.filter(s => s.connection !== 'offline').reverse();
  const ended = all.filter(s => s.connection === 'offline').sort((a, b) => (b.offlineAt ?? 0) - (a.offlineAt ?? 0));
  state.sessions = [...live, ...ended];
  renderSessionList();
  const current = state.sessions.find(s => s.sessionId === state.sessionId);
  for (const s of live) state.offlineSince.delete(s.sessionId);
  if (current?.connection === 'offline' && !state.offlineSince.has(current.sessionId)) state.offlineSince.set(current.sessionId, Date.now());
  // Detach and attach take a session offline for a few seconds while it moves between the terminal
  // and the background (the daemon flags that as `moving`), and Pi or the daemon may just restart.
  // Stay on the session meanwhile instead of jumping to whichever other session is live.
  const settling = current?.connection === 'offline' && !state.pinnedEnded && (current.moving || Date.now() - state.offlineSince.get(current.sessionId) < OFFLINE_GRACE_MS);
  clearTimeout(state.settleTimer);
  if (settling) state.settleTimer = setTimeout(() => void refreshSessions(false).catch(() => {}), 3000);
  // Pi was closed or the session was replaced: move to the live one instead of showing a dead chat.
  const stale = current && current.connection === 'offline' && live.length > 0 && !state.pinnedEnded && !settling;
  if (choose || !current || stale) {
    const remembered = storageGet('pi-remote:session');
    const pick = (settling ? current : null) ?? live.find(s => s.sessionId === remembered) ?? all.find(s => s.sessionId === remembered && s.moving) ?? live[0] ?? (current ? null : ended[0]);
    if (pick && pick.sessionId !== state.sessionId) { selectSession(pick.sessionId); if (stale) toast(`Switched to active session: ${pick.title || basename(pick.cwd) || 'Pi session'}`); }
    else if (pick && !state.stream) openStream();
    if (!pick && !current) showEmpty();
  }
}

function showEmpty() {
  closeStream(); state.sessionId = null; state.session = null;
  state.nodes.clear(); state.live.clear();
  $('messages').replaceChildren(el('p', 'empty', 'No Pi sessions are open. Run /remote-control in the Pi terminal (or /remote-control auto once, to connect every new Pi), and sessions show up here automatically.'));
  updateChrome();
}

function selectSession(sessionId) {
  saveDraft();
  closeStream();
  state.sessionId = sessionId; state.session = null; state.lease = null; state.pending = []; state.online = null;
  state.nodes.clear(); state.live.clear(); state.open.clear(); state.notes = []; state.stick = true;
  storageSet('pi-remote:session', sessionId);
  $('messages').replaceChildren(el('p', 'empty', 'Loading session…'));
  $('input').value = storageGet(draftKey(location.origin, sessionId)); autosize();
  renderSessionList(); renderPending(); updateChrome();
  openStream();
}

function renderSessionList() {
  const list = $('sessions');
  list.replaceChildren();
  if (!state.sessions.length) list.append(el('p', 'dim', 'No active sessions.'));
  for (const session of state.sessions) {
    const button = el('button', `session-item ${session.sessionId === state.sessionId ? 'selected' : ''} ${session.connection === 'offline' ? 'ended' : ''}`);
    button.type = 'button';
    const dot = el('span', `dot ${session.connection === 'offline' ? '' : session.workState === 'running' ? 'busy' : 'live'}`);
    const text = el('span');
    text.append(el('strong', '', session.title || basename(session.cwd) || 'Pi session'));
    if (session.preview) text.append(el('small', 'preview', session.preview));
    text.append(el('small', '', [basename(session.cwd), session.model?.id, session.background ? 'background' : '', session.connection === 'offline' ? (session.moving ? 'moving' : 'ended') : ''].filter(Boolean).join(' · ')));
    button.append(dot, text);
    button.addEventListener('click', () => { if (!isWide()) closeDrawer(); state.pinnedEnded = session.connection === 'offline'; if (session.sessionId !== state.sessionId) selectSession(session.sessionId); });
    list.append(button);
  }
}

/* ---------- live stream ---------- */
function openStream() {
  if (!state.sessionId) return;
  const sessionId = state.sessionId;
  const creds = sealCreds();
  // Sealed stream: the session id travels encrypted and every event is numbered and authenticated.
  const sealed = creds ? sealStream(creds, sessionId, Date.now() + clockOffset) : null;
  const stream = new EventSource(sealed ? `/api/stream?seal=${encodeURIComponent(sealed.query)}` : `/api/stream?session=${encodeURIComponent(sessionId)}`);
  state.stream = stream;
  const read = event => {
    if (!sealed) return JSON.parse(event.data);
    try { return openEvent(creds, sealed.context, event.data); }
    catch { closeStream(); setOnline(false); clearTimeout(state.retryTimer); state.retryTimer = setTimeout(() => { if (state.sessionId === sessionId && !state.stream) openStream(); }, 1000); return null; }
  };
  stream.onopen = () => { state.streamFailures = 0; setOnline(true); };
  stream.addEventListener('snapshot', event => { if (state.stream !== stream) return; const data = read(event); if (data) { setOnline(true); applySnapshot(data); } });
  stream.addEventListener('delta', event => { if (state.stream !== stream) return; const data = read(event); if (data) applyDelta(data); });
  stream.addEventListener('gone', event => {
    const data = read(event);
    if (!data) return;
    const { error } = data;
    closeStream();
    if (error === 'device_revoked' || error === 'unauthenticated') { void signedOut(ERRORS[error]); return; }
    // The session ended or moved (e.g. /new in the terminal): follow the session list.
    void refreshSessions(true).catch(() => {});
  });
  stream.onerror = () => {
    if (state.stream !== stream) return;
    setOnline(false);
    if (sealed) stream.close(); // a sealed URL is single-use; reconnect below with a fresh one
    if (stream.readyState === EventSource.CLOSED) {
      // The server refused the stream (auth or session gone); find out why before retrying.
      closeStream();
      const delay = Math.min(15000, 1000 * 2 ** Math.min(state.streamFailures++, 4));
      clearTimeout(state.retryTimer);
      state.retryTimer = setTimeout(() => void refreshSessions(false).then(() => { if (state.sessionId === sessionId && !state.stream) openStream(); }).catch(() => {}), delay);
    }
  };
}
function closeStream() { if (state.stream) { state.stream.close(); state.stream = null; } }

function setOnline(online) {
  if (state.online === online) return;
  state.online = online;
  banner(online || !state.sessionId ? '' : 'Lost connection to the host. Reconnecting… Unsent messages stay in the input box.');
  updateChrome();
}

function applySnapshot(snapshot) {
  const previous = state.session;
  state.session = snapshot.session; state.lease = snapshot.lease ?? null;
  if (snapshot.session.connection === 'offline' && previous?.connection !== 'offline') void refreshSessions(false).catch(() => {});
  const session = state.session;
  if (isRunning() && !(previous && ['running', 'stopping', 'waiting_local_input'].includes(previous.workState))) state.workingSince = Date.now();
  if (!isRunning()) state.workingSince = 0;
  // Streamed characters only matter while their message is still streaming or not yet in the snapshot.
  const messages = session.messages ?? [];
  const streaming = new Set(messages.filter(m => m.streaming).map(m => String(m.timestamp)));
  const known = new Set(messages.map(m => String(m.timestamp)));
  for (const key of state.live.keys()) { const ts = key.split(':')[0]; if (known.has(ts) && !streaming.has(ts)) state.live.delete(key); }
  if (!isRunning()) state.live.clear();
  prunePending();
  const index = state.sessions.findIndex(s => s.sessionId === session.sessionId);
  if (index >= 0) { const { messages: _omit, ...rest } = session; state.sessions[index] = { ...state.sessions[index], ...rest }; renderSessionList(); }
  updateChrome(); scheduleRender();
}

function applyDelta(delta) {
  if (!state.session) return;
  const key = `${delta.messageTs}:${delta.index}:${delta.kind}`;
  if (!state.live.has(key)) {
    const message = (state.session.messages ?? []).find(m => String(m.timestamp) === String(delta.messageTs));
    const part = Array.isArray(message?.content) ? message.content[delta.index] : undefined;
    state.live.set(key, part ? String(part.text ?? part.thinking ?? '') : '');
  }
  state.live.set(key, state.live.get(key) + delta.text);
  if (!isRunning()) { state.session.workState = 'running'; state.workingSince ||= Date.now(); updateChrome(); }
  scheduleRender();
}

/* ---------- transcript rendering ---------- */
function scheduleRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => { state.renderQueued = false; render(); });
}

function contentText(message) {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(p => p?.type === 'text' ? p.text : p?.type === 'image' ? '[image]' : '').filter(Boolean).join('\n');
}

function transcriptItems() {
  const messages = state.session?.messages ?? [];
  const results = new Map();
  for (const m of messages) if (m.role === 'toolResult' && m.toolCallId) results.set(m.toolCallId, m);
  const calls = new Set();
  const items = [];
  for (const m of messages) {
    const ts = String(m.timestamp ?? '');
    if (m.role === 'user') { const { text, files } = splitAttachments(contentText(m)); items.push({ type: 'user', key: `u:${ts}:${items.length}`, text, files }); continue; }
    if (m.role === 'assistant') {
      const parts = Array.isArray(m.content) ? m.content : typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : [];
      parts.forEach((part, i) => {
        if (part?.type === 'text') {
          const text = m.streaming ? mergeStreamText(part.text, state.live.get(`${ts}:${i}:text`)) : String(part.text ?? '');
          if (text.trim()) items.push({ type: 'text', key: `a:${ts}:${i}`, text, streaming: !!m.streaming && i === parts.length - 1 });
        } else if (part?.type === 'thinking') {
          const text = m.streaming ? mergeStreamText(part.thinking, state.live.get(`${ts}:${i}:thinking`)) : String(part.thinking ?? '');
          if (text.trim()) items.push({ type: 'thinking', key: `th:${ts}:${i}`, text, streaming: !!m.streaming && i === parts.length - 1 });
        } else if (part?.type === 'toolCall') {
          calls.add(part.id);
          const result = results.get(part.id);
          items.push({ type: 'tool', key: `t:${part.id}`, name: part.name, args: part.arguments, output: result ? resultText(result) : '', error: !!result?.isError, running: !result || !!result.streaming });
        }
      });
      if (m.streaming) addLiveParts(items, ts, parts.length);
      if (m.stopReason === 'aborted') items.push({ type: 'error', key: `e:${ts}`, text: 'Stopped.' });
      else if (m.errorMessage) items.push({ type: 'error', key: `e:${ts}`, text: m.errorMessage });
      continue;
    }
    if (m.role === 'toolResult') {
      if (!calls.has(m.toolCallId)) items.push({ type: 'tool', key: `t:${m.toolCallId}`, name: m.toolName, args: {}, output: resultText(m), error: !!m.isError, running: !!m.streaming });
      continue;
    }
    if (m.role === 'bashExecution') {
      items.push({ type: 'tool', key: `b:${ts}`, name: 'bash', args: { command: m.command }, output: String(m.output ?? ''), error: typeof m.exitCode === 'number' && m.exitCode !== 0, running: false });
      continue;
    }
    if (m.role === 'compactionSummary') { items.push({ type: 'note', key: `n:${ts}`, text: '✻ Context compacted.' }); continue; }
    const text = m.summary ?? contentText(m);
    if (text) items.push({ type: 'note', key: `n:${ts}:${items.length}`, text: String(text).slice(0, 2000) });
  }
  // Characters of a message that started after the last snapshot.
  const known = new Set(messages.map(m => String(m.timestamp)));
  for (const ts of new Set([...state.live.keys()].map(k => k.split(':')[0]).filter(ts => !known.has(ts)))) addLiveParts(items, ts, 0);
  // Output of slash commands run from this device (local only, like a terminal's command output).
  for (const note of state.notes) items.push({ type: 'notice', key: note.key, title: note.title, text: note.text });
  return items;
}
function addLiveParts(items, ts, from) {
  const parts = [...state.live.entries()].map(([key, text]) => { const [t, i, kind] = key.split(':'); return { t, i: Number(i), kind, text }; })
    .filter(p => p.t === ts && p.i >= from).sort((a, b) => a.i - b.i);
  for (const p of parts) if (p.text.trim()) items.push({ type: p.kind === 'thinking' ? 'thinking' : 'text', key: `${p.kind === 'thinking' ? 'th' : 'a'}:${ts}:${p.i}`, text: p.text, streaming: true });
}

function render() {
  const container = $('messages');
  const transcript = $('transcript');
  if (!state.session) return;
  const items = transcriptItems();
  if (!items.length) { container.replaceChildren(el('p', 'empty', 'This session is empty. Send your first message.')); state.nodes.clear(); return; }
  const next = items.map(item => {
    const signature = JSON.stringify(item) + (state.open.has(item.key) ? '+' : '');
    const cached = state.nodes.get(item.key);
    if (cached && cached.signature === signature) return cached.node;
    const node = build(item);
    state.nodes.set(item.key, { signature, node });
    return node;
  });
  const current = [...container.children];
  if (current.length !== next.length || current.some((node, i) => node !== next[i])) container.replaceChildren(...next);
  if (state.stick) transcript.scrollTop = transcript.scrollHeight;
  $('jump').hidden = state.stick;
}

function build(item) {
  if (item.type === 'user') {
    const node = el('div', 'msg-user', item.text);
    if (item.files?.length) {
      const row = el('div', 'file-row');
      for (const f of item.files) { const chip = el('span', 'file-chip'); chip.title = f.path; chip.append(el('b', '', f.name), document.createTextNode(f.size)); row.append(chip); }
      node.append(row);
    }
    return node;
  }
  if (item.type === 'text') {
    const node = el('div', 'msg-assistant');
    const body = el('div', 'md');
    body.append(markdown(item.text));
    if (item.streaming) {
      // The caret sits at the end of the last line instead of below the last block.
      let tail = body.lastElementChild;
      while (tail && ['UL', 'OL', 'BLOCKQUOTE'].includes(tail.tagName) && tail.lastElementChild) tail = tail.lastElementChild;
      (tail && tail.tagName !== 'PRE' && tail.tagName !== 'HR' ? tail : body).append(el('span', 'caret'));
    }
    node.append(el('span', 'bullet'), body);
    return node;
  }
  if (item.type === 'thinking') {
    const node = el('details', 'thinking');
    node.open = state.open.has(item.key);
    node.addEventListener('toggle', () => { if (node.open) state.open.add(item.key); else state.open.delete(item.key); });
    node.append(el('summary', '', item.streaming ? '✻ Thinking…' : `✻ Thought (${item.text.trim().split(/\s+/).length} words)`), el('div', 'think-body', item.text));
    return node;
  }
  if (item.type === 'tool') return buildTool(item);
  if (item.type === 'error') return el('div', 'error-line', item.text);
  if (item.type === 'notice') { const node = el('div', 'notice'); if (item.title) node.append(el('strong', '', item.title)); node.append(document.createTextNode(item.text)); return node; }
  return el('div', 'thinking', item.text);
}

function buildTool(item) {
  const open = state.open.has(item.key);
  const node = el('div', `tool${item.running ? ' running' : ''}${item.error ? ' error' : ''}${open ? ' open' : ''}`);
  const { label, detail } = toolSummary(item.name, item.args);
  const head = el('button', 'tool-head');
  head.type = 'button';
  head.setAttribute('aria-expanded', String(open));
  head.append(el('b', '', label), el('span', 'args', detail ? `(${detail})` : ''));
  head.addEventListener('click', () => { if (state.open.has(item.key)) state.open.delete(item.key); else state.open.add(item.key); scheduleRender(); });
  node.append(el('span', 'bullet'), head);
  const out = el('div', 'tool-out');
  const diff = editDiff(item.name, item.args);
  if (diff.length) for (const line of diff.slice(0, open ? 400 : 6)) out.append(el('span', line.kind, `${line.text}\n`));
  else if (item.running && !item.output) out.textContent = 'Running…';
  else out.textContent = (item.output || '(no output)').slice(0, open ? 20000 : 600);
  node.append(out);
  const lines = diff.length || (item.output || '').split('\n').length;
  if (!open && lines > 3) node.append(el('div', 'more', `… +${lines - 3} lines · tap to expand`));
  return node;
}

function editDiff(name, args) {
  if (name !== 'edit' || !args || typeof args !== 'object') return [];
  const edits = Array.isArray(args.edits) ? args.edits : [{ oldText: args.oldText ?? args.old_string, newText: args.newText ?? args.new_string }];
  const lines = [];
  for (const edit of edits.slice(0, 20)) {
    if (edit?.oldText !== undefined) for (const line of String(edit.oldText).split('\n').slice(0, 60)) lines.push({ kind: 'del', text: `- ${line}` });
    if (edit?.newText !== undefined) for (const line of String(edit.newText).split('\n').slice(0, 60)) lines.push({ kind: 'add', text: `+ ${line}` });
  }
  return lines;
}

function markdown(text) {
  const fragment = document.createDocumentFragment();
  for (const block of parseMarkdown(text)) fragment.append(markdownBlock(block));
  return fragment;
}
function markdownBlock(block) {
  if (block.type === 'code') { const pre = el('pre'); pre.append(el('code', '', block.text)); return pre; }
  if (block.type === 'heading') return inlines(el(`h${Math.min(4, block.level)}`), block.inlines);
  if (block.type === 'quote') { const quote = el('blockquote'); for (const b of block.blocks) quote.append(markdownBlock(b)); return quote; }
  if (block.type === 'list') { const list = el(block.ordered ? 'ol' : 'ul'); for (const item of block.items) list.append(inlines(el('li'), item.inlines)); return list; }
  if (block.type === 'rule') return el('hr');
  return inlines(el('p'), block.inlines);
}
function inlines(parent, parts) {
  for (const part of parts) {
    if (part.type === 'code') parent.append(el('code', '', part.text));
    else if (part.type === 'bold') parent.append(el('strong', '', part.text));
    else if (part.type === 'italic') parent.append(el('em', '', part.text));
    else if (part.type === 'link') { const a = el('a', '', part.text); a.href = part.href; a.target = '_blank'; a.rel = 'noopener noreferrer'; parent.append(a); }
    else parent.append(document.createTextNode(part.text));
  }
  return parent;
}

/* ---------- chrome: header, working line, composer ---------- */
function isRunning() { return ['running', 'stopping', 'waiting_local_input'].includes(state.session?.workState); }
function isLive() { return state.online && !!state.session && state.session.connection !== 'offline' && state.session.workState !== 'ended'; }

function updateChrome() {
  const session = state.session;
  $('title').textContent = session ? (session.title || basename(session.cwd) || 'Pi session') : 'Pi';
  const usage = session?.usage && typeof session.usage.percent === 'number' ? `${Math.round(session.usage.percent)}% context` : '';
  $('subtitle').textContent = session ? [session.background ? `background (${session.background.backend})` : '', basename(session.cwd), session.model?.id, session.thinkingLevel && session.thinkingLevel !== 'off' ? session.thinkingLevel : '', usage].filter(Boolean).join(' · ') : '';
  const status = $('status');
  let text = 'Ready', tone = 'live';
  if (!state.sessionId) { text = 'No session'; tone = ''; }
  else if (state.online === false) { text = 'Reconnecting'; tone = 'off'; }
  else if (!session) { text = 'Loading'; tone = ''; }
  else if (session.connection === 'offline' && session.moving) { text = 'Moving'; tone = 'busy'; }
  else if (session.connection === 'offline' || session.workState === 'ended') { text = 'Ended'; tone = ''; }
  else if (isRunning()) { text = 'Working'; tone = 'busy'; }
  status.className = `status ${tone}`; $('status-text').textContent = text;

  const running = isRunning() && isLive();
  $('working').hidden = !running;
  $('stop').hidden = !running;
  $('mode-toggle').hidden = !running;
  $('mode-toggle').textContent = state.mode === 'steer' ? 'Steer ⇄' : 'Queue ⇄';
  $('mode-hint').textContent = !isLive() ? (session?.connection === 'offline' && session.moving ? 'This session is moving between the terminal and the background. It will be back in a moment.' : session && (session.connection === 'offline' || session.workState === 'ended') ? 'This session was closed in the terminal. You can still read the transcript.' : state.sessionId && session ? 'This session can’t receive messages yet.' : '') : running
    ? (state.mode === 'steer' ? 'Pi reads this after its current step.' : 'Sent after Pi finishes.')
    : desktop ? 'Enter to send · Shift+Enter for a new line · / for commands' : 'Type / for commands';
  updateWorking();
  updateSend();
}
function updateSend() {
  const files = state.attachments;
  $('send').disabled = !isLive() || state.sending || files.some(a => a.status !== 'done') || (!$('input').value.trim() && !files.length);
  const canAttach = isLive() && state.uploads !== false && !!state.session?.capabilities?.includes('attachments');
  $('attach').disabled = !canAttach;
  $('attach').title = canAttach || !isLive() ? 'Attach files or photos' : state.uploads === false ? ERRORS.uploads_disabled : 'Run /reload in this session’s Pi terminal to send files';
}

function updateWorking() {
  if ($('working').hidden) return;
  const ws = state.session?.workState;
  const seconds = state.workingSince ? Math.floor((Date.now() - state.workingSince) / 1000) : 0;
  $('working-text').textContent = ws === 'stopping' ? 'Stopping…' : ws === 'waiting_local_input' ? 'Waiting for an answer in the terminal…' : `${VERBS[Math.floor(seconds / 6) % VERBS.length]}…`;
  $('working-time').textContent = `(${seconds}s${desktop ? ' · esc to stop' : ''})`;
}

function autosize() {
  const input = $('input');
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, Math.floor(window.innerHeight * 0.4))}px`;
}
function saveDraft() { if (state.sessionId) storageSet(draftKey(location.origin, state.sessionId), $('input').value); }

function renderPending() {
  $('pending').replaceChildren(...state.pending.map(p => el('div', 'pending-item', `${p.kind === 'follow_up' ? '⏳ queued' : p.kind === 'steer' ? '↪ steer' : '› sent'} · ${[p.text.replace(/\s+/g, ' ').trim(), p.files ? `${p.files} ${p.files === 1 ? 'file' : 'files'}` : ''].filter(Boolean).join(' + ')}`)));
}
function prunePending() {
  const users = (state.session?.messages ?? []).filter(m => m.role === 'user').map(m => ({ text: splitAttachments(contentText(m)).text.trim(), ts: Number(m.timestamp) || 0 }));
  const idle = !isRunning();
  state.pending = state.pending.filter(p => !users.some(u => u.text === p.text.trim() && u.ts >= p.at - 60_000) && !(idle && Date.now() - p.at > 4000));
  renderPending();
}

/* ---------- commands ---------- */
async function ensureLease(force = false) {
  const lease = state.lease;
  const expires = typeof lease?.expiresAt === 'number' ? lease.expiresAt : Date.parse(lease?.expiresAt ?? '') || 0;
  if (!force && lease?.clientId === state.clientId && expires - Date.now() > 5000) return lease;
  const result = await api(`/api/sessions/${encodeURIComponent(state.sessionId)}/lease`, { method: 'POST', body: { takeover: true } });
  state.lease = result.lease ?? result;
  return state.lease;
}

async function command(kind, text, attempt = 0, attachments = undefined) {
  const session = state.session;
  const lease = await ensureLease(attempt > 0);
  const envelope = {
    commandId: createCommandId(), sessionId: session.sessionId, runtimeId: session.runtimeId, bindingEpoch: session.bindingEpoch,
    branchId: session.branchId, leaseEpoch: lease.leaseEpoch, kind, payload: kind === 'abort' ? {} : { text, ...(attachments ? { attachments } : {}) }, expiresAt: Date.now() + 25000,
  };
  try {
    const result = await api(`/api/sessions/${encodeURIComponent(session.sessionId)}/commands`, { method: 'POST', body: envelope });
    return { ...(result.command ?? result), kind };
  } catch (error) {
    // Pi started working between reading state and sending: deliver as guidance instead.
    if (error.code === 'session_busy' && kind === 'prompt' && attempt < 2) return command(state.mode, text, attempt + 1, attachments);
    // The lease or the session context moved (another device, /tree in the terminal): refresh once and retry.
    if (['lease_required', 'lease_stale', 'lease_held', 'stale_context', 'stale_binding', 'stale_runtime'].includes(error.code) && attempt < 1) {
      const fresh = await api(`/api/sessions/${encodeURIComponent(session.sessionId)}`);
      state.session = { ...fresh.session, messages: state.session?.messages ?? fresh.session.messages };
      state.lease = fresh.lease ?? null;
      return command(kind, text, attempt + 1, attachments);
    }
    throw error;
  }
}

async function send() {
  const text = $('input').value;
  const files = state.attachments;
  if ((!text.trim() && !files.length) || !isLive() || state.sending) return;
  if (files.some(a => a.status !== 'done')) { toast(files.some(a => a.status === 'error') ? 'A file failed to upload. Tap it to retry, or remove it.' : 'Wait until all files finish uploading.', 'error'); return; }
  closeSlash();
  if (text.trim().startsWith('/')) {
    if (files.length) { toast('Files can’t be sent with a slash command. Send the command first, or remove the /.', 'error'); return; }
    await runSlash(text.trim()); return;
  }
  const kind = isRunning() ? state.mode : 'prompt';
  state.sending = true; updateSend();
  try {
    const result = await command(kind, text, 0, files.length ? files.map(a => a.uploadId) : undefined);
    if (['rejected', 'stale_context', 'failed'].includes(result.status)) { toast(`Not sent: ${friendlyError(result.error)}`, 'error'); return; }
    $('input').value = ''; autosize(); saveDraft();
    clearAttachments();
    state.pending.push({ kind: result.kind, text, files: files.length, at: Date.now() }); renderPending();
    state.stick = true; scheduleRender();
    if (result.status === 'indeterminate') toast('Delivery couldn’t be confirmed. Check the transcript before sending again.', 'error');
  } catch (error) {
    if (error.status === 401) { void signedOut(error.message); return; }
    toast(error.message, 'error');
  } finally { state.sending = false; updateSend(); }
}

/* ---------- attachments ---------- */
let attachSeq = 0, pumping = false;
function addFiles(list) {
  const files = [...(list ?? [])];
  if (!files.length) return;
  if (!isLive()) { toast('Select an active session first.', 'error'); return; }
  if (state.uploads === false) { toast(ERRORS.uploads_disabled, 'error'); return; }
  if (!state.session?.capabilities?.includes('attachments')) { toast(friendlyError('attachments_unsupported'), 'error'); return; }
  for (const file of files) {
    if (state.attachments.length >= UPLOAD_MAX_FILES) { toast(`Up to ${UPLOAD_MAX_FILES} files per message.`, 'error'); break; }
    if (!file.size) { toast(`${file.name || 'File'} is empty.`, 'error'); continue; }
    if (file.size > UPLOAD_MAX_BYTES) { toast(`${file.name} is too large (max 25 MB).`, 'error'); continue; }
    const name = file.name || `pasted-${Date.now()}.${(file.type.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 5)}`;
    state.attachments.push({ id: ++attachSeq, file, name, size: file.size, sent: 0, status: 'queued', preview: /^image\/(png|jpeg|gif|webp)$/.test(file.type) ? URL.createObjectURL(file) : '' });
  }
  renderAttachments(); updateSend(); void pumpUploads();
}
async function pumpUploads() {
  if (pumping) return;
  pumping = true;
  try { let item; while ((item = state.attachments.find(a => a.status === 'queued'))) await uploadOne(item); }
  finally { pumping = false; }
}
function base64Of(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => { const url = String(reader.result); resolve(url.slice(url.indexOf(',') + 1)); };
    reader.onerror = () => reject(reader.error ?? new Error('Couldn’t read the file.'));
    reader.readAsDataURL(blob);
  });
}
/** Chunked upload: each chunk is a normal API call, so it is sealed on Wi-Fi like everything else. */
async function uploadOne(item) {
  item.status = 'uploading'; item.sent = 0; item.error = ''; renderAttachments();
  try {
    const created = await api(`/api/sessions/${encodeURIComponent(state.sessionId)}/uploads`, { method: 'POST', body: { name: item.name, size: item.size, type: item.file.type } });
    item.uploadId = created.uploadId;
    for (let offset = 0; offset < item.size && !item.removed; offset += created.chunkSize) {
      const data = await base64Of(item.file.slice(offset, offset + created.chunkSize));
      if (item.removed) break;
      const result = await api(`/api/uploads/${item.uploadId}`, { method: 'POST', body: { offset, data } });
      item.sent = result.received;
      if (result.done) item.status = 'done';
      renderAttachments();
    }
    if (!item.removed && item.status !== 'done') throw new Error('Upload incomplete.');
  } catch (error) {
    if (item.removed) return;
    item.status = 'error'; item.error = error.message; renderAttachments();
    if (error.code === 'uploads_disabled') { state.uploads = false; updateSend(); toast(error.message, 'error'); }
    if (error.status === 401) void signedOut(error.message);
  } finally { updateSend(); }
}
function forgetUpload(item) {
  if (item.uploadId) void api(`/api/uploads/${item.uploadId}`, { method: 'DELETE' }).catch(() => {});
  item.uploadId = undefined;
}
function removeAttachment(item) {
  item.removed = true;
  state.attachments = state.attachments.filter(a => a !== item);
  if (item.preview) URL.revokeObjectURL(item.preview);
  forgetUpload(item);
  renderAttachments(); updateSend();
}
function retryAttachment(item) {
  if (item.status !== 'error') return;
  forgetUpload(item);
  item.status = 'queued'; renderAttachments(); updateSend(); void pumpUploads();
}
/** After sending: the files stay on the computer for Pi; only the composer forgets them. */
function clearAttachments() {
  for (const item of state.attachments) if (item.preview) URL.revokeObjectURL(item.preview);
  state.attachments = []; renderAttachments();
}
function renderAttachments() {
  const box = $('attachments');
  box.hidden = !state.attachments.length;
  box.replaceChildren(...state.attachments.map(item => {
    const node = el('div', `attachment ${item.status}`);
    let visual;
    if (item.preview) { visual = el('img', 'thumb'); visual.src = item.preview; visual.alt = ''; }
    else visual = el('span', 'badge', fileBadge(item.name));
    const meta = item.status === 'error' ? 'Failed · tap to retry' : item.status === 'done' ? formatBytes(item.size)
      : item.status === 'queued' ? 'Waiting…' : `${Math.floor((item.sent / item.size) * 100)}% · ${formatBytes(item.size)}`;
    const text = el('span', 'att-text'); text.append(el('span', 'att-name', item.name), el('span', 'att-meta', meta));
    if (item.status === 'error') { node.title = item.error; node.addEventListener('click', () => retryAttachment(item)); }
    const remove = el('button', 'att-remove', '×'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove ${item.name}`);
    remove.addEventListener('click', event => { event.stopPropagation(); removeAttachment(item); });
    const bar = el('span', 'att-progress');
    bar.style.width = item.status === 'uploading' ? `${(item.sent / item.size) * 100}%` : '0';
    node.append(visual, text, remove, bar);
    return node;
  }));
}

async function stop() {
  if (!isLive()) return;
  $('stop').disabled = true;
  try {
    await command('abort');
    if (state.pending.length) toast('Pi stopped. Queued messages were moved to the terminal editor.');
    state.pending = []; renderPending();
  } catch (error) { toast(error.message, 'error'); }
  finally { $('stop').disabled = false; }
}

/* ---------- slash commands ---------- */
async function runSlash(text, fromPicker = false) {
  if (!isLive() || state.sending) return;
  state.sending = true; updateSend();
  try {
    const result = await command('command', text);
    if (!fromPicker) { $('input').value = ''; autosize(); saveDraft(); }
    if (['rejected', 'stale_context', 'failed'].includes(result.status)) { toast(friendlyError(result.error), 'error'); return; }
    const output = result.output ?? {};
    if (Array.isArray(output.choices) && output.choices.length) openPicker(output.title ?? text, output.choices);
    else if (output.message) addNote(output.title ?? text.split(/\s/)[0], output.message);
  } catch (error) {
    if (error.status === 401) { void signedOut(error.message); return; }
    toast(error.message, 'error');
  } finally { state.sending = false; updateSend(); }
}

function addNote(title, text) {
  state.notes.push({ key: `note:${Date.now()}:${state.notes.length}`, title, text: String(text).slice(0, 20000) });
  if (state.notes.length > 20) state.notes.shift();
  state.stick = true; scheduleRender();
}

function slashQuery() {
  const value = $('input').value;
  if (!value.startsWith('/') || value.includes('\n')) return null;
  const caret = $('input').selectionStart ?? value.length;
  const space = value.search(/\s/);
  if (space !== -1 && caret > space) return null;
  return value.slice(1, space === -1 ? undefined : space);
}

function updateSlash() {
  const query = slashQuery();
  const commands = state.session?.commands ?? [];
  if (query === null || !isLive()) { closeSlash(); return; }
  state.slash.items = matchCommands(commands, query).slice(0, 50);
  state.slash.index = Math.min(state.slash.index, Math.max(0, state.slash.items.length - 1));
  state.slash.open = true;
  renderSlash();
}

function renderSlash() {
  const menu = $('slash-menu');
  menu.hidden = !state.slash.open;
  if (!state.slash.open) return;
  if (!state.slash.items.length) { menu.replaceChildren(el('div', 'slash-empty', 'No matching commands.')); return; }
  menu.replaceChildren(...state.slash.items.map((cmd, i) => {
    const item = el('button', `slash-item${i === state.slash.index ? ' active' : ''}`);
    item.type = 'button'; item.setAttribute('role', 'option'); item.setAttribute('aria-selected', String(i === state.slash.index));
    item.append(el('span', 'cmd', `/${cmd.name}`));
    if (cmd.hint) item.append(el('span', 'hint', cmd.hint));
    item.append(el('span', 'desc', cmd.description ?? ''));
    if (cmd.source && cmd.source !== 'remote') item.append(el('span', 'src', cmd.source));
    // mousedown keeps focus in the textarea so the keyboard stays open on phones
    item.addEventListener('mousedown', event => event.preventDefault());
    item.addEventListener('click', () => applySlash(cmd));
    return item;
  }));
  menu.children[state.slash.index]?.scrollIntoView({ block: 'nearest' });
}

function closeSlash() { state.slash.open = false; state.slash.index = 0; $('slash-menu').hidden = true; }

function applySlash(cmd) {
  closeSlash();
  const input = $('input');
  // Built-ins without a required argument run at once (/model and /thinking open a picker).
  // Required arguments, and extension/prompt/skill commands that may take arguments, are filled in first.
  const required = typeof cmd.hint === 'string' && cmd.hint.startsWith('<');
  if (cmd.source === 'remote' && !required) { void runSlash(`/${cmd.name}`); return; }
  input.value = `/${cmd.name} `; autosize(); input.focus(); updateSend();
}

function openPicker(title, choices) {
  state.pickerChoices = choices;
  $('picker-title').textContent = title;
  $('picker-filter').value = '';
  $('picker-filter').hidden = choices.length < 10;
  renderPicker();
  $('picker').hidden = false; $('picker-scrim').hidden = false;
  if (desktop && choices.length >= 10) $('picker-filter').focus();
}
function closePicker() { $('picker').hidden = true; $('picker-scrim').hidden = true; }
function renderPicker() {
  const query = $('picker-filter').value.trim().toLowerCase();
  const shown = state.pickerChoices.filter(c => `${c.label} ${c.detail ?? ''}`.toLowerCase().includes(query)).slice(0, 300);
  $('picker-list').replaceChildren(...(shown.length ? shown.map(choice => {
    const item = el('button', 'picker-item'); item.type = 'button';
    const label = el('span', 'label', choice.label);
    if (choice.detail) { label.append(document.createElement('br'), el('small', '', choice.detail)); }
    item.append(label, el('span', 'check', choice.current ? '✓' : ''));
    item.addEventListener('click', () => { closePicker(); void runSlash(choice.value, true); });
    return item;
  }) : [el('p', 'dim', 'No matches.')]));
}

/* ---------- drawer & panels ---------- */
const isWide = () => window.matchMedia('(min-width: 768px)').matches;

function updateSidebar(open, save = true) {
  state.sidebarOpen = open;
  if (save) {
    try { localStorage.setItem('pi-sidebar', open ? 'open' : 'closed'); } catch { /* ignore */ }
  }
  const app = $('chat-screen');
  if (app) {
    app.classList.toggle('sidebar-collapsed', !open);
    app.setAttribute('data-sidebar', open ? 'open' : 'closed');
  }
  const drawer = $('drawer');
  if (drawer) {
    if (isWide()) {
      drawer.hidden = false;
      drawer.classList.remove('open');
      $('scrim').hidden = true;
    } else {
      drawer.hidden = !open;
      drawer.classList.toggle('open', open);
      $('scrim').hidden = !open;
    }
  }
}

function openDrawer() {
  updateSidebar(true, true);
  void refreshSessions(false).catch(() => {});
}

function closeDrawer() {
  updateSidebar(false, true);
}

function toggleSidebar() {
  updateSidebar(!state.sidebarOpen, true);
}

const PANELS = { background: 'Background sessions', devices: 'Devices' };
function openPanel(name) {
  if (!isWide()) closeDrawer();
  $('panel').hidden = false; $('panel-title').textContent = PANELS[name];
  for (const key of Object.keys(PANELS)) $(`panel-${key}`).hidden = key !== name;
  const load = { background: loadBackground, devices: loadDevices }[name];
  void load().catch(error => toast(error.message, 'error'));
}

async function loadDevices() {
  const data = await api('/api/devices').catch(error => { if (error.status === 403) return { devices: null }; throw error; });
  const list = $('device-list'); list.replaceChildren();
  if (!data.devices) { list.append(el('p', 'dim', 'Only the owner’s device can see this list. Manage devices from the terminal with /remote-control devices.')); return; }
  const devices = data.devices.filter(d => !d.revoked);
  if (!devices.length) list.append(el('p', 'dim', 'No devices yet.'));
  for (const device of devices) {
    const card = el('div', 'card'); const info = el('div', 'grow');
    const expires = device.expiresAt ? new Date(device.expiresAt).toLocaleDateString('en', { day: 'numeric', month: 'short' }) : '';
    info.append(el('strong', '', `${device.name}${device.clientId === state.clientId ? ' (this device)' : ''}`), el('small', '', `${device.clientId.slice(0, 8)}${expires ? ` · expires ${expires}` : ''}`));
    const button = el('button', 'btn ghost small danger', 'Revoke'); button.type = 'button';
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await api(`/api/devices/${encodeURIComponent(device.clientId)}`, { method: 'DELETE' });
        if (device.clientId === state.clientId) { showPair(ERRORS.device_revoked); return; }
        toast('Access revoked.'); await loadDevices();
      } catch (error) { button.disabled = false; toast(error.message, 'error'); }
    });
    card.append(info, button); list.append(card);
  }
}

async function loadBackground() {
  const data = await api('/api/background');
  $('background-backend').textContent = data.backend === 'tmux'
    ? 'Backend: tmux. Continue a session in the terminal with /remote-control attach or tmux attach.'
    : 'Backend: Pi RPC mode (tmux not found). Install tmux (sudo apt install tmux / brew install tmux) to view sessions in the terminal.';
  $('background-folders').replaceChildren(...(data.folders ?? []).map(folder => { const option = document.createElement('option'); option.value = folder; return option; }));
  if (!$('background-folder').value && data.folders?.[0]) $('background-folder').value = data.folders[0];
  const list = $('background-list'); list.replaceChildren();
  if (!data.sessions?.length) { list.append(el('p', 'dim', 'No background sessions.')); return; }
  for (const entry of data.sessions) {
    const card = el('div', 'card'); const info = el('div', 'grow');
    info.append(el('strong', '', entry.preview ? `"${entry.preview}"` : entry.messageCount === 0 ? '(empty)' : entry.title || basename(entry.cwd) || entry.name),
      el('small', '', [entry.name, entry.backend, typeof entry.messageCount === 'number' ? `${entry.messageCount} msg` : '', entry.cwd].filter(Boolean).join(' · ')));
    if (entry.attach) info.append(el('code', 'cmd', entry.attach));
    const actions = el('div', 'actions');
    if (entry.sessionId) {
      const open = el('button', 'btn small', 'Open'); open.type = 'button';
      open.addEventListener('click', () => { $('panel').hidden = true; state.pinnedEnded = false; selectSession(entry.sessionId); });
      actions.append(open);
    }
    const stopButton = el('button', 'btn ghost small danger', 'Stop'); stopButton.type = 'button';
    stopButton.addEventListener('click', async () => {
      stopButton.disabled = true; stopButton.textContent = 'Stopping…';
      try { await api(`/api/background/${encodeURIComponent(entry.name)}/stop`, { method: 'POST', body: {} }); toast('Background session stopped. Its conversation is still saved.'); await loadBackground(); }
      catch (error) { stopButton.disabled = false; stopButton.textContent = 'Stop'; toast(error.message, 'error'); }
    });
    actions.append(stopButton);
    card.append(info, actions); list.append(card);
  }
}

function applyTheme(choice) {
  const theme = choice === 'dark' || choice === 'light' ? choice : 'system';
  try { localStorage.setItem('pi-theme', theme); } catch { /* ignore */ }
  document.documentElement.setAttribute('data-theme', theme);
  const isDark = theme === 'dark' || (theme === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.content = isDark ? '#1a1915' : '#faf9f5';
  document.querySelectorAll('.theme-btn').forEach(btn => {
    const val = btn.getAttribute('data-theme-choice') || btn.dataset.themeChoice;
    const active = val === theme;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-checked', String(active));
  });
}

/* ---------- wiring ---------- */
function initialize() {
  const savedTheme = (() => { try { return localStorage.getItem('pi-theme') || 'system'; } catch { return 'system'; } })();
  applyTheme(savedTheme);
  const themeSwitch = $('theme-switch');
  if (themeSwitch) {
    const onThemeAction = event => {
      const btn = event.target.closest('.theme-btn');
      if (!btn) return;
      const choice = btn.getAttribute('data-theme-choice') || btn.dataset.themeChoice;
      if (choice) applyTheme(choice);
    };
    themeSwitch.addEventListener('click', onThemeAction);
  }
  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const choice = btn.getAttribute('data-theme-choice') || btn.dataset.themeChoice;
      if (choice) applyTheme(choice);
    });
  });
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      try {
        if ((localStorage.getItem('pi-theme') || 'system') === 'system') applyTheme('system');
      } catch { /* ignore */ }
    });
  }
  const savedSidebar = (() => {
    try { return localStorage.getItem('pi-sidebar'); } catch { return null; }
  })();
  const initialSidebar = savedSidebar !== null ? savedSidebar === 'open' : true;
  updateSidebar(initialSidebar, false);
  $('pair-form').addEventListener('submit', submitPairLink);
  $('composer').addEventListener('submit', event => { event.preventDefault(); void send(); });
  $('input').addEventListener('input', () => { autosize(); saveDraft(); updateSend(); updateSlash(); });
  $('input').addEventListener('click', updateSlash);
  $('input').addEventListener('blur', () => setTimeout(closeSlash, 150));
  $('input').addEventListener('keydown', event => {
    if (state.slash.open && !event.isComposing) {
      const count = state.slash.items.length;
      if (event.key === 'ArrowDown' && count) { event.preventDefault(); state.slash.index = (state.slash.index + 1) % count; renderSlash(); return; }
      if (event.key === 'ArrowUp' && count) { event.preventDefault(); state.slash.index = (state.slash.index - 1 + count) % count; renderSlash(); return; }
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeSlash(); return; }
      const typedFull = state.slash.items[state.slash.index] && $('input').value.trim() === `/${state.slash.items[state.slash.index].name}`;
      if ((event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey && !typedFull)) && count) { event.preventDefault(); applySlash(state.slash.items[state.slash.index]); return; }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && (desktop || event.ctrlKey || event.metaKey)) { event.preventDefault(); void send(); }
  });
  $('picker-close').addEventListener('click', closePicker);
  $('picker-scrim').addEventListener('click', closePicker);
  $('picker-filter').addEventListener('input', renderPicker);
  $('picker-filter').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); $('picker-list').querySelector('button')?.click(); } if (event.key === 'Escape') closePicker(); });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (!$('picker').hidden) { closePicker(); return; }
    if (!isWide() && state.sidebarOpen) { closeDrawer(); return; }
    if (!$('stop').hidden && $('panel').hidden && !state.slash.open) void stop();
  });
  $('stop').addEventListener('click', () => void stop());
  $('attach').addEventListener('click', () => $('file-input').click());
  $('file-input').addEventListener('change', event => { addFiles(event.target.files); event.target.value = ''; });
  $('input').addEventListener('paste', event => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (files.length) { event.preventDefault(); addFiles(files); }
  });
  const composer = $('composer');
  composer.addEventListener('dragover', event => { if ([...(event.dataTransfer?.types ?? [])].includes('Files')) { event.preventDefault(); composer.classList.add('dragging'); } });
  composer.addEventListener('dragleave', () => composer.classList.remove('dragging'));
  composer.addEventListener('drop', event => { composer.classList.remove('dragging'); if (event.dataTransfer?.files?.length) { event.preventDefault(); addFiles(event.dataTransfer.files); } });
  $('mode-toggle').addEventListener('click', () => { state.mode = state.mode === 'steer' ? 'follow_up' : 'steer'; updateChrome(); });
  $('transcript').addEventListener('scroll', () => {
    const node = $('transcript');
    state.stick = node.scrollHeight - node.scrollTop - node.clientHeight < 60;
    $('jump').hidden = state.stick;
  }, { passive: true });
  $('jump').addEventListener('click', () => { state.stick = true; $('transcript').scrollTop = $('transcript').scrollHeight; $('jump').hidden = true; });
  $('menu-button').addEventListener('click', toggleSidebar);
  $('drawer-close').addEventListener('click', toggleSidebar);
  $('scrim').addEventListener('click', closeDrawer);
  window.addEventListener('resize', () => {
    updateSidebar(state.sidebarOpen, false);
  });
  document.querySelectorAll('[data-panel]').forEach(button => button.addEventListener('click', () => openPanel(button.dataset.panel)));
  $('panel-back').addEventListener('click', () => { $('panel').hidden = true; });
  $('logout').addEventListener('click', async () => {
    try { await api('/api/logout', { method: 'POST', body: {} }); } catch { /* already signed out */ }
    setSealCreds(null);
    showPair('You’re signed out. Run /remote-control pair in the Pi terminal, then scan the QR to sign in again.');
  });
  $('background-form').addEventListener('submit', async event => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button'); button.disabled = true;
    try {
      const entry = await api('/api/background', { method: 'POST', body: { cwd: $('background-folder').value } });
      toast(`Background session started (${entry.name}). It will appear in the session list in a few seconds.`);
      await loadBackground();
      setTimeout(() => void refreshSessions(false).then(() => { const live = state.sessions.find(x => x.background?.name === entry.name); if (live) { $('panel').hidden = true; selectSession(live.sessionId); } }).catch(() => {}), 4000);
    } catch (error) { toast(error.message, 'error'); } finally { button.disabled = false; }
  });
  state.tickTimer = setInterval(updateWorking, 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden || $('chat-screen').hidden) return;
    // Mobile browsers suspend background tabs; reconnect and resync when the user returns.
    if (!state.stream || state.stream.readyState === EventSource.CLOSED) { closeStream(); if (state.sessionId) openStream(); else void refreshSessions(true).catch(() => {}); }
  });
  window.addEventListener('online', () => { if (!$('chat-screen').hidden && state.sessionId && !state.stream) openStream(); });
  window.addEventListener('pagehide', saveDraft);
  let installPrompt;
  window.addEventListener('beforeinstallprompt', event => { event.preventDefault(); installPrompt = event; $('install').hidden = false; });
  $('install').addEventListener('click', async () => { if (installPrompt) { await installPrompt.prompt(); installPrompt = null; $('install').hidden = true; } });
  if ('serviceWorker' in navigator && window.isSecureContext) void navigator.serviceWorker.register('/sw.js').catch(() => {});
  void boot();
}

initialize();
