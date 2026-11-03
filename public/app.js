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
};
const terms = new Map(); // session id -> { term, fit, el }
let ws;

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

function wtLabel(wt) {
  return wt.branch || (wt.detached ? `(detached ${String(wt.head).slice(0, 7)})` : basename(wt.path));
}

function sessionLabel(s, i) {
  return s.title || `Phiên ${i + 1}`;
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
    fontFamily: 'Cascadia Mono, Consolas, monospace',
    fontSize: 14,
    cursorBlink: true,
    scrollback: 10000,
    theme: { background: '#0b0d10' },
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

// ---------- notifications ----------
let audio;
function beep(status) {
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
  const where = found ? `${found.project.name} › ${wtLabel(found.wt)}` : basename(s.cwd);
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
}

async function startSession(cwd, opts = {}) {
  const s = await api('POST', '/api/sessions', { cwd, continue: !!opts.continue });
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
  if (!confirm(`Gỡ "${p.name}" khỏi dashboard? (Không xóa file nào trên ổ đĩa)`)) return;
  await api('DELETE', '/api/projects', { path: p.path });
}

async function addWorktree(p) {
  const branch = prompt(`Tên nhánh cho worktree mới trong ${p.name} (nhánh chưa có sẽ được tạo từ HEAD):`);
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
          h('span', { class: 'label' }, `⎇ ${wtLabel(wt)}`),
          wt.main ? null : h('span', { class: 'badge' }, 'wt'),
          wt.changes?.length ? h('span', { class: 'badge changes', title: 'Số file đã sửa' }, `${wt.changes.length} ✎`) : null,
          h('button', { class: 'btn small start', title: 'Mở phiên Claude mới', onclick: e => { e.stopPropagation(); startSession(wt.path); } }, '▶')),
        list.map((s, i) => h('div', {
          class: `row session${sel?.kind === 'session' && sel.id === s.id ? ' selected' : ''}`,
          onclick: () => selectSession(s.id),
        }, dot(s), h('span', { class: 'label' }, sessionLabel(s, i)), h('span', { class: `sub status-text ${s.status}` }, STATUS[s.status]))),
      ];
    });
    nodes.push(h('div', { class: 'project' },
      h('div', { class: 'project-head', title: p.path },
        h('span', { class: 'name' }, p.name),
        h('span', { class: 'tools' },
          h('button', { class: 'btn small', title: 'Tạo worktree / nhánh mới', onclick: () => addWorktree(p) }, '+ nhánh'),
          h('button', { class: 'btn small danger', title: 'Gỡ khỏi dashboard', onclick: () => removeProject(p) }, '✕'))),
      p.error ? h('div', { class: 'project-error' }, p.error) : null,
      wts));
  }

  const others = state.sessions.filter(s => !placed.has(s.id));
  if (others.length) {
    nodes.push(h('div', { class: 'group-title' }, 'Phiên khác'));
    nodes.push(others.map((s, i) => h('div', {
      class: `row session${sel?.kind === 'session' && sel.id === s.id ? ' selected' : ''}`,
      onclick: () => selectSession(s.id),
      title: s.cwd,
    }, dot(s), h('span', { class: 'label' }, `${basename(s.cwd)} · ${sessionLabel(s, i)}`), h('span', { class: `sub status-text ${s.status}` }, STATUS[s.status]))));
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
      h('div', { class: 'where' }, found ? `${found.project.name} › ${wtLabel(found.wt)}` : s.cwd),
      h('div', { class: 'title' }, s.title || '(chưa có yêu cầu)'),
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
    h('h2', {}, `${project.name} › ${wtLabel(wt)}`),
    h('p', { class: 'hint' }, wt.path),
    h('div', { class: 'start-actions' },
      h('button', { class: 'btn primary', onclick: () => startSession(wt.path) }, '▶ Phiên Claude mới'),
      h('button', { class: 'btn', onclick: () => startSession(wt.path, { continue: true }) }, '↺ Tiếp tục phiên gần nhất'),
      h('button', { class: 'btn ghost', onclick: () => api('POST', '/api/open', { cwd: wt.path, tool: 'lazygit' }) }, 'lazygit'),
      h('button', { class: 'btn ghost', onclick: () => api('POST', '/api/open', { cwd: wt.path, tool: 'explorer' }) }, 'Thư mục')),
    list.length ? h('h3', {}, 'Phiên đang mở') : null,
    list.length ? h('div', { class: 'cards' }, list.map((s, i) => h('button', { class: `card ${s.status}`, onclick: () => selectSession(s.id) },
      h('div', { class: 'top' }, dot(s), h('span', { class: `status-text ${s.status}` }, STATUS[s.status])),
      h('div', { class: 'title' }, sessionLabel(s, i))))) : null,
    h('h3', {}, `File đã sửa (${wt.changes?.length || 0})`),
    fileList(wt.path, wt.changes));
}

function renderSessionView() {
  const s = state.sessions.find(x => x.id === state.selected.id);
  if (!s) return;
  const found = findWorktree(s.cwd);
  fill(document.getElementById('session-crumbs'), 
    dot(s),
    h('span', { class: `status-text ${s.status}` }, STATUS[s.status]),
    h('span', { class: 'sep' }, '·'),
    h('strong', {}, found ? found.project.name : basename(s.cwd)),
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
  const filesBtn = document.querySelector('[data-act="files"]');
  filesBtn.textContent = `File đã sửa (${found?.wt.changes?.length || 0})`;
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
document.addEventListener('keydown', e => { if (e.key === 'Escape') document.getElementById('diff-modal').hidden = true; });

document.querySelector('.session-head .actions').onclick = async e => {
  const act = e.target.dataset?.act;
  const id = state.selected?.id;
  const s = state.sessions.find(x => x.id === id);
  if (!act || !s) return;
  if (act === 'files') {
    state.filesOpen = !state.filesOpen;
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

setupNotifyButton();
connect();
render();
