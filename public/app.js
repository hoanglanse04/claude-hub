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
  skillsOpen: false,
  skillAvail: new Map(), // cwd -> { plugins: [{ id, name, version, scope, enabled, skills }], skills: [{ name, description, tokens, scope }] }
  skillDraft: null, // { sid, plugins: { id: bool }, off: Set } – unsaved checkbox state
  skillExpanded: new Set(), // plugin ids whose skill list is unfolded
  shells: [],
  shellKinds: [],
  workspaces: [], // parent folders that hold several repos: [{ path, name, alias, missing }]
  gitlog: new Map(), // worktree path -> { all, limit, filter, loading, error, data: { commits, width, more } }
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
  claudeTui: 'default', scrollback: 'max',
};
// xterm needs a number; "max" is effectively no limit (RAM grows only with lines actually printed)
const SCROLLBACK = { 10000: 10000, 100000: 100000, max: 1000000 };
const scrollbackLines = () => SCROLLBACK[settings.scrollback] || SCROLLBACK.max;
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
  // only Claude panes follow the setting; changing it re-allocates the buffer, so skip when unchanged
  for (const t of terms.values()) if (t.term.options.scrollback !== scrollbackLines()) t.term.options.scrollback = scrollbackLines();
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
      group('Phiên Claude',
        h('div', { class: 'set-row' }, h('label', {}, 'Giao diện Claude'),
          h('select', { onchange: e => setSetting('claudeTui', e.target.value) },
            [['default', 'Cổ điển: kéo lên xem toàn bộ'], ['fullscreen', 'Fullscreen: Claude tự cuộn']]
              .map(([v, label]) => h('option', { value: v, selected: v === settings.claudeTui }, label)))),
        h('div', { class: 'set-row' }, h('label', {}, 'Bộ nhớ cuộn'),
          h('select', { onchange: e => { setSetting('scrollback', e.target.value); applySettings(); } },
            [['10000', '10.000 dòng'], ['100000', '100.000 dòng'], ['max', 'Không giới hạn (1 triệu dòng)']]
              .map(([v, label]) => h('option', { value: v, selected: v === settings.scrollback }, label)))),
        h('p', { class: 'set-hint' }, 'Giao diện chỉ áp dụng cho phiên mở từ hub, từ lần mở hoặc khởi động lại sau; Claude ở VS Code/CLI giữ nguyên. ',
          'Ở chế độ Fullscreen, Claude chỉ vẽ một đoạn gần nhất; bấm Ctrl+O trong phiên để xem toàn bộ. ',
          'Bộ nhớ cuộn chỉ tốn RAM theo số dòng thật sự in ra, khoảng 1,5 KB mỗi dòng (10.000 dòng ≈ 15 MB).')),
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

function wsLabel(w) {
  return w.alias || w.name;
}

function findWorkspace(path) {
  return state.workspaces.find(w => norm(w.path) === norm(path)) || null;
}

const isInside = (child, dir) => norm(child) === norm(dir) || norm(child).startsWith(`${norm(dir)}\\`);

// "dự án › nhánh" for a worktree, "Workspace X" for a parent folder, else the folder name
function placeLabel(cwd) {
  const found = findWorktree(cwd);
  if (found) return `${projectLabel(found.project)} › ${wtLabel(found.wt)}`;
  const w = findWorkspace(cwd);
  return w ? `Workspace ${wsLabel(w)}` : basename(cwd);
}

function selectWorkspace(path) {
  closeEditor();
  state.selected = { kind: 'workspace', path };
  render();
  loadHistory(path);
}

async function removeWorkspace(w) {
  if (!confirm(`Gỡ workspace "${wsLabel(w)}" khỏi dashboard? Các dự án con vẫn giữ nguyên, không xóa file nào.`)) return;
  await api('DELETE', '/api/workspaces', { path: w.path });
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
      state.workspaces = msg.workspaces || [];
      if (state.selected?.kind === 'workspace' && !findWorkspace(state.selected.path)) state.selected = null;
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
// Windows Terminal style clipboard keys. Ctrl+C copies only while text is selected, otherwise it still
// reaches the program (interrupt). Returning false for the paste keys skips xterm's own handling
// (it would send ^V) and lets the browser fire a normal paste event, which xterm turns into input.
function clipboardKeys(term) {
  term.attachCustomKeyEventHandler(e => {
    if (e.type !== 'keydown' || e.altKey) return true;
    const key = e.key.toLowerCase();
    const copy = (e.ctrlKey && key === 'c' && (e.shiftKey || term.hasSelection())) || (e.ctrlKey && !e.shiftKey && key === 'insert');
    if (copy) {
      if (term.hasSelection()) navigator.clipboard.writeText(term.getSelection()).catch(() => {});
      term.clearSelection();
      e.preventDefault();
      return false;
    }
    if ((e.ctrlKey && key === 'v') || (e.shiftKey && !e.ctrlKey && key === 'insert')) return false;
    return true;
  });
}

function ensureTerm(id) {
  let t = terms.get(id);
  if (t) return t;
  const el = h('div', { class: 'term', hidden: true });
  document.getElementById('terminals').append(el);
  const term = new Terminal({
    fontFamily: `"${settings.termFont}", Consolas, monospace`,
    fontSize: settings.termSize,
    cursorBlink: true,
    scrollback: scrollbackLines(),
    theme: termTheme(),
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.open(el);
  clipboardKeys(term);
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
  clipboardKeys(term);
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
  const w = !found && findWorkspace(s.cwd);
  return `${found ? projectLabel(found.project) : w ? wsLabel(w) : basename(s.cwd)} · ${s.label}`;
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
  const where = placeLabel(s.cwd);
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
  closeEditor();
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
  closeEditor();
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
  const s = await api('POST', '/api/sessions', { cwd, continue: !!opts.continue, resume: opts.resume, tui: settings.claudeTui });
  ensureTerm(s.id);
  if (!state.sessions.some(x => x.id === s.id)) state.sessions.push(s);
  selectSession(s.id);
}

async function addProject() {
  const path = prompt('Đường dẫn repo, hoặc thư mục chứa nhiều repo (ví dụ D:\\CPLUS):');
  if (!path) return;
  const { added, workspace } = await api('POST', '/api/projects', { path: path.trim().replace(/^"|"$/g, '') });
  const lines = [];
  if (workspace) lines.push('Đã thêm workspace (mở được phiên Claude ở folder cha).');
  if (added.length) lines.push(`Đã thêm ${added.length} dự án:\n${added.join('\n')}`);
  alert(lines.join('\n\n'));
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

function openDiffModal(title, text) {
  document.getElementById('diff-title').textContent = title;
  const body = document.getElementById('diff-body');
  // a commit starts with its message, where "- item" lines are text, not removed lines
  let inDiff = !/^commit /.test(text || '');
  body.replaceChildren(...(text || '(không có thay đổi)').split('\n').map(line => {
    if (line.startsWith('diff ')) inDiff = true;
    let cls = '';
    if (!inDiff) cls = /^(commit|Author:|Date:) /.test(line) ? 'head' : '';
    else if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) cls = 'meta';
    else if (line.startsWith('+')) cls = 'add';
    else if (line.startsWith('-')) cls = 'del';
    else if (line.startsWith('@@')) cls = 'hunk';
    return h('span', { class: cls }, line);
  }));
  body.scrollTop = 0;
  diffFile = null;
  document.getElementById('diff-edit').hidden = true;
  document.getElementById('diff-modal').hidden = false;
}

let diffFile = null; // { cwd, file } when the diff modal shows a working-tree file
async function showDiff(cwd, file) {
  const { diff } = await api('GET', `/api/diff?cwd=${encodeURIComponent(cwd)}&file=${encodeURIComponent(file)}`);
  openDiffModal(file, diff);
  diffFile = { cwd, file };
  document.getElementById('diff-edit').hidden = false;
}

async function showCommit(cwd, c) {
  const { text } = await api('GET', `/api/commit?cwd=${encodeURIComponent(cwd)}&hash=${c.hash}`);
  openDiffModal(`${c.hash.slice(0, 8)} — ${c.subject}`, text);
}

// ---------- git commit graph ----------
const LANE = 14;
const ROW_H = 26;
const GRAPH_COLORS = ['var(--accent)', '#13c2c2', '#eb2f96', '#52c41a', '#9254de', '#2f7cf6', '#ff7a45', '#a0d911'];
const laneX = lane => 9 + lane * LANE;
const graphColor = i => GRAPH_COLORS[i % GRAPH_COLORS.length];

function svgEl(tag, attrs = {}, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.append(...children);
  return el;
}

function graphCell(c, width) {
  const svg = svgEl('svg', { class: 'gl-graph', width: laneX(width - 1) + 9, height: ROW_H });
  for (const s of c.segments) {
    const x1 = laneX(s.x1), y1 = s.y1 * ROW_H, x2 = laneX(s.x2), y2 = s.y2 * ROW_H;
    const d = x1 === x2 ? `M${x1} ${y1}L${x2} ${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`;
    svg.append(svgEl('path', { d, style: `stroke:${graphColor(s.color)}` }));
  }
  const isHead = c.refs.some(r => r.kind === 'head');
  const merge = c.parents.length > 1;
  svg.append(svgEl('circle', {
    cx: laneX(c.col), cy: ROW_H / 2, r: isHead ? 5 : 4,
    class: `gl-dot${merge ? ' merge' : ''}${isHead ? ' head' : ''}`,
    style: `stroke:${graphColor(c.color)};fill:${merge ? 'var(--bg)' : graphColor(c.color)}`,
  }));
  return svg;
}

async function loadGitLog(path, opts = {}) {
  const prev = state.gitlog.get(norm(path)) || { all: false, limit: 200, filter: '' };
  const next = { ...prev, ...opts, loading: true, error: null };
  state.gitlog.set(norm(path), next);
  render();
  try {
    const data = await api('GET', `/api/log?cwd=${encodeURIComponent(path)}&all=${next.all ? 1 : 0}&limit=${next.limit}`);
    state.gitlog.set(norm(path), { ...state.gitlog.get(norm(path)), loading: false, data });
  } catch (err) {
    state.gitlog.set(norm(path), { ...state.gitlog.get(norm(path)), loading: false, error: err.message });
  }
  render();
}

function gitLogSection(path) {
  const g = state.gitlog.get(norm(path));
  if (!g) {
    // first visit: mark as loading now, fetch after this render finishes
    state.gitlog.set(norm(path), { all: false, limit: 200, filter: '', loading: true });
    setTimeout(() => loadGitLog(path));
    return [h('h3', {}, 'Lịch sử git'), h('p', { class: 'hint' }, 'Đang đọc git log…')];
  }
  const data = g.data;
  const q = (g.filter || '').toLowerCase();
  const commits = data?.commits || [];
  const shown = q ? commits.filter(c => `${c.subject} ${c.author} ${c.hash} ${c.refs.map(r => r.name).join(' ')}`.toLowerCase().includes(q)) : commits;

  const head = h('h3', {}, `Lịch sử git (${commits.length}${data?.more ? '+' : ''})`,
    h('button', { class: 'btn small ghost', title: 'Đọc lại git log', onclick: () => loadGitLog(path) }, icon('resume'), g.loading ? 'đang tải…' : 'làm mới'));

  const controls = h('div', { class: 'gl-controls' },
    h('label', { class: 'gl-toggle' },
      h('input', { type: 'checkbox', checked: g.all, onchange: e => loadGitLog(path, { all: e.target.checked }) }), 'Tất cả nhánh'),
    h('input', {
      class: 'history-filter gl-filter', type: 'search', placeholder: 'Lọc theo nội dung, tác giả, mã commit, nhánh…', value: g.filter || '',
      oninput: e => {
        state.gitlog.set(norm(path), { ...g, filter: e.target.value });
        const pos = e.target.selectionStart;
        render();
        const el = document.querySelector('.gl-filter');
        el?.focus();
        el?.setSelectionRange(pos, pos);
      },
    }));

  let body;
  if (g.error) body = h('p', { class: 'hint' }, `Không đọc được git log: ${g.error}`);
  else if (!data) body = h('p', { class: 'hint' }, 'Đang đọc git log…');
  else if (!shown.length) body = h('p', { class: 'hint' }, q ? 'Không có commit nào khớp.' : 'Chưa có commit nào.');
  else {
    // the graph only makes sense for the full, unfiltered list
    const withGraph = !q;
    body = h('div', { class: 'gl-list' }, shown.map(c => h('div', { class: 'gl-row', onclick: () => showCommit(path, c), title: `${c.hash}\n${c.subject}` },
      withGraph ? graphCell(c, data.width) : null,
      c.refs.length ? h('span', { class: 'gl-refs' }, c.refs.map(r => h('span', { class: `gl-ref ${r.kind}` }, r.kind === 'tag' ? `🏷 ${r.name}` : r.name))) : null,
      h('span', { class: 'gl-subject' }, c.subject),
      h('span', { class: 'gl-author' }, c.author),
      h('span', { class: 'gl-time' }, ago(c.time)),
      h('code', { class: 'gl-hash' }, c.hash.slice(0, 7)))));
  }
  const more = data?.more && !q
    ? h('button', { class: 'btn small', disabled: g.loading, onclick: () => loadGitLog(path, { limit: g.limit + 300 }) }, icon('download'), 'Tải thêm commit')
    : null;
  return [head, controls, body, more];
}

function fileList(cwd, changes) {
  if (!changes?.length) return h('p', { class: 'hint' }, 'Không có file nào thay đổi.');
  return h('ul', { class: 'file-list' }, changes.map(c =>
    h('li', { onclick: () => showDiff(cwd, c.file), title: 'Xem diff' }, h('span', { class: `code ${c.code}` }, c.code), h('span', { class: 'fl-name' }, c.file),
      c.code === 'D' ? null : h('button', { class: 'btn small ghost fl-edit', title: 'Mở trong editor', onclick: e => { e.stopPropagation(); openEditor(cwd, joinPath(cwd, c.file.replace(/\//g, '\\'))); } }, icon('edit')))));
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

  if (!state.projects.length && !state.workspaces.length) {
    nodes.push(h('div', { class: 'empty' }, 'Chưa có dự án nào.', h('br'), 'Bấm “+ Thêm dự án” và nhập đường dẫn repo, hoặc thư mục chứa nhiều repo.'));
  }

  const nested = new Set();
  for (const w of state.workspaces) {
    const children = state.projects.filter(p => !nested.has(p) && isInside(p.path, w.path));
    children.forEach(p => nested.add(p));
    const list = sessionsIn(w.path);
    list.forEach(s => placed.add(s.id));
    const selected = sel?.kind === 'workspace' && norm(sel.path) === norm(w.path);
    nodes.push(h('div', { class: 'workspace' },
      h('div', { class: 'workspace-head', title: w.path },
        icon('grid'),
        h('span', { class: 'kicker' }, 'Workspace'),
        h('span', { class: 'name' }, wsLabel(w), w.alias ? h('span', { class: 'name-hint' }, w.name) : null),
        h('span', { class: 'tools' },
          h('button', { class: 'btn small', title: 'Đặt tên workspace', onclick: () => renameFolder(w.path, w.alias, 'workspace') }, icon('edit')),
          h('button', { class: 'btn small danger', title: 'Gỡ workspace (giữ các dự án con)', onclick: () => removeWorkspace(w) }, icon('close')))),
      h('div', { class: `row ws-row${selected ? ' selected' : ''}`, onclick: () => selectWorkspace(w.path), title: `Phiên Claude ở folder cha: ${w.path}` },
        icon('folder'),
        h('span', { class: 'label' }, 'Toàn bộ workspace', h('span', { class: 'label-sub' }, `${children.length} repo`)),
        w.missing ? h('span', { class: 'badge', title: 'Thư mục không còn tồn tại' }, 'mất') : null,
        h('button', { class: 'btn small start play', title: 'Mở phiên Claude ở folder cha', onclick: e => { e.stopPropagation(); startSession(w.path); } }, icon('play'))),
      list.map((s, i) => sessionRow(s, sessionLabel(s, i), sel)),
      h('div', { class: 'workspace-children' }, children.map(p => projectBlock(p, sel, placed)))));
  }

  for (const p of state.projects) if (!nested.has(p)) nodes.push(projectBlock(p, sel, placed));

  const others = state.sessions.filter(s => !placed.has(s.id));
  if (others.length) {
    nodes.push(h('div', { class: 'group-title' }, icon('terminal'), 'Phiên khác'));
    nodes.push(others.map((s, i) => sessionRow(s, `${basename(s.cwd)} · ${sessionLabel(s, i)}`, sel)));
  }
  tree.replaceChildren(...nodes.flat(Infinity));
}

function projectBlock(p, sel, placed) {
  {
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
          h('button', { class: 'btn small start play', title: 'Mở phiên Claude mới', onclick: e => { e.stopPropagation(); startSession(wt.path); } }, icon('play'))),
        list.map((s, i) => sessionRow(s, sessionLabel(s, i), sel)),
      ];
    });
    return h('div', { class: 'project' },
      h('div', { class: 'project-head', title: p.path },
        icon('repo'),
        h('span', { class: 'name' }, projectLabel(p), projectHint(p) ? h('span', { class: 'name-hint' }, projectHint(p)) : null),
        h('span', { class: 'tools' },
          h('button', { class: 'btn small', title: 'Đặt tên hiển thị cho dự án', onclick: () => renameFolder(p.path, p.alias, 'dự án') }, icon('edit')),
          h('button', { class: 'btn small', title: 'Tạo worktree / nhánh mới', onclick: () => addWorktree(p) }, icon('plus'), 'nhánh'),
          h('button', { class: 'btn small danger', title: 'Gỡ khỏi dashboard', onclick: () => removeProject(p) }, icon('close'))),
        p.error ? null : h('button', { class: 'btn small primary head-start', title: `Mở phiên Claude ở thư mục dự án\n${p.path}`, onclick: () => startSession(p.path) }, icon('play'))),
      p.error ? h('div', { class: 'project-error' }, p.error) : null,
      wts);
  }
}

function renderOverview() {
  const order = { waiting: 0, done: 1, running: 2, idle: 3, exited: 4 };
  const list = [...state.sessions].sort((a, b) => (b.unread - a.unread) || (order[a.status] - order[b.status]) || (b.updatedAt - a.updatedAt));
  const cards = list.map(s => {
    const found = findWorktree(s.cwd);
    return h('button', { class: `card ${s.status}`, onclick: () => selectSession(s.id) },
      h('div', { class: 'top' }, dot(s), h('span', { class: `status-text ${s.status}` }, STATUS[s.status]), s.unread ? h('span', { class: 'badge changes' }, 'mới') : null),
      h('div', { class: 'where' }, icon(found ? 'branch' : findWorkspace(s.cwd) ? 'grid' : 'folder'), found || findWorkspace(s.cwd) ? placeLabel(s.cwd) : s.cwd),
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
      h('button', { class: 'btn ghost', title: 'Xem và sửa file trong thư mục này', onclick: () => openEditor(wt.path) }, icon('file'), 'Tệp')),
    list.length ? h('h3', {}, 'Phiên đang mở') : null,
    list.length ? h('div', { class: 'cards' }, list.map((s, i) => h('button', { class: `card ${s.status}`, onclick: () => selectSession(s.id) },
      h('div', { class: 'top' }, dot(s), h('span', { class: `status-text ${s.status}` }, STATUS[s.status])),
      h('div', { class: 'title' }, sessionLabel(s, i))))) : null,
    historySection(wt.path),
    h('h3', {}, `File đã sửa (${wt.changes?.length || 0})`),
    fileList(wt.path, wt.changes),
    gitLogSection(wt.path));
}

function renderWorkspaceView() {
  const w = findWorkspace(state.selected.path);
  const view = document.getElementById('worktree-view');
  if (!w) {
    view.replaceChildren(h('p', { class: 'hint' }, 'Workspace không còn tồn tại.'));
    return;
  }
  const list = sessionsIn(w.path);
  const children = state.projects.filter(p => isInside(p.path, w.path));
  fill(view,
    h('h2', {}, `Workspace › ${wsLabel(w)}`),
    h('p', { class: 'hint' }, `${w.path} — phiên Claude mở ở đây làm việc được trên mọi repo bên dưới và đọc CLAUDE.md / AGENTS.md của folder cha.`),
    h('div', { class: 'start-actions' },
      h('button', { class: 'btn primary', onclick: () => startSession(w.path) }, icon('play'), 'Phiên Claude mới'),
      h('button', { class: 'btn', onclick: () => startSession(w.path, { continue: true }) }, icon('resume'), 'Tiếp tục phiên gần nhất'),
      h('button', { class: 'btn ghost', onclick: () => openShell(w.path) }, icon('terminal'), 'Terminal'),
      h('button', { class: 'btn ghost', title: 'Xem và sửa file trong workspace', onclick: () => openEditor(w.path) }, icon('file'), 'Tệp'),
      h('button', { class: 'btn ghost', onclick: () => api('POST', '/api/open', { cwd: w.path, tool: 'explorer' }) }, icon('folder'), 'Thư mục')),
    list.length ? h('h3', {}, 'Phiên đang mở') : null,
    list.length ? h('div', { class: 'cards' }, list.map((s, i) => h('button', { class: `card ${s.status}`, onclick: () => selectSession(s.id) },
      h('div', { class: 'top' }, dot(s), h('span', { class: `status-text ${s.status}` }, STATUS[s.status])),
      h('div', { class: 'title' }, sessionLabel(s, i))))) : null,
    historySection(w.path),
    h('h3', {}, `Repo trong workspace (${children.length})`),
    h('ul', { class: 'file-list ws-repos' }, children.map(p => {
      const main = p.worktrees.find(wt => wt.main) || p.worktrees[0];
      const changes = p.worktrees.reduce((n, wt) => n + (wt.changes?.length || 0), 0);
      return h('li', { onclick: () => main && selectWorktree(main.path), title: p.path },
        h('span', { class: 'code' }, changes || '·'),
        h('span', {}, projectLabel(p), main ? h('span', { class: 'label-sub' }, ` ${branchLabel(main)}`) : null));
    })));
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

// ---------- plugins & skills per session ----------
const skillLoading = new Set();
async function loadSkills(cwd) {
  if (skillLoading.has(norm(cwd))) return;
  skillLoading.add(norm(cwd));
  try {
    state.skillAvail.set(norm(cwd), await api('GET', `/api/skills?cwd=${encodeURIComponent(cwd)}`));
  } finally {
    skillLoading.delete(norm(cwd));
  }
  render();
}

// what the session runs with now: its own choice, or each plugin's default for the folder
function activeSkills(s, avail) {
  const plugins = {};
  for (const p of avail.plugins) plugins[p.id] = s.skills?.plugins?.[p.id] ?? p.enabled;
  return { plugins, off: new Set(s.skills?.off || []) };
}

// skills Claude can use with this selection, and the rough tokens their descriptions cost every session
function skillTotals(avail, sel) {
  let count = 0, tokens = 0;
  const all = [...avail.plugins.filter(p => sel.plugins[p.id]).flatMap(p => p.skills), ...avail.skills];
  for (const sk of all) {
    if (sel.off.has(sk.name)) continue;
    count++;
    tokens += sk.tokens;
  }
  return { count, tokens };
}

// skills turned off inside a disabled plugin don't matter; drop them so the choice stays tidy
function skillSelection(avail, sel) {
  const inactive = new Set(avail.plugins.filter(p => !sel.plugins[p.id]).flatMap(p => p.skills.map(sk => sk.name)));
  return { plugins: { ...sel.plugins }, off: [...sel.off].filter(n => !inactive.has(n)).sort() };
}

async function applySkills(s, selection) {
  const msg = s.claudeSessionId
    ? 'Phiên sẽ khởi động lại và mở lại đúng cuộc trò chuyện này với bộ skill mới. Tiếp tục?'
    : 'Phiên chưa có mã hội thoại nên sẽ mở lại từ đầu với bộ skill mới. Tiếp tục?';
  if (!confirm(msg)) return;
  await api('POST', `/api/sessions/${s.id}/restart`, { skills: selection });
  state.skillDraft = null;
  requestAnimationFrame(fitSelected);
}

function renderSkillPanel(s) {
  const panel = document.getElementById('skill-panel');
  const avail = state.skillAvail.get(norm(s.cwd));
  if (!avail) {
    panel.replaceChildren(h('h3', {}, 'Skill của phiên'), h('p', { class: 'hint' }, 'Đang đọc plugin và skill…'));
    return;
  }
  const active = activeSkills(s, avail);
  if (state.skillDraft?.sid !== s.id) state.skillDraft = { sid: s.id, plugins: { ...active.plugins }, off: new Set(active.off) };
  const draft = state.skillDraft;
  const dirty = JSON.stringify(skillSelection(avail, draft)) !== JSON.stringify(skillSelection(avail, active));
  const totals = skillTotals(avail, draft);

  const skillRow = (sk, disabled) => h('li', { class: 'skill-row' },
    h('label', { title: sk.description },
      h('input', {
        type: 'checkbox', checked: !draft.off.has(sk.name), disabled,
        onchange: e => { e.target.checked ? draft.off.delete(sk.name) : draft.off.add(sk.name); render(); },
      }),
      h('span', { class: 'mcp-name' }, sk.name.replace(/^[^:]+:/, '')),
      h('span', { class: 'skill-tok' }, `~${sk.tokens}`)));

  const pluginBlock = p => {
    const on = draft.plugins[p.id];
    const offCount = p.skills.filter(sk => draft.off.has(sk.name)).length;
    const tokens = p.skills.reduce((n, sk) => n + sk.tokens, 0);
    return h('li', { class: on ? 'on' : '' },
      h('details', { open: state.skillExpanded.has(p.id), ontoggle: e => e.target.open ? state.skillExpanded.add(p.id) : state.skillExpanded.delete(p.id) },
        h('summary', {},
          h('input', {
            type: 'checkbox', checked: on, title: on ? 'Tắt cả plugin cho phiên này' : 'Bật plugin cho phiên này',
            onclick: e => e.stopPropagation(),
            onchange: e => { draft.plugins[p.id] = e.target.checked; render(); },
          }),
          h('span', { class: 'mcp-name' }, p.name),
          h('span', { class: 'badge', title: p.scope === 'user' ? 'Cài cho mọi dự án' : 'Cài riêng cho dự án này' }, p.scope)),
        h('div', { class: 'mcp-meta' }, `v${p.version} · ${p.skills.length} skill · ~${tokens} token`,
          offCount && on ? h('span', { class: 'mcp-used' }, ` · chặn ${offCount}`) : null,
          p.enabled ? null : h('span', {}, ' · mặc định tắt')),
        p.skills.length ? h('ul', { class: 'skill-list' }, p.skills.map(sk => skillRow(sk, !on))) : null));
  };

  fill(panel,
    h('h3', {}, 'Skill của phiên'),
    h('p', { class: 'mcp-mode' }, s.skills ? 'Bộ plugin/skill chọn riêng cho phiên này' : 'Mặc định: theo cài đặt plugin của thư mục này',
      h('br'), `${totals.count} skill · luôn nạp khoảng ${totals.tokens.toLocaleString('vi-VN')} token mô tả`),
    h('h3', { class: 'mcp-sub' }, 'Plugin'),
    avail.plugins.length ? h('ul', { class: 'mcp-list' }, avail.plugins.map(pluginBlock)) : h('p', { class: 'hint' }, 'Chưa cài plugin nào cho thư mục này.'),
    avail.skills.length ? [
      h('h3', { class: 'mcp-sub' }, 'Skill riêng'),
      h('ul', { class: 'mcp-list' }, avail.skills.map(sk => h('li', { class: draft.off.has(sk.name) ? '' : 'on' },
        h('label', { title: sk.description },
          h('input', {
            type: 'checkbox', checked: !draft.off.has(sk.name),
            onchange: e => { e.target.checked ? draft.off.delete(sk.name) : draft.off.add(sk.name); render(); },
          }),
          h('span', { class: 'mcp-name' }, sk.name),
          h('span', { class: 'badge', title: sk.scope === 'user' ? '~/.claude/skills' : '.claude/skills của repo' }, sk.scope)),
        h('div', { class: 'mcp-meta' }, `~${sk.tokens} token · ${sk.description}`)))),
    ] : null,
    h('div', { class: 'mcp-actions' },
      h('button', { class: 'btn small primary', disabled: !dirty, onclick: () => applySkills(s, skillSelection(avail, draft)) }, icon('resume'), 'Áp dụng & khởi động lại'),
      s.skills ? h('button', { class: 'btn small', onclick: () => applySkills(s, null) }, 'Về mặc định') : null,
      h('button', { class: 'btn small ghost', onclick: () => { state.skillAvail.delete(norm(s.cwd)); state.skillDraft = null; loadSkills(s.cwd).catch(() => {}); render(); } }, icon('resume'), 'Đọc lại')),
    h('p', { class: 'set-hint' }, 'Tắt plugin hoặc skill riêng thì Claude không còn thấy mô tả của nó, đỡ tốn token và đỡ gọi nhầm. ',
      'Tắt lẻ một skill trong plugin chỉ chặn Claude gọi nó; tên vẫn nằm trong danh sách. ',
      'Skill có sẵn của Claude Code (code-review, simplify…) không liệt kê ở đây. Đổi xong phiên sẽ khởi động lại và giữ cuộc trò chuyện.'));
}

function renderSessionView() {
  const s = state.sessions.find(x => x.id === state.selected.id);
  if (!s) return;
  const found = findWorktree(s.cwd);
  fill(document.getElementById('session-crumbs'), 
    dot(s),
    h('span', { class: `status-text ${s.status}` }, STATUS[s.status]),
    h('span', { class: 'sep' }, '·'),
    h('strong', {}, found ? projectLabel(found.project) : placeLabel(s.cwd)),
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

  const skillPanel = document.getElementById('skill-panel');
  skillPanel.hidden = !state.skillsOpen;
  if (state.skillsOpen) renderSkillPanel(s);
  const skillAvail = state.skillAvail.get(norm(s.cwd));
  document.querySelector('[data-act="skills"] .skill-label').textContent = skillAvail ? `Skill (${skillTotals(skillAvail, activeSkills(s, skillAvail)).count})` : 'Skill';
  if (!skillAvail) loadSkills(s.cwd).catch(() => {});
  document.querySelector('[data-act="kill"]').hidden = s.status === 'exited';
  // panels toggled from the bar: the open one is outlined so it's clear which button closes it
  for (const [act, open] of [['files', state.filesOpen], ['mcp', state.mcpOpen], ['skills', state.skillsOpen]]) {
    const btn = document.querySelector(`.session-head [data-act="${act}"]`);
    btn.classList.toggle('on', open);
    btn.setAttribute('aria-pressed', String(open));
  }
}

function render() {
  renderCounts();
  renderTree();
  const kind = state.selected?.kind;
  document.getElementById('overview').hidden = !!kind;
  document.getElementById('worktree-view').hidden = kind !== 'worktree' && kind !== 'workspace';
  document.getElementById('session-view').hidden = kind !== 'session';
  if (!kind) renderOverview();
  else if (kind === 'worktree') renderWorktreeView();
  else if (kind === 'workspace') renderWorkspaceView();
  else renderSessionView();
  if (editor.open) renderEditor();
}

// ---------- text editor (CodeMirror 5) ----------
const editor = {
  open: false,
  root: null,
  expanded: new Map(), // normalized dir -> dir as typed (keeps the real casing)
  dirs: new Map(), // normalized dir -> { loading } | { entries } | { error }
  tabs: [], // { path, name, doc, mtime, bom, eol, cleanGen }
  active: null, // path
  cm: null,
};

const MODES = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', json: { name: 'javascript', json: true },
  ts: 'text/typescript', jsx: 'jsx', tsx: { name: 'jsx', base: { name: 'javascript', typescript: true } },
  css: 'css', scss: 'text/x-scss', less: 'text/x-less',
  html: 'htmlmixed', htm: 'htmlmixed', cshtml: 'htmlmixed', razor: 'htmlmixed',
  xml: 'xml', csproj: 'xml', props: 'xml', targets: 'xml', config: 'xml', svg: 'xml', resx: 'xml', sln: null,
  cs: 'text/x-csharp', java: 'text/x-java', c: 'text/x-csrc', h: 'text/x-csrc', cpp: 'text/x-c++src', kt: 'text/x-kotlin',
  md: 'markdown', sql: 'text/x-sql', yml: 'yaml', yaml: 'yaml', py: 'python',
  sh: 'shell', bash: 'shell', ps1: 'powershell', psm1: 'powershell',
};
const extOf = p => (basename(p).split('.').pop() || '').toLowerCase();
const modeFor = p => MODES[extOf(p)] ?? null;
const twoSpace = p => ['js', 'mjs', 'cjs', 'json', 'ts', 'jsx', 'tsx', 'css', 'scss', 'less', 'html', 'yml', 'yaml', 'md'].includes(extOf(p));
const tabDirty = t => !t.doc.isClean(t.cleanGen);
const joinPath = (dir, name) => `${dir.replace(/[\\/]+$/, '')}\\${name}`;

function ensureCm() {
  if (editor.cm) return editor.cm;
  editor.cm = CodeMirror(document.getElementById('editor-cm'), {
    theme: 'hub',
    lineNumbers: true,
    matchBrackets: true,
    autoCloseBrackets: true,
    styleActiveLine: true,
    indentWithTabs: false,
    extraKeys: {
      'Ctrl-S': () => saveActive(),
      'Cmd-S': () => saveActive(),
      'Ctrl-/': 'toggleComment',
      'Cmd-/': 'toggleComment',
      'Alt-G': 'jumpToLine',
    },
  });
  editor.cm.on('change', () => renderEditorTabs());
  editor.cm.on('cursorActivity', () => renderEditorStatus());
  return editor.cm;
}

async function openEditor(root, file) {
  if (editor.root && norm(editor.root) !== norm(root)) {
    editor.expanded.clear();
  }
  editor.root = root;
  editor.open = true;
  editor.expanded.set(norm(root), root);
  document.getElementById('editor-view').hidden = false;
  ensureCm();
  renderEditor();
  loadDir(root);
  if (file) {
    // reveal the file's folders in the tree
    let dir = file.replace(/[\\/][^\\/]+$/, '');
    while (isInside(dir, root) && norm(dir) !== norm(root)) {
      editor.expanded.set(norm(dir), dir);
      loadDir(dir);
      dir = dir.replace(/[\\/][^\\/]+$/, '');
    }
    await openFile(file);
  }
  requestAnimationFrame(() => editor.cm.refresh());
}

function closeEditor() {
  editor.open = false;
  document.getElementById('editor-view').hidden = true;
}

async function loadDir(dir, force = false) {
  const key = norm(dir);
  if (!force && editor.dirs.get(key) && !editor.dirs.get(key).error) return;
  editor.dirs.set(key, { loading: true });
  renderEditorTree();
  try {
    const { entries } = await api('GET', `/api/fs/list?path=${encodeURIComponent(dir)}`);
    editor.dirs.set(key, { entries });
  } catch (err) {
    editor.dirs.set(key, { error: err.message });
  }
  renderEditorTree();
}

async function openFile(path) {
  const existing = editor.tabs.find(t => norm(t.path) === norm(path));
  if (existing) return activateTab(existing.path);
  let data;
  try {
    data = await api('GET', `/api/fs/read?path=${encodeURIComponent(path)}`);
  } catch {
    return; // api() already showed the reason (binary, too large, outside the hub…)
  }
  const doc = CodeMirror.Doc(data.text, modeFor(path));
  const tab = { path: data.path, name: basename(data.path), doc, mtime: data.mtime, bom: data.bom, eol: data.eol, cleanGen: doc.changeGeneration() };
  editor.tabs.push(tab);
  activateTab(tab.path);
}

function activateTab(path) {
  const tab = editor.tabs.find(t => norm(t.path) === norm(path));
  if (!tab) return;
  editor.active = tab.path;
  const cm = ensureCm();
  if (cm.getDoc() !== tab.doc) cm.swapDoc(tab.doc);
  cm.setOption('indentUnit', twoSpace(tab.path) ? 2 : 4);
  cm.setOption('tabSize', twoSpace(tab.path) ? 2 : 4);
  renderEditor();
  requestAnimationFrame(() => { cm.refresh(); cm.focus(); });
}

function closeTab(path) {
  const i = editor.tabs.findIndex(t => norm(t.path) === norm(path));
  if (i === -1) return;
  if (tabDirty(editor.tabs[i]) && !confirm(`"${editor.tabs[i].name}" có thay đổi chưa lưu. Đóng và bỏ các thay đổi?`)) return;
  editor.tabs.splice(i, 1);
  if (norm(editor.active || '') === norm(path)) {
    const next = editor.tabs[i] || editor.tabs[i - 1];
    editor.active = null;
    if (next) return activateTab(next.path);
    editor.cm?.swapDoc(CodeMirror.Doc(''));
  }
  renderEditor();
}

async function reloadTab(tab) {
  const data = await api('GET', `/api/fs/read?path=${encodeURIComponent(tab.path)}`);
  tab.doc.setValue(data.text);
  Object.assign(tab, { mtime: data.mtime, bom: data.bom, eol: data.eol, cleanGen: tab.doc.changeGeneration() });
  renderEditor();
}

async function saveActive(force = false) {
  const tab = editor.tabs.find(t => norm(t.path) === norm(editor.active || ''));
  if (!tab) return;
  const res = await fetch('/api/fs/write', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-token': window.HUB_TOKEN },
    body: JSON.stringify({ path: tab.path, text: tab.doc.getValue(), mtime: tab.mtime, bom: tab.bom, eol: tab.eol, force }),
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 409) {
    if (confirm(`"${tab.name}" đã bị thay đổi trên ổ đĩa sau khi bạn mở (có thể do Claude sửa).\n\nOK: ghi đè bằng nội dung của bạn.\nCancel: không lưu.`)) return saveActive(true);
    if (confirm('Tải lại bản trên ổ đĩa? Các thay đổi chưa lưu của bạn sẽ mất.')) await reloadTab(tab);
    return;
  }
  if (!res.ok) {
    alert(data.error || `Lỗi ${res.status}`);
    return;
  }
  tab.mtime = data.mtime;
  tab.cleanGen = tab.doc.changeGeneration();
  renderEditor();
  flashStatus(`Đã lưu ${tab.name}`);
}

// absolute paths of files git reports as changed, to mark them in the tree
function changedPaths() {
  const set = new Set();
  for (const p of state.projects) for (const wt of p.worktrees) {
    for (const c of wt.changes || []) set.add(norm(joinPath(wt.path, c.file.replace(/\//g, '\\'))));
  }
  return set;
}

function renderEditor() {
  if (!editor.open) return;
  const w = findWorkspace(editor.root);
  document.getElementById('editor-root').textContent = w ? `Workspace ${wsLabel(w)} — ${editor.root}` : `${placeLabel(editor.root)} — ${editor.root}`;
  renderEditorTree();
  renderEditorTabs();
  renderEditorStatus();
  const hasTab = !!editor.active;
  document.getElementById('editor-cm').style.visibility = hasTab ? 'visible' : 'hidden';
  document.getElementById('editor-empty').hidden = hasTab;
}

function renderEditorTree() {
  if (!editor.open || !editor.root) return;
  const changed = changedPaths();
  const node = (dir, depth) => {
    const st = editor.dirs.get(norm(dir));
    if (!st || st.loading) return h('div', { class: 'et-msg', style: `padding-left:${depth * 14 + 22}px` }, 'đang đọc…');
    if (st.error) return h('div', { class: 'et-msg err', style: `padding-left:${depth * 14 + 22}px` }, st.error);
    return st.entries.map(e => {
      const full = joinPath(dir, e.name);
      const open = e.dir && editor.expanded.has(norm(full));
      const isActive = !e.dir && norm(full) === norm(editor.active || '');
      const row = h('div', {
        class: `et-row${e.dir ? ' dir' : ''}${isActive ? ' on' : ''}${!e.dir && changed.has(norm(full)) ? ' changed' : ''}`,
        style: `padding-left:${depth * 14 + 8}px`, title: full,
        onclick: () => {
          if (!e.dir) return openFile(full);
          if (open) editor.expanded.delete(norm(full));
          else { editor.expanded.set(norm(full), full); loadDir(full); }
          renderEditorTree();
        },
      }, h('span', { class: 'et-caret' }, e.dir ? (open ? '▾' : '▸') : ''), icon(e.dir ? 'folder' : 'file'), h('span', { class: 'et-name' }, e.name));
      return open ? [row, node(full, depth + 1)] : row;
    });
  };
  const tree = document.getElementById('editor-tree');
  const top = tree.scrollTop;
  fill(tree, node(editor.root, 0));
  tree.scrollTop = top;
}

function renderEditorTabs() {
  if (!editor.open) return;
  fill(document.getElementById('editor-tabs'), editor.tabs.map(t => h('div', {
    class: `et-tab${norm(t.path) === norm(editor.active || '') ? ' on' : ''}${tabDirty(t) ? ' dirty' : ''}`,
    title: t.path, onclick: () => activateTab(t.path),
    onauxclick: e => { if (e.button === 1) closeTab(t.path); },
  }, h('span', { class: 'tl' }, t.name), h('span', { class: 'dirty-dot', title: 'Chưa lưu' }),
  h('button', { class: 'x', title: 'Đóng tab', onclick: e => { e.stopPropagation(); closeTab(t.path); } }, icon('close')))));
}

let statusFlash = null;
function flashStatus(text) {
  statusFlash = text;
  renderEditorStatus();
  setTimeout(() => { statusFlash = null; renderEditorStatus(); }, 2000);
}

function renderEditorStatus() {
  if (!editor.open) return;
  const tab = editor.tabs.find(t => norm(t.path) === norm(editor.active || ''));
  const el = document.getElementById('editor-status');
  if (!tab) return el.replaceChildren();
  const cur = tab.doc.getCursor();
  const mode = modeFor(tab.path);
  fill(el,
    h('span', { class: 'es-path' }, tab.path),
    statusFlash ? h('span', { class: 'es-flash' }, statusFlash) : (tabDirty(tab) ? h('span', { class: 'es-dirty' }, '● chưa lưu — Ctrl+S để lưu') : null),
    h('span', {}, `Dòng ${cur.line + 1}, cột ${cur.ch + 1}`),
    h('span', {}, tab.eol.toUpperCase()),
    h('span', {}, tab.bom ? 'UTF-8 BOM' : 'UTF-8'),
    h('span', {}, typeof mode === 'string' ? mode.replace(/^text\/x-/, '') : mode?.name || 'text'),
    h('button', { class: 'btn small ghost', title: 'Đọc lại file từ ổ đĩa', onclick: () => (!tabDirty(tab) || confirm('Bỏ thay đổi chưa lưu và tải lại file?')) && reloadTab(tab) }, icon('resume'), 'Tải lại'));
}

{
  document.getElementById('editor-close').onclick = closeEditor;
  document.getElementById('editor-refresh').onclick = () => {
    for (const [key, dir] of editor.expanded) {
      editor.dirs.delete(key);
      loadDir(dir, true);
    }
  };
  window.addEventListener('beforeunload', e => {
    if (editor.tabs.some(tabDirty)) { e.preventDefault(); e.returnValue = ''; }
  });
}

// ---------- wiring ----------
document.getElementById('home').onclick = () => { closeEditor(); state.selected = null; render(); };
document.getElementById('diff-edit').onclick = () => {
  if (!diffFile) return;
  document.getElementById('diff-modal').hidden = true;
  openEditor(diffFile.cwd, joinPath(diffFile.cwd, diffFile.file.replace(/\//g, '\\')));
};
document.getElementById('add-project').onclick = addProject;
document.getElementById('diff-close').onclick = () => { document.getElementById('diff-modal').hidden = true; };
document.getElementById('diff-modal').onclick = e => { if (e.target.id === 'diff-modal') e.target.hidden = true; };
// ---------- usage guide ----------
const guideModal = document.getElementById('guide-modal');
const guideBody = document.getElementById('guide-body');
const guideToc = document.getElementById('guide-toc');
fill(guideToc, [...guideBody.querySelectorAll('section')].map(sec => h('a', {
  href: `#${sec.id}`, 'data-id': sec.id,
  onclick: e => { e.preventDefault(); guidePicked = sec.id; sec.scrollIntoView({ block: 'start' }); markGuide(sec.id); },
}, sec.querySelector('h2').textContent)));
// a section picked in the table of contents stays highlighted until the reader scrolls by hand
// (short sections near the end can't reach the top, so position alone would pick the wrong one)
let guidePicked = null;
for (const ev of ['wheel', 'pointerdown', 'keydown']) guideBody.addEventListener(ev, () => { guidePicked = null; });
function markGuide(id) {
  for (const a of guideToc.children) a.classList.toggle('active', a.dataset.id === id);
}
guideBody.addEventListener('scroll', () => {
  if (guidePicked) return markGuide(guidePicked);
  const sections = [...guideBody.querySelectorAll('section')];
  const atEnd = guideBody.scrollTop + guideBody.clientHeight >= guideBody.scrollHeight - 2;
  const top = guideBody.getBoundingClientRect().top + 40;
  let current = sections[0];
  for (const sec of sections) if (sec.getBoundingClientRect().top <= top) current = sec;
  markGuide(atEnd ? sections.at(-1).id : current.id);
});
document.getElementById('open-guide').onclick = () => {
  guideModal.hidden = false;
  guideBody.dispatchEvent(new Event('scroll'));
};
document.getElementById('guide-close').onclick = () => { guideModal.hidden = true; };
guideModal.onclick = e => { if (e.target === guideModal) guideModal.hidden = true; };

document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  document.getElementById('diff-modal').hidden = true;
  guideModal.hidden = true;
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
  } else if (act === 'editor') {
    await openEditor(s.cwd);
  } else if (act === 'shell') {
    await openShell(s.cwd);
  } else if (act === 'skills') {
    state.skillsOpen = !state.skillsOpen;
    state.skillDraft = null;
    if (state.skillsOpen) { state.skillAvail.delete(norm(s.cwd)); loadSkills(s.cwd).catch(() => {}); }
    render();
    requestAnimationFrame(fitSelected);
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
