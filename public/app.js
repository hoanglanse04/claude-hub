const STATUS = {
  idle: 'sẵn sàng',
  running: 'đang chạy',
  waiting: 'chờ bạn',
  done: 'xong',
  exited: 'đã thoát',
};

const state = {
  projects: [],
  sessions: [],
  selected: null, // { kind: 'session', id } | { kind: 'worktree', path }
  filesOpen: false,
  history: new Map(), // worktree path -> { loading, items, error, filter }
  mcpOpen: false,
  mcpAvail: new Map(), // cwd -> [{ name, scope, type, target }]
  mcpHealth: new Map(), // cwd -> { loading, result: { name: { ok, pending, detail } } }
  mcpDraft: null, // { sid, names: Set } – unsaved checkbox state
  shells: [],
  shellKinds: [],
};
const terms = new Map(); // session id -> { term, fit, el }
let ws;

// ---------- settings ----------
const SETTINGS_KEY = 'claude-hub.settings';
const DEFAULTS = {
  accent: '#faad14', accentInk: '#000000', bg: '#000000', panel: '#070707', panel2: '#101010', border: '#262626',
  text: '#e8e6e1', muted: '#7d7a73', running: '#13c2c2', waiting: '#ff7a45', done: '#52c41a', danger: '#ff4d4f',
  cut: 8, grid: true, sidebarW: 340, fontSize: 14, mono: 'Cascadia Mono', termFont: 'Cascadia Mono', termSize: 14,
  sound: true, anim: true, brand: '', css: '', shell: 'powershell',
};
const PRESETS = [
  { name: 'HUD vàng', accent: '#faad14', running: '#13c2c2' },
  { name: 'Cyan', accent: '#13c2c2', running: '#faad14' },
  { name: 'Đỏ', accent: '#ff4d4f', running: '#13c2c2' },
  { name: 'Lục', accent: '#52c41a', running: '#13c2c2', done: '#faad14' },
  { name: 'Tím', accent: '#9254de', running: '#13c2c2' },
  { name: 'Trắng', accent: '#e8e6e1', running: '#13c2c2' },
];
const MONO_FONTS = ['Cascadia Mono', 'Cascadia Code', 'JetBrains Mono', 'Fira Code', 'Consolas', 'Courier New'];
const COLOR_FIELDS = [
  ['accent', 'Màu nhấn'], ['accentInk', 'Chữ trên nền nhấn'], ['bg', 'Nền'], ['panel', 'Khối'], ['panel2', 'Khối khi rê chuột'],
  ['border', 'Viền'], ['text', 'Chữ'], ['muted', 'Chữ phụ'], ['running', 'Đang chạy'], ['waiting', 'Chờ bạn'], ['done', 'Xong'], ['danger', 'Nguy hiểm'],
];
const HEX_RE = /^#[0-9a-f]{6}$/i;

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    return sanitizeSettings(saved);
  } catch { return { ...DEFAULTS }; }
}

// keep only known keys with the right type, so an old or hand-edited value can't break the page
function sanitizeSettings(obj) {
  const out = { ...DEFAULTS };
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const v = obj?.[k];
    if (typeof v !== typeof def) continue;
    if (typeof def === 'string' && def.startsWith('#') && !HEX_RE.test(v)) continue;
    out[k] = v;
  }
  return out;
}

let settings = loadSettings();

function saveSettings() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* storage blocked */ }
}

function termTheme() {
  return { background: settings.bg, foreground: settings.text, cursor: settings.accent, cursorAccent: settings.bg, selectionBackground: `${settings.accent}55` };
}

function applySettings() {
  const root = document.documentElement.style;
  const vars = { accent: 'accent', accentInk: 'accent-ink', bg: 'bg', panel: 'panel', panel2: 'panel-2', border: 'border', text: 'text', muted: 'muted', running: 'running', waiting: 'waiting', done: 'done', danger: 'danger' };
  for (const [k, v] of Object.entries(vars)) root.setProperty(`--${v}`, settings[k]);
  root.setProperty('--idle', settings.muted);
  root.setProperty('--cut', `${settings.cut}px`);
  root.setProperty('--sidebar-w', `${settings.sidebarW}px`);
  root.setProperty('--mono', `"${settings.mono}", Consolas, monospace`);
  root.fontSize = `${settings.fontSize}px`;
  document.body.classList.toggle('no-grid', !settings.grid);
  document.body.classList.toggle('no-anim', !settings.anim);
  const brand = document.getElementById('brand-name');
  if (settings.brand) brand.textContent = settings.brand;
  else brand.replaceChildren('CLAUDE', h('b', {}, '//'), 'HUB');
  document.getElementById('user-css').textContent = settings.css;
  for (const t of [...terms.values(), ...shellTerms.values()]) {
    t.term.options.fontSize = settings.termSize;
    t.term.options.fontFamily = `"${settings.termFont}", Consolas, monospace`;
    t.term.options.theme = termTheme();
  }
  requestAnimationFrame(() => { fitSelected(); fitShell(); });
}

function setSetting(key, value) {
  settings[key] = value;
  saveSettings();
  applySettings();
}

function openSettings() {
  renderSettings();
  document.getElementById('settings').hidden = false;
  document.getElementById('settings-backdrop').hidden = false;
}

function closeSettings() {
  document.getElementById('settings').hidden = true;
  document.getElementById('settings-backdrop').hidden = true;
}

function renderSettings() {
  const group = (title, ...rows) => h('div', { class: 'set-group' }, h('h4', {}, title), rows);
  const range = (key, label, min, max, unit = 'px') => {
    const val = h('span', { class: 'val' }, `${settings[key]}${unit}`);
    return h('div', { class: 'set-row' }, h('label', {}, label),
      h('input', { type: 'range', min, max, value: settings[key], oninput: e => { val.textContent = `${e.target.value}${unit}`; setSetting(key, Number(e.target.value)); } }), val);
  };
  const toggle = (key, label) => h('div', { class: 'set-row' }, h('label', {}, label),
    h('input', { type: 'checkbox', checked: settings[key], onchange: e => setSetting(key, e.target.checked) }));
  const select = (key, label, options) => h('div', { class: 'set-row' }, h('label', {}, label),
    h('select', { onchange: e => setSetting(key, e.target.value) },
      (options.includes(settings[key]) ? options : [settings[key], ...options]).map(o => h('option', { value: o, selected: o === settings[key] }, o))));
  const color = (key, label) => {
    const hex = h('input', { type: 'text', class: 'hex', value: settings[key], spellcheck: 'false' });
    const pick = h('input', { type: 'color', value: settings[key] });
    pick.oninput = () => { hex.value = pick.value; setSetting(key, pick.value); };
    hex.oninput = () => { if (HEX_RE.test(hex.value)) { pick.value = hex.value; setSetting(key, hex.value.toLowerCase()); } };
    return h('div', { class: 'set-row' }, h('label', {}, label), pick, hex);
  };

  const presets = h('div', { class: 'presets' }, PRESETS.map(p => h('button', {
    class: `preset${p.accent === settings.accent ? ' on' : ''}`,
    onclick: () => { const { name, ...colors } = p; Object.assign(settings, colors); saveSettings(); applySettings(); renderSettings(); },
  }, h('span', { class: 'sw', style: `background:${p.accent}` }), p.name)));

  const css = h('textarea', { class: 'set-css', spellcheck: 'false', placeholder: '/* ví dụ */\n.card { --c: 0px; }\n.sidebar { border-right-color: var(--accent); }' });
  css.value = settings.css;
  css.oninput = () => setSetting('css', css.value);

  fill(document.getElementById('settings'),
    h('div', { class: 'settings-head' }, icon('gear', 'ico-lg'), 'Cài đặt', h('span', { class: 'spacer' }),
      h('button', { class: 'btn small ghost', title: 'Đóng (Esc)', onclick: closeSettings }, icon('close'))),
    h('div', { class: 'settings-body' },
      group('Bộ màu có sẵn', presets),
      group('Màu sắc', COLOR_FIELDS.map(([k, label]) => color(k, label))),
      group('Hình khối', range('cut', 'Độ vát góc', 0, 20), toggle('grid', 'Lưới nền'), range('sidebarW', 'Độ rộng sidebar', 240, 560)),
      group('Chữ', range('fontSize', 'Cỡ chữ giao diện', 12, 18), select('mono', 'Font monospace', MONO_FONTS),
        range('termSize', 'Cỡ chữ terminal', 10, 22), select('termFont', 'Font terminal', MONO_FONTS)),
      group('Terminal popup',
        h('div', { class: 'set-row' }, h('label', {}, 'Shell mặc định'),
          h('select', { onchange: e => { setSetting('shell', e.target.value); pop.kind = null; renderShellPop(); } },
            (state.shellKinds.length ? state.shellKinds : [{ id: 'powershell', label: 'PowerShell' }])
              .map(k => h('option', { value: k.id, selected: k.id === settings.shell }, k.label)))),
        h('p', { class: 'set-hint' }, 'Dùng cho nút Terminal. Trong popup vẫn chọn được shell khác cho từng tab mới.')),
      group('Hành vi', toggle('sound', 'Âm thanh khi phiên xong / chờ bạn'), toggle('anim', 'Hiệu ứng nhấp nháy'),
        h('div', { class: 'set-row' }, h('label', {}, 'Tên hiển thị'),
          h('input', { type: 'text', class: 'wide', value: settings.brand, placeholder: 'CLAUDE//HUB', oninput: e => setSetting('brand', e.target.value) }))),
      group('CSS tùy chỉnh', css, h('p', { class: 'set-hint' }, 'Áp dụng ngay sau mỗi lần gõ. Dùng các biến như var(--accent), var(--bg), var(--cut) để đồng bộ với bộ màu.'))),
    h('div', { class: 'settings-foot' },
      h('button', { class: 'btn small', title: 'Sao chép cấu hình dạng JSON', onclick: exportSettings }, icon('download'), 'Xuất'),
      h('button', { class: 'btn small', title: 'Dán cấu hình JSON', onclick: importSettings }, icon('upload'), 'Nhập'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn small danger', onclick: () => { if (confirm('Khôi phục toàn bộ cài đặt mặc định?')) { settings = { ...DEFAULTS }; saveSettings(); applySettings(); renderSettings(); } } }, icon('resume'), 'Mặc định')));
}

async function exportSettings() {
  const json = JSON.stringify(settings, null, 2);
  try {
    await navigator.clipboard.writeText(json);
    alert('Đã sao chép cấu hình vào clipboard.');
  } catch {
    prompt('Sao chép cấu hình bên dưới:', JSON.stringify(settings));
  }
}

function importSettings() {
  const text = prompt('Dán cấu hình JSON:');
  if (!text) return;
  try {
    settings = sanitizeSettings(JSON.parse(text));
  } catch {
    alert('JSON không hợp lệ.');
    return;
  }
  saveSettings();
  applySettings();
  renderSettings();
}

// ---------- helpers ----------
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

// icon from the <symbol> sprite in index.html
function icon(name, cls = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `ico ${cls}`.trim());
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

// replaceChildren that skips null/false like h() does
function fill(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter(c => c != null && c !== false));
}

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json', 'x-hub-token': window.HUB_TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    alert(data.error || `Lỗi ${res.status}`);
    throw new Error(data.error);
  }
  return data;
}

const norm = p => (p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
const basename = p => (p || '').split(/[\\/]/).filter(Boolean).pop() || p;

function sessionsIn(path) {
  return state.sessions.filter(s => norm(s.cwd) === norm(path));
}

function findWorktree(path) {
  for (const p of state.projects) {
    for (const wt of p.worktrees) if (norm(wt.path) === norm(path)) return { project: p, wt };
  }
  return null;
}

function branchLabel(wt) {
  return wt.branch || (wt.detached ? `(detached ${String(wt.head).slice(0, 7)})` : basename(wt.path));
}

function wtLabel(wt) {
  return wt.alias || branchLabel(wt);
}

function projectLabel(p) {
  return p.alias || p.name;
}

const parentName = p => basename((p || '').replace(/[\\/][^\\/]+[\\/]?$/, ''));

// Extra text that tells apart two folders with the same name (e.g. two clones of one repo).
function projectHint(p) {
  if (p.alias) return p.name;
  const twins = state.projects.filter(x => !x.alias && x.name.toLowerCase() === p.name.toLowerCase());
  return twins.length > 1 ? `…\\${parentName(p.path)}` : '';
}

function wtHint(wt) {
  if (wt.main) return '';
  const folder = basename(wt.path);
  return folder.toLowerCase() !== wtLabel(wt).toLowerCase() ? folder : '';
}

function sessionLabel(s, i) {
  return s.name || s.title || `Phiên ${i + 1}`;
}

async function renameFolder(path, current, kind) {
  const name = prompt(`Tên hiển thị cho ${kind} (để trống để dùng tên gốc):\n${path}`, current || '');
  if (name === null) return;
  await api('POST', '/api/alias', { path, name });
}

async function renameSession(s) {
  const name = prompt('Tên cho phiên này (để trống để dùng yêu cầu đầu tiên):', s.name || '');
  if (name === null) return;
  await api('POST', `/api/sessions/${s.id}/name`, { name });
}

function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return 'vừa xong';
  if (m < 60) return `${m} phút trước`;
  const hrs = Math.round(m / 60);
  if (hrs < 24) return `${hrs} giờ trước`;
  const d = Math.round(hrs / 24);
  if (d < 30) return `${d} ngày trước`;
  return new Date(ts).toLocaleDateString('vi-VN');
}

function dot(s) {
  return h('span', { class: `dot ${s.status}${s.unread ? ' unread' : ''}` });
}

// ---------- websocket ----------
function connect() {
  ws = new WebSocket(`ws://${location.host}/ws?token=${window.HUB_TOKEN}`);
  const conn = document.getElementById('conn');
  ws.onopen = () => { conn.textContent = ''; conn.classList.remove('off'); };
  ws.onclose = () => {
    conn.textContent = 'mất kết nối với hub — đang thử lại…';
    conn.classList.add('off');
    setTimeout(connect, 2000);
  };
  ws.onmessage = ev => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'projects') {
      state.projects = msg.projects;
      render();
    } else if (msg.type === 'sessions') {
      state.sessions = msg.sessions;
      for (const s of msg.sessions) ensureTerm(s.id);
      for (const id of terms.keys()) if (!msg.sessions.some(s => s.id === id)) disposeTerm(id);
      if (state.selected?.kind === 'session' && !msg.sessions.some(s => s.id === state.selected.id)) state.selected = null;
      render();
    } else if (msg.type === 'replay') {
      const t = ensureTerm(msg.id);
      t.term.reset();
      t.term.write(msg.data);
    } else if (msg.type === 'output') {
      ensureTerm(msg.id).term.write(msg.data);
    } else if (msg.type === 'notify') {
      notify(msg.session);
    } else if (msg.type === 'shells') {
      state.shells = msg.shells;
      state.shellKinds = msg.kinds || [];
      for (const s of msg.shells) ensureShellTerm(s.id);
      for (const id of shellTerms.keys()) if (!msg.shells.some(s => s.id === id)) disposeShellTerm(id);
      if (!msg.shells.some(s => s.id === pop.active)) pop.active = msg.shells.at(-1)?.id || null;
      if (!msg.shells.length) pop.open = false;
      renderShellPop();
    } else if (msg.type === 'shell-replay') {
      const t = ensureShellTerm(msg.id);
      t.term.reset();
      t.term.write(msg.data);
    } else if (msg.type === 'shell-output') {
      ensureShellTerm(msg.id).term.write(msg.data);
    }
  };
}

function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

// ---------- terminals ----------
function ensureTerm(id) {
  let t = terms.get(id);
  if (t) return t;
  const el = h('div', { class: 'term', hidden: true });
  document.getElementById('terminals').append(el);
  const term = new Terminal({
    fontFamily: `"${settings.termFont}", Consolas, monospace`,
    fontSize: settings.termSize,
    cursorBlink: true,
    scrollback: 10000,
    theme: termTheme(),
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  term.onData(data => send({ type: 'input', id, data }));
  t = { term, fit, el };
  terms.set(id, t);
  return t;
}

function disposeTerm(id) {
  const t = terms.get(id);
  if (!t) return;
  t.term.dispose();
  t.el.remove();
  terms.delete(id);
}

function fitSelected() {
  if (state.selected?.kind !== 'session') return;
  const t = terms.get(state.selected.id);
  if (!t || t.el.hidden) return;
  t.fit.fit();
  // output written while the pane was hidden is in the buffer but not painted yet
  t.term.refresh(0, t.term.rows - 1);
  send({ type: 'resize', id: state.selected.id, cols: t.term.cols, rows: t.term.rows });
}
window.addEventListener('resize', fitSelected);

// ---------- popup terminal (plain shell, not Claude) ----------
const shellTerms = new Map(); // shell id -> { term, fit, el }
const pop = { open: false, active: null, max: false, cwd: null, kind: null }; // kind: last pick in the popup dropdown

function ensureShellTerm(id) {
  let t = shellTerms.get(id);
  if (t) return t;
  const el = h('div', { class: 'term', hidden: true });
  document.getElementById('term-pop-body').append(el);
  const term = new Terminal({
    fontFamily: `"${settings.termFont}", Consolas, monospace`,
    fontSize: settings.termSize,
    cursorBlink: true,
    scrollback: 5000,
    theme: termTheme(),
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  term.onData(data => send({ type: 'input', id, data }));
  t = { term, fit, el };
  shellTerms.set(id, t);
  return t;
}

function disposeShellTerm(id) {
  const t = shellTerms.get(id);
  if (!t) return;
  t.term.dispose();
  t.el.remove();
  shellTerms.delete(id);
}

function fitShell() {
  if (!pop.open || !pop.active) return;
  const t = shellTerms.get(pop.active);
  if (!t || t.el.hidden) return;
  t.fit.fit();
  t.term.refresh(0, t.term.rows - 1);
  send({ type: 'resize', id: pop.active, cols: t.term.cols, rows: t.term.rows });
}

async function openShell(cwd, kind = settings.shell) {
  const s = await api('POST', '/api/shells', { cwd, kind });
  ensureShellTerm(s.id);
  if (!state.shells.some(x => x.id === s.id)) state.shells.push(s);
  pop.open = true;
  pop.active = s.id;
  pop.cwd = cwd;
  renderShellPop();
  requestAnimationFrame(() => { fitShell(); shellTerms.get(s.id)?.term.focus(); });
}

function focusShell(id) {
  pop.active = id;
  pop.cwd = state.shells.find(s => s.id === id)?.cwd || pop.cwd;
  renderShellPop();
  requestAnimationFrame(() => { fitShell(); shellTerms.get(id)?.term.focus(); });
}

function shellTabLabel(s) {
  const found = findWorktree(s.cwd);
  return `${found ? projectLabel(found.project) : basename(s.cwd)} · ${s.label}`;
}

function renderShellPop() {
  const box = document.getElementById('term-pop');
  box.hidden = !pop.open;
  box.classList.toggle('max', pop.max);
  const dock = document.getElementById('term-dock');
  dock.hidden = pop.open || !state.shells.length;
  document.getElementById('term-dock-label').textContent = `Terminal (${state.shells.length})`;

  fill(document.getElementById('term-tabs'), state.shells.map(s => h('div', {
    class: `term-tab${s.id === pop.active ? ' on' : ''}${s.status === 'exited' ? ' exited' : ''}`,
    title: s.cwd, onclick: () => focusShell(s.id),
  }, h('span', { class: 'tl' }, shellTabLabel(s)), s.status === 'exited' ? h('span', { class: 'sub' }, 'đã thoát') : null,
  h('button', { class: 'x', title: 'Đóng tab (tắt shell)', onclick: e => { e.stopPropagation(); api('DELETE', `/api/shells/${s.id}`); } }, icon('close')))));

  const kindSel = document.getElementById('term-kind');
  const kind = pop.kind || settings.shell;
  fill(kindSel, state.shellKinds.map(k => h('option', { value: k.id, selected: k.id === kind }, k.label)));
  for (const [id, t] of shellTerms) t.el.hidden = id !== pop.active;
}

{
  const box = document.getElementById('term-pop');
  document.getElementById('term-new').onclick = () => {
    const cwd = pop.cwd || state.shells.find(s => s.id === pop.active)?.cwd;
    if (cwd) openShell(cwd, document.getElementById('term-kind').value);
  };
  document.getElementById('term-kind').onchange = e => { pop.kind = e.target.value; };
  document.getElementById('term-min').onclick = () => { pop.open = false; renderShellPop(); };
  document.getElementById('term-max').onclick = () => { pop.max = !pop.max; renderShellPop(); requestAnimationFrame(fitShell); };
  document.getElementById('term-dock').onclick = () => { pop.open = true; renderShellPop(); requestAnimationFrame(() => { fitShell(); shellTerms.get(pop.active)?.term.focus(); }); };

  // drag by the header
  document.getElementById('term-pop-head').addEventListener('mousedown', e => {
    if (pop.max || e.target.closest('button, select, .term-tab')) return;
    const r = box.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = ev => {
      box.style.left = `${Math.max(0, Math.min(window.innerWidth - 120, ev.clientX - dx))}px`;
      box.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, ev.clientY - dy))}px`;
      box.style.right = 'auto';
      box.style.bottom = 'auto';
    };
    const up = () => { window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    e.preventDefault();
  });
  // the box is resizable with CSS; refit the terminal whenever its size changes
  new ResizeObserver(() => requestAnimationFrame(fitShell)).observe(box);
}

// ---------- notifications ----------
let audio;
function beep(status) {
  if (!settings.sound) return;
  try {
    audio ??= new AudioContext();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = status === 'waiting' ? 880 : 660;
    g.gain.setValueAtTime(0.15, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.4);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.4);
  } catch { /* audio blocked until first click */ }
}

function notify(s) {
  const viewing = document.hasFocus() && state.selected?.kind === 'session' && state.selected.id === s.id;
  if (viewing) {
    api('POST', `/api/sessions/${s.id}/read`);
    return;
  }
  beep(s.status);
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const found = findWorktree(s.cwd);
  const where = found ? `${projectLabel(found.project)} › ${wtLabel(found.wt)}` : basename(s.cwd);
  const title = s.status === 'waiting' ? `⏳ Claude cần bạn — ${where}` : `✅ Claude đã xong — ${where}`;
  const n = new Notification(title, { body: s.lastMessage || s.title || '', tag: s.id, requireInteraction: s.status === 'waiting' });
  n.onclick = () => {
    window.focus();
    selectSession(s.id);
    n.close();
  };
}

function setupNotifyButton() {
  const btn = document.getElementById('enable-notify');
  if (!('Notification' in window) || Notification.permission !== 'default') return;
  btn.hidden = false;
  btn.onclick = async () => {
    await Notification.requestPermission();
    btn.hidden = Notification.permission !== 'default';
  };
}

// ---------- actions ----------
function selectSession(id) {
  state.selected = { kind: 'session', id };
  const s = state.sessions.find(x => x.id === id);
  if (s?.unread) api('POST', `/api/sessions/${id}/read`);
  render();
  requestAnimationFrame(() => {
    fitSelected();
    terms.get(id)?.term.focus();
  });
}

function selectWorktree(path) {
  state.selected = { kind: 'worktree', path };
  render();
  loadHistory(path);
}

async function loadHistory(path) {
  const prev = state.history.get(norm(path));
  state.history.set(norm(path), { ...prev, loading: true, error: null });
  render();
  try {
    const { sessions } = await api('GET', `/api/history?cwd=${encodeURIComponent(path)}`);
    state.history.set(norm(path), { ...state.history.get(norm(path)), loading: false, items: sessions });
  } catch (err) {
    state.history.set(norm(path), { ...state.history.get(norm(path)), loading: false, error: err.message });
  }
  render();
}

async function startSession(cwd, opts = {}) {
  const s = await api('POST', '/api/sessions', { cwd, continue: !!opts.continue, resume: opts.resume });
  ensureTerm(s.id);
  if (!state.sessions.some(x => x.id === s.id)) state.sessions.push(s);
  selectSession(s.id);
}

async function addProject() {
  const path = prompt('Đường dẫn repo, hoặc thư mục chứa nhiều repo (ví dụ D:\\CPLUS):');
  if (!path) return;
  const { added } = await api('POST', '/api/projects', { path: path.trim().replace(/^"|"$/g, '') });
  alert(`Đã thêm ${added.length} dự án:\n${added.join('\n')}`);
}

async function removeProject(p) {
  if (!confirm(`Gỡ "${projectLabel(p)}" khỏi dashboard? (Không xóa file nào trên ổ đĩa)`)) return;
  await api('DELETE', '/api/projects', { path: p.path });
}

async function addWorktree(p) {
  const branch = prompt(`Tên nhánh cho worktree mới trong ${projectLabel(p)} (nhánh chưa có sẽ được tạo từ HEAD):`);
  if (!branch) return;
  const { path } = await api('POST', '/api/worktrees', { repo: p.path, branch: branch.trim() });
  if (confirm(`Đã tạo worktree tại:\n${path}\n\nMở phiên Claude ở đó luôn?`)) await startSession(path);
}

async function showDiff(cwd, file) {
  const { diff } = await api('GET', `/api/diff?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(file)}`);
  document.getElementById('diff-title').textContent = file;
  const body = document.getElementById('diff-body');
  body.replaceChildren(...(diff || '(không có thay đổi)').split('\n').map(line => {
    let cls = '';
    if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) cls = 'meta';
    else if (line.startsWith('+')) cls = 'add';
    else if (line.startsWith('-')) cls = 'del';
    else if (line.startsWith('@@')) cls = 'hunk';
    return h('span', { class: cls }, line);
  }));
  document.getElementById('diff-modal').hidden = false;
}

function fileList(cwd, changes) {
  if (!changes?.length) return h('p', { class: 'hint' }, 'Không có file nào thay đổi.');
  return h('ul', { class: 'file-list' }, changes.map(c =>
    h('li', { onclick: () => showDiff(cwd, c.file), title: 'Xem diff' }, h('span', { class: `code ${c.code}` }, c.code), c.file)));
}

// ---------- rendering ----------
function renderCounts() {
  const count = st => state.sessions.filter(s => s.status === st).length;
  const chips = [];
  for (const st of ['running', 'waiting', 'done']) {
    const n = count(st);
    if (n) chips.push(h('span', { class: 'chip' }, h('span', { class: `dot ${st}` }), `${n} ${STATUS[st]}`));
  }
  document.getElementById('counts').replaceChildren(...chips);
  const unread = state.sessions.filter(s => s.unread).length;
  document.title = unread ? `(${unread}) Claude Hub` : 'Claude Hub';
}

function sessionRow(s, label, sel) {
  return h('div', {
    class: `row session${sel?.kind === 'session' && sel.id === s.id ? ' selected' : ''}`,
    onclick: () => selectSession(s.id),
    title: s.cwd,
  }, dot(s), h('span', { class: 'label' }, label),
  h('span', { class: `sub status-text ${s.status}` }, STATUS[s.status]),
  h('button', { class: 'btn small start', title: 'Đặt tên phiên', onclick: e => { e.stopPropagation(); renameSession(s); } }, icon('edit')));
}

function renderTree() {
  const tree = document.getElementById('tree');
  const sel = state.selected;
  const nodes = [];
  const placed = new Set();

  if (!state.projects.length) {
    nodes.push(h('div', { class: 'empty' }, 'Chưa có dự án nào.', h('br'), 'Bấm “+ Thêm dự án” và nhập đường dẫn repo, hoặc thư mục chứa nhiều repo.'));
  }

  for (const p of state.projects) {
    const wts = p.worktrees.map(wt => {
      const list = sessionsIn(wt.path);
      list.forEach(s => placed.add(s.id));
      const wtSelected = sel?.kind === 'worktree' && norm(sel.path) === norm(wt.path);
      return [
        h('div', { class: `row${wtSelected ? ' selected' : ''}`, onclick: () => selectWorktree(wt.path), title: wt.path },
          icon('branch'),
          h('span', { class: 'label' }, wtLabel(wt), wt.alias ? h('span', { class: 'label-sub' }, branchLabel(wt)) : null),
          wtHint(wt) ? h('span', { class: 'folder-hint', title: wt.path }, icon('folder'), wtHint(wt)) : null,
          wt.main ? null : h('span', { class: 'badge' }, 'wt'),
          wt.changes?.length ? h('span', { class: 'badge changes', title: 'Số file đã sửa' }, icon('edit'), wt.changes.length) : null,
          wt.main ? null : h('button', { class: 'btn small start', title: 'Đặt tên cho thư mục này', onclick: e => { e.stopPropagation(); renameFolder(wt.path, wt.alias, 'thư mục'); } }, icon('edit')),
          h('button', { class: 'btn small start', title: 'Mở phiên Claude mới', onclick: e => { e.stopPropagation(); startSession(wt.path); } }, icon('play'))),
        list.map((s, i) => sessionRow(s, sessionLabel(s, i), sel)),
      ];
    });
    nodes.push(h('div', { class: 'project' },
      h('div', { class: 'project-head', title: p.path },
        icon('repo'),
        h('span', { class: 'name' }, projectLabel(p), projectHint(p) ? h('span', { class: 'name-hint' }, projectHint(p)) : null),
        h('span', { class: 'tools' },
          h('button', { class: 'btn small', title: 'Đặt tên hiển thị cho dự án', onclick: () => renameFolder(p.path, p.alias, 'dự án') }, icon('edit')),
          h('button', { class: 'btn small', title: 'Tạo worktree / nhánh mới', onclick: () => addWorktree(p) }, icon('plus'), 'nhánh'),
          h('button', { class: 'btn small danger', title: 'Gỡ khỏi dashboard', onclick: () => removeProject(p) }, icon('close')))),
      p.error ? h('div', { class: 'project-error' }, p.error) : null,
      wts));
  }

  const others = state.sessions.filter(s => !placed.has(s.id));
  if (others.length) {
    nodes.push(h('div', { class: 'group-title' }, icon('terminal'), 'Phiên khác'));
    nodes.push(others.map((s, i) => sessionRow(s, `${basename(s.cwd)} · ${sessionLabel(s, i)}`, sel)));
  }
  tree.replaceChildren(...nodes.flat(Infinity));
}

function renderOverview() {
  const order = { waiting: 0, done: 1, running: 2, idle: 3, exited: 4 };
  const list = [...state.sessions].sort((a, b) => (b.unread - a.unread) || (order[a.status] - order[b.status]) || (b.updatedAt - a.updatedAt));
  const cards = list.map(s => {
    const found = findWorktree(s.cwd);
    return h('button', { class: `card ${s.status}`, onclick: () => selectSession(s.id) },
      h('div', { class: 'top' }, dot(s), h('span', { class: `status-text ${s.status}` }, STATUS[s.status]), s.unread ? h('span', { class: 'badge changes' }, 'mới') : null),
      h('div', { class: 'where' }, icon(found ? 'branch' : 'folder'), found ? `${projectLabel(found.project)} › ${wtLabel(found.wt)}` : s.cwd),
      h('div', { class: 'title' }, s.name ? h('strong', {}, s.name) : null, s.name && s.title ? ' — ' : null, s.title || (s.name ? null : '(chưa có yêu cầu)')),
      s.status === 'waiting' && s.lastMessage ? h('div', { class: 'msg' }, s.lastMessage) : null);
  });
  fill(document.getElementById('overview'), 
    h('h2', {}, 'Tổng quan các phiên'),
    h('p', { class: 'hint' }, state.sessions.length
      ? 'Phiên cần bạn xử lý nằm đầu tiên. Bấm vào để mở terminal của phiên đó.'
      : 'Chưa có phiên nào. Chọn một nhánh bên trái rồi bấm ▶ để mở Claude.'),
    h('div', { class: 'cards' }, cards));
}

function renderWorktreeView() {
  const found = findWorktree(state.selected.path);
  const view = document.getElementById('worktree-view');
  if (!found) {
    view.replaceChildren(h('p', { class: 'hint' }, 'Worktree không còn tồn tại.'));
    return;
  }
  const { project, wt } = found;
  const list = sessionsIn(wt.path);
  fill(view, 
    h('h2', {}, `${projectLabel(project)} › ${wtLabel(wt)}`),
    h('p', { class: 'hint' }, wt.path),
    h('div', { class: 'start-actions' },
      h('button', { class: 'btn primary', onclick: () => startSession(wt.path) }, icon('play'), 'Phiên Claude mới'),
      h('button', { class: 'btn', onclick: () => startSession(wt.path, { continue: true }) }, icon('resume'), 'Tiếp tục phiên gần nhất'),
      h('button', { class: 'btn ghost', onclick: () => api('POST', '/api/open', { cwd: wt.path, tool: 'lazygit' }) }, icon('git'), 'lazygit'),
      h('button', { class: 'btn ghost', onclick: () => api('POST', '/api/open', { cwd: wt.path, tool: 'explorer' }) }, icon('folder'), 'Thư mục'),
      h('button', { class: 'btn ghost', title: 'Mở terminal tại thư mục này', onclick: () => openShell(wt.path) }, icon('terminal'), 'Terminal'),
      wt.main
        ? h('button', { class: 'btn ghost', onclick: () => renameFolder(project.path, project.alias, 'dự án') }, icon('edit'), 'Đặt tên dự án')
        : h('button', { class: 'btn ghost', onclick: () => renameFolder(wt.path, wt.alias, 'thư mục') }, icon('edit'), 'Đặt tên thư mục')),
    list.length ? h('h3', {}, 'Phiên đang mở') : null,
    list.length ? h('div', { class: 'cards' }, list.map((s, i) => h('button', { class: `card ${s.status}`, onclick: () => selectSession(s.id) },
      h('div', { class: 'top' }, dot(s), h('span', { class: `status-text ${s.status}` }, STATUS[s.status])),
      h('div', { class: 'title' }, sessionLabel(s, i))))) : null,
    historySection(wt.path),
    h('h3', {}, `File đã sửa (${wt.changes?.length || 0})`),
    fileList(wt.path, wt.changes));
}

function historySection(path) {
  const hist = state.history.get(norm(path)) || {};
  const items = hist.items || [];
  const q = (hist.filter || '').toLowerCase();
  const shown = q ? items.filter(s => `${s.title} ${s.firstPrompt} ${s.lastPrompt} ${s.gitBranch}`.toLowerCase().includes(q)) : items;
  const head = h('h3', {}, `Lịch sử phiên (${items.length})`,
    h('button', { class: 'btn small ghost', title: 'Tải lại lịch sử', onclick: () => loadHistory(path) }, icon('resume'), hist.loading ? 'đang tải…' : 'làm mới'));

  let body;
  if (hist.error) body = h('p', { class: 'hint' }, `Không đọc được lịch sử: ${hist.error}`);
  else if (!hist.items) body = h('p', { class: 'hint' }, 'Đang tải lịch sử…');
  else if (!items.length) body = h('p', { class: 'hint' }, 'Chưa có phiên Claude nào được lưu cho thư mục này.');
  else {
    body = h('div', { class: 'cards history-cards' }, shown.map(s => h('div', { class: 'card history', title: s.firstPrompt },
      h('div', { class: 'top' }, icon('session'), h('span', { class: 'htitle' }, s.title || s.firstPrompt)),
      h('div', { class: 'where' },
        s.gitBranch ? [icon('branch'), h('span', {}, s.gitBranch), h('span', { class: 'sep' }, '·')] : null,
        h('span', {}, ago(s.updatedAt)), h('span', { class: 'sep' }, '·'), h('span', {}, `${s.prompts} yêu cầu`)),
      s.lastPrompt && s.lastPrompt !== s.title ? h('div', { class: 'title last' }, h('span', { class: 'k' }, 'Cuối:'), ' ', s.lastPrompt) : null,
      h('div', { class: 'foot' },
        h('code', { class: 'sid' }, s.id.slice(0, 8)),
        h('button', { class: 'btn small primary', onclick: () => startSession(path, { resume: s.id }) }, icon('play'), 'Mở lại')))));
  }

  const filter = items.length > 6 ? h('input', {
    class: 'history-filter', type: 'search', placeholder: 'Lọc theo tiêu đề, yêu cầu, nhánh…', value: hist.filter || '',
    oninput: e => {
      state.history.set(norm(path), { ...hist, filter: e.target.value });
      const pos = e.target.selectionStart;
      render();
      const el = document.querySelector('.history-filter');
      el?.focus();
      el?.setSelectionRange(pos, pos);
    },
  }) : null;
  return [head, filter, body];
}

// ---------- MCP per session ----------
// tool names use the server name with anything outside [\w-] turned into '_'
const mcpKey = name => name.replace(/[^\w-]/g, '_');

const mcpLoading = new Set();
async function loadMcp(cwd) {
  if (mcpLoading.has(norm(cwd))) return;
  mcpLoading.add(norm(cwd));
  try {
    const { servers } = await api('GET', `/api/mcp?cwd=${encodeURIComponent(cwd)}`);
    state.mcpAvail.set(norm(cwd), servers);
  } finally {
    mcpLoading.delete(norm(cwd));
  }
  render();
}

async function checkMcpHealth(cwd) {
  state.mcpHealth.set(norm(cwd), { ...state.mcpHealth.get(norm(cwd)), loading: true });
  render();
  try {
    const { health } = await api('GET', `/api/mcp/health?cwd=${encodeURIComponent(cwd)}`);
    state.mcpHealth.set(norm(cwd), { loading: false, result: health, at: Date.now() });
  } catch {
    state.mcpHealth.set(norm(cwd), { ...state.mcpHealth.get(norm(cwd)), loading: false });
  }
  render();
}

// names currently in effect: the explicit list, or every configured server when the session uses defaults
function activeMcp(s, avail) {
  return s.mcp ? s.mcp : avail.map(x => x.name);
}

async function applyMcp(s, names) {
  const msg = s.claudeSessionId
    ? 'Phiên sẽ khởi động lại và mở lại đúng cuộc trò chuyện này với bộ MCP mới. Tiếp tục?'
    : 'Phiên chưa có mã hội thoại nên sẽ mở lại từ đầu với bộ MCP mới. Tiếp tục?';
  if (!confirm(msg)) return;
  await api('POST', `/api/sessions/${s.id}/restart`, { mcp: names });
  state.mcpDraft = null;
  requestAnimationFrame(fitSelected);
}

function renderMcpPanel(s) {
  const panel = document.getElementById('mcp-panel');
  const avail = state.mcpAvail.get(norm(s.cwd));
  if (!avail) {
    panel.replaceChildren(h('h3', {}, 'MCP của phiên'), h('p', { class: 'hint' }, 'Đang đọc cấu hình MCP…'));
    return;
  }
  const active = new Set(activeMcp(s, avail));
  if (state.mcpDraft?.sid !== s.id) state.mcpDraft = { sid: s.id, names: new Set(active) };
  const draft = state.mcpDraft.names;
  const dirty = draft.size !== active.size || [...draft].some(n => !active.has(n));
  const health = state.mcpHealth.get(norm(s.cwd)) || {};
  const result = health.result || {};
  const connectors = Object.entries(result).filter(([name]) => name.startsWith('claude.ai '));

  const statusOf = name => {
    const r = result[name];
    if (!r) return null;
    return h('span', { class: `mcp-health ${r.ok ? 'ok' : r.pending ? 'pending' : 'bad'}`, title: r.detail }, r.ok ? 'kết nối' : r.pending ? 'chờ duyệt' : 'lỗi');
  };

  fill(panel,
    h('h3', {}, 'MCP của phiên'),
    h('p', { class: 'mcp-mode' }, s.mcp
      ? `Chỉ dùng ${s.mcp.length} MCP đã chọn`
      : 'Mặc định: mọi MCP được cấu hình cho thư mục này'),
    avail.length ? h('ul', { class: 'mcp-list' }, avail.map(m => {
      const used = s.mcpUsed?.[mcpKey(m.name)];
      return h('li', { class: active.has(m.name) ? 'on' : '' },
        h('label', {},
          h('input', {
            type: 'checkbox', checked: draft.has(m.name),
            onchange: e => { e.target.checked ? draft.add(m.name) : draft.delete(m.name); render(); },
          }),
          h('span', { class: 'mcp-name' }, m.name),
          h('span', { class: 'badge', title: m.scope === 'user' ? 'Dùng chung mọi dự án' : m.scope === 'local' ? 'Riêng dự án này, trên máy bạn' : 'Khai báo trong .mcp.json của repo' }, m.scope),
          statusOf(m.name)),
        h('div', { class: 'mcp-meta' }, `${m.type} · ${m.target || '—'}`, used ? h('span', { class: 'mcp-used' }, ` · đã gọi ${used} lần`) : null));
    })) : h('p', { class: 'hint' }, 'Không có MCP nào được cấu hình cho thư mục này.'),
    connectors.length ? [
      h('h3', { class: 'mcp-sub' }, 'Connector claude.ai'),
      h('ul', { class: 'mcp-list' }, connectors.map(([name]) => h('li', {},
        h('label', {}, h('span', { class: 'mcp-name' }, name.replace(/^claude\.ai /, '')), statusOf(name))))),
      h('p', { class: 'set-hint' }, 'Connector bật/tắt trong cài đặt tài khoản claude.ai, hub không chọn được.'),
    ] : null,
    h('div', { class: 'mcp-actions' },
      h('button', { class: 'btn small primary', disabled: !dirty, onclick: () => applyMcp(s, [...draft]) }, icon('resume'), 'Áp dụng & khởi động lại'),
      s.mcp ? h('button', { class: 'btn small', onclick: () => applyMcp(s, null) }, 'Về mặc định') : null,
      h('button', { class: 'btn small ghost', disabled: health.loading, onclick: () => checkMcpHealth(s.cwd) }, icon('pulse'), health.loading ? 'đang kiểm tra…' : 'Kiểm tra kết nối')),
    h('p', { class: 'set-hint' }, health.at
      ? `Kết quả kiểm tra lúc ${new Date(health.at).toLocaleTimeString('vi-VN')}. Đổi MCP sẽ khởi động lại phiên vì Claude Code chỉ nạp MCP lúc mở phiên.`
      : 'Đổi MCP sẽ khởi động lại phiên vì Claude Code chỉ nạp MCP lúc mở phiên. “Kiểm tra kết nối” chạy thử từng MCP, mất vài giây.'));
}

function renderSessionView() {
  const s = state.sessions.find(x => x.id === state.selected.id);
  if (!s) return;
  const found = findWorktree(s.cwd);
  fill(document.getElementById('session-crumbs'), 
    dot(s),
    h('span', { class: `status-text ${s.status}` }, STATUS[s.status]),
    h('span', { class: 'sep' }, '·'),
    h('strong', {}, found ? projectLabel(found.project) : basename(s.cwd)),
    found ? h('span', { class: 'sep' }, '›') : null,
    found ? h('span', {}, wtLabel(found.wt)) : null,
    s.title ? h('span', { class: 'sep' }, '—') : null,
    s.title ? h('span', { class: 'sub', title: s.title }, s.title) : null);

  for (const [id, t] of terms) t.el.hidden = id !== s.id;

  const files = document.getElementById('files');
  files.hidden = !state.filesOpen;
  if (state.filesOpen) {
    const changes = found?.wt.changes || [];
    files.replaceChildren(h('h3', {}, `File đã sửa (${changes.length})`), fileList(s.cwd, changes));
  }
  document.querySelector('[data-act="files"] .files-label').textContent = `File đã sửa (${found?.wt.changes?.length || 0})`;

  const mcpPanel = document.getElementById('mcp-panel');
  mcpPanel.hidden = !state.mcpOpen;
  if (state.mcpOpen) renderMcpPanel(s);
  const avail = state.mcpAvail.get(norm(s.cwd));
  document.querySelector('[data-act="mcp"] .mcp-label').textContent = avail ? `MCP (${activeMcp(s, avail).length})` : 'MCP';
  if (!avail) loadMcp(s.cwd).catch(() => {});
  document.querySelector('[data-act="kill"]').hidden = s.status === 'exited';
}

function render() {
  renderCounts();
  renderTree();
  const kind = state.selected?.kind;
  document.getElementById('overview').hidden = !!kind;
  document.getElementById('worktree-view').hidden = kind !== 'worktree';
  document.getElementById('session-view').hidden = kind !== 'session';
  if (!kind) renderOverview();
  else if (kind === 'worktree') renderWorktreeView();
  else renderSessionView();
}

// ---------- wiring ----------
document.getElementById('home').onclick = () => { state.selected = null; render(); };
document.getElementById('add-project').onclick = addProject;
document.getElementById('diff-close').onclick = () => { document.getElementById('diff-modal').hidden = true; };
document.getElementById('diff-modal').onclick = e => { if (e.target.id === 'diff-modal') e.target.hidden = true; };
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  document.getElementById('diff-modal').hidden = true;
  closeSettings();
});
document.getElementById('open-settings').onclick = openSettings;
document.getElementById('settings-backdrop').onclick = closeSettings;

document.querySelector('.session-head .actions').onclick = async e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  const id = state.selected?.id;
  const s = state.sessions.find(x => x.id === id);
  if (!act || !s) return;
  if (act === 'files') {
    state.filesOpen = !state.filesOpen;
    render();
    requestAnimationFrame(fitSelected);
  } else if (act === 'shell') {
    await openShell(s.cwd);
  } else if (act === 'rename') {
    await renameSession(s);
  } else if (act === 'mcp') {
    state.mcpOpen = !state.mcpOpen;
    state.mcpDraft = null;
    if (state.mcpOpen) loadMcp(s.cwd).catch(() => {}); // re-read: config may have changed since last time
    render();
    requestAnimationFrame(fitSelected);
  } else if (act === 'lazygit' || act === 'explorer') {
    await api('POST', '/api/open', { cwd: s.cwd, tool: act });
  } else if (act === 'kill') {
    if (confirm('Dừng phiên Claude này?')) await api('POST', `/api/sessions/${id}/kill`);
  } else if (act === 'remove') {
    if (s.status === 'exited' || confirm('Phiên vẫn đang chạy. Dừng và đóng nó?')) {
      await api('DELETE', `/api/sessions/${id}`);
      state.selected = null;
      render();
    }
  }
};

window.addEventListener('focus', () => {
  if (state.selected?.kind === 'session') {
    const s = state.sessions.find(x => x.id === state.selected.id);
    if (s?.unread) api('POST', `/api/sessions/${s.id}/read`);
  }
});

applySettings();
setupNotifyButton();
connect();
render();
