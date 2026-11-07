const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');
const git = require('./git');
const config = require('./config');
const { SessionManager, claudeCommand } = require('./sessions');
const history = require('./history');
const mcp = require('./mcp');
const skills = require('./skills');
const { ShellManager } = require('./shells');
const { layout } = require('./graph');
const files = require('./files');
const search = require('./search');
const { pickFolder } = require('./picker');
const clipboard = require('./clipboard');

const PUBLIC = path.join(__dirname, '..', 'public');
const MODULES = path.join(__dirname, '..', 'node_modules');
const CODEMIRROR = path.join(MODULES, 'codemirror');
const STATIC = {
  '/': path.join(PUBLIC, 'index.html'),
  '/app.js': path.join(PUBLIC, 'app.js'),
  '/style.css': path.join(PUBLIC, 'style.css'),
  '/vendor/xterm.js': path.join(MODULES, '@xterm', 'xterm', 'lib', 'xterm.js'),
  '/vendor/xterm.css': path.join(MODULES, '@xterm', 'xterm', 'css', 'xterm.css'),
  '/vendor/addon-fit.js': path.join(MODULES, '@xterm', 'addon-fit', 'lib', 'addon-fit.js'),
};
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const POLL_MS = 4000;

function createHub({ port }) {
  const token = crypto.randomBytes(24).toString('hex');
  const cfg = config.load();
  if (config.addNestedProjects(cfg).length) config.save(cfg);
  const sessions = new SessionManager({ hookSettingsFile: path.join(config.HOME, 'hook-settings.json'), port, token });
  const shells = new ShellManager();
  let projects = [];
  let projectsJSON = '';
  const clients = new Set();

  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const allowedOrigins = new Set([...allowedHosts].map(h => `http://${h}`));
  // Blocks other websites (CSRF / DNS rebinding) from driving the terminals.
  function trusted(req) {
    if (!allowedHosts.has(req.headers.host)) return false;
    const origin = req.headers.origin;
    return !origin || allowedOrigins.has(origin);
  }

  function broadcast(msg) {
    const text = JSON.stringify(msg);
    for (const ws of clients) if (ws.readyState === 1) ws.send(text);
  }

  async function scanProjects() {
    return Promise.all(cfg.projects.map(async repo => {
      const name = path.basename(repo);
      try {
        const worktrees = await git.listWorktrees(repo);
        for (const wt of worktrees) {
          wt.changes = await git.changedFiles(wt.path).catch(() => []);
          wt.main = config.samePath(wt.path, repo);
          wt.alias = wt.main ? '' : config.aliasOf(cfg, wt.path);
        }
        return { path: repo, name, alias: config.aliasOf(cfg, repo), worktrees };
      } catch (err) {
        return { path: repo, name, alias: config.aliasOf(cfg, repo), worktrees: [], error: err.message };
      }
    }));
  }

  function listWorkspaces() {
    return (cfg.workspaces || []).map(dir => ({
      path: dir, name: path.basename(dir), alias: config.aliasOf(cfg, dir), missing: !fs.existsSync(dir),
    }));
  }
  const projectsMsg = () => ({ type: 'projects', projects, workspaces: listWorkspaces() });
  // the editor may only touch files under a registered repo, one of its worktrees, or a workspace
  const fileRoots = () => [...cfg.projects, ...projects.flatMap(p => p.worktrees.map(w => w.path)), ...(cfg.workspaces || [])];

  let scanning = null;
  function refreshProjects() {
    if (!scanning) {
      scanning = scanProjects().then(result => {
        projects = result;
        const json = JSON.stringify([result, listWorkspaces()]);
        if (json !== projectsJSON) {
          projectsJSON = json;
          broadcast(projectsMsg());
        }
      }).finally(() => { scanning = null; });
    }
    return scanning;
  }
  const timer = setInterval(refreshProjects, POLL_MS);
  refreshProjects();

  sessions.on('change', () => broadcast({ type: 'sessions', sessions: sessions.list() }));
  sessions.on('notify', session => broadcast({ type: 'notify', session }));
  sessions.on('data', (id, data) => broadcast({ type: 'output', id, data }));
  sessions.on('change', () => refreshProjects());
  const shellsMsg = () => ({ type: 'shells', shells: shells.list(), kinds: shells.kinds() });
  shells.on('change', () => broadcast(shellsMsg()));
  shells.on('data', (id, data) => broadcast({ type: 'shell-output', id, data }));

  function openTool(cwd, tool) {
    const opts = { cwd, detached: true, stdio: 'ignore', windowsHide: false };
    if (tool === 'explorer') spawn('explorer.exe', [cwd], opts).unref();
    else if (tool === 'lazygit') spawn('cmd.exe', ['/c', 'start', '""', 'lazygit'], opts).unref();
    else if (tool === 'terminal') spawn('cmd.exe', ['/c', 'start', '""', 'cmd.exe'], opts).unref();
    else throw new Error('Công cụ không hợp lệ');
  }

  async function api(req, res, url, body) {
    const send = (status, data) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    };
    const route = `${req.method} ${url.pathname}`;
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([\w-]+)(?:\/(kill|read|restart|name|image))?$/);
    // null keeps Claude Code's own MCP loading; a list must only name servers configured for cwd
    const mcpSelection = (cwd, list) => {
      if (list == null) return null;
      if (!Array.isArray(list)) throw new Error('Danh sách MCP không hợp lệ');
      const known = new Set(mcp.available(cwd).map(s => s.name));
      const bad = list.filter(n => !known.has(n));
      if (bad.length) throw new Error(`MCP không tồn tại: ${bad.join(', ')}`);
      return list;
    };

    if (route === 'POST /api/hook') {
      sessions.applyEvent(body.sid, body.event, body.payload || {});
      return send(200, { ok: true });
    }
    if (route === 'GET /api/state') {
      await refreshProjects();
      return send(200, { projects, workspaces: listWorkspaces(), sessions: sessions.list() });
    }
    if (route === 'POST /api/refresh') {
      await refreshProjects();
      return send(200, { ok: true });
    }
    if (route === 'POST /api/pick-folder') {
      const initial = body.initial && fs.existsSync(body.initial) ? body.initial : '';
      return send(200, { path: await pickFolder({ title: body.title || 'Chọn thư mục', initial }) });
    }
    if (route === 'POST /api/projects') {
      if (!body.path || !fs.existsSync(body.path)) return send(400, { error: 'Thư mục không tồn tại' });
      const added = await config.addProjects(cfg, body.path);
      const workspace = await config.addWorkspace(cfg, body.path);
      if (!added.length && !workspace) return send(400, { error: 'Không tìm thấy git repo mới trong thư mục này' });
      config.save(cfg);
      await refreshProjects();
      return send(200, { added, workspace });
    }
    if (route === 'DELETE /api/workspaces') {
      config.removeWorkspace(cfg, body.path);
      config.save(cfg);
      await refreshProjects();
      return send(200, { ok: true });
    }
    if (route === 'DELETE /api/projects') {
      config.removeProject(cfg, body.path);
      config.save(cfg);
      await refreshProjects();
      return send(200, { ok: true });
    }
    if (route === 'POST /api/alias') {
      if (!body.path) return send(400, { error: 'Thiếu đường dẫn' });
      const name = config.setAlias(cfg, body.path, body.name);
      config.save(cfg);
      await refreshProjects();
      return send(200, { name });
    }
    if (route === 'POST /api/worktrees') {
      const branch = String(body.branch || '').trim();
      if (!branch) return send(400, { error: 'Thiếu tên nhánh' });
      const dir = await git.addWorktree(body.repo, branch);
      await refreshProjects();
      return send(200, { path: dir });
    }
    if (route === 'GET /api/diff') {
      const text = await git.diff(url.searchParams.get('cwd'), url.searchParams.get('file'));
      return send(200, { diff: text });
    }
    if (route === 'GET /api/fs/list') {
      const dir = files.resolveSafe(url.searchParams.get('path'), fileRoots());
      return send(200, { path: dir, entries: files.list(dir) });
    }
    if (route === 'GET /api/fs/files') {
      const dir = files.resolveSafe(url.searchParams.get('root'), fileRoots());
      return send(200, { root: dir, ...await search.listFiles(dir) });
    }
    if (route === 'POST /api/fs/search') {
      const dir = files.resolveSafe(body.root, fileRoots());
      const query = String(body.query || '');
      if (body.regex) {
        try { search.buildMatcher(query, body); } catch (err) { return send(400, { error: `Biểu thức chính quy không hợp lệ: ${err.message}` }); }
      }
      return send(200, { root: dir, ...await search.searchText(dir, query, {
        regex: !!body.regex, caseSensitive: !!body.caseSensitive, wholeWord: !!body.wholeWord,
        include: body.include, exclude: body.exclude,
      }) });
    }
    if (route === 'GET /api/fs/read') {
      const file = files.resolveSafe(url.searchParams.get('path'), fileRoots());
      return send(200, { path: file, ...files.read(file) });
    }
    if (route === 'POST /api/fs/write') {
      const file = files.resolveSafe(body.path, fileRoots());
      if (typeof body.text !== 'string') return send(400, { error: 'Thiếu nội dung' });
      const result = files.write(file, body.text, { mtime: body.mtime, bom: !!body.bom, eol: body.eol, force: !!body.force });
      if (result.conflict) return send(409, { error: 'File đã bị thay đổi trên ổ đĩa kể từ lúc bạn mở', mtime: result.mtime });
      refreshProjects();
      return send(200, result);
    }
    if (route === 'GET /api/log') {
      const cwd = url.searchParams.get('cwd');
      if (!cwd || !fs.existsSync(cwd)) return send(400, { error: 'Thư mục không tồn tại' });
      const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 200, 1), 3000);
      const commits = await git.log(cwd, { all: url.searchParams.get('all') === '1', limit });
      const { rows, width } = layout(commits);
      return send(200, { width, commits: commits.map((c, i) => ({ ...c, ...rows[i] })), more: commits.length === limit });
    }
    if (route === 'GET /api/commit') {
      const cwd = url.searchParams.get('cwd');
      const hash = url.searchParams.get('hash') || '';
      if (!/^[0-9a-f]{7,40}$/i.test(hash)) return send(400, { error: 'Mã commit không hợp lệ' });
      return send(200, { text: await git.showCommit(cwd, hash) });
    }
    if (route === 'GET /api/history') {
      const cwd = url.searchParams.get('cwd');
      if (!cwd) return send(400, { error: 'Thiếu cwd' });
      return send(200, { sessions: history.listHistory(cwd) });
    }
    if (route === 'GET /api/mcp') {
      const cwd = url.searchParams.get('cwd');
      if (!cwd) return send(400, { error: 'Thiếu cwd' });
      return send(200, { servers: mcp.available(cwd).map(mcp.publicInfo) });
    }
    if (route === 'GET /api/skills') {
      const cwd = url.searchParams.get('cwd');
      if (!cwd || !fs.existsSync(cwd)) return send(400, { error: 'Thư mục không tồn tại' });
      return send(200, await skills.available(claudeCommand(), cwd));
    }
    if (route === 'GET /api/mcp/health') {
      const cwd = url.searchParams.get('cwd');
      if (!cwd || !fs.existsSync(cwd)) return send(400, { error: 'Thư mục không tồn tại' });
      return send(200, { health: await mcp.health(claudeCommand(), cwd) });
    }
    if (route === 'POST /api/open') {
      openTool(body.cwd, body.tool);
      return send(200, { ok: true });
    }
    if (route === 'POST /api/sessions') {
      if (!body.cwd || !fs.existsSync(body.cwd)) return send(400, { error: 'Thư mục không tồn tại' });
      if (body.resume && !history.ID_RE.test(body.resume)) return send(400, { error: 'Mã phiên không hợp lệ' });
      const args = body.resume ? ['--resume', body.resume] : body.continue ? ['--continue'] : [];
      const tui = ['default', 'fullscreen'].includes(body.tui) ? body.tui : null;
      return send(200, sessions.create({ cwd: body.cwd, args, mcp: mcpSelection(body.cwd, body.mcp), tui }));
    }
    if (route === 'POST /api/shells') {
      if (!body.cwd || !fs.existsSync(body.cwd)) return send(400, { error: 'Thư mục không tồn tại' });
      return send(200, shells.create({ cwd: body.cwd, kind: body.kind }));
    }
    const shellMatch = url.pathname.match(/^\/api\/shells\/(sh-[\w-]+)$/);
    if (shellMatch && req.method === 'DELETE') {
      shells.remove(shellMatch[1]);
      return send(200, { ok: true });
    }
    if (sessionMatch) {
      const [, id, action] = sessionMatch;
      if (req.method === 'POST' && action === 'restart') {
        const s = sessions.sessions.get(id);
        if (!s) return send(404, { error: 'Không tìm thấy phiên' });
        const change = {};
        if ('mcp' in body) change.mcp = mcpSelection(s.cwd, body.mcp);
        if ('skills' in body) change.skills = skills.validate(body.skills);
        return send(200, sessions.restart(id, change));
      }
      if (req.method === 'POST' && action === 'image') {
        const s = sessions.sessions.get(id);
        if (!s) return send(404, { error: 'Không tìm thấy phiên' });
        if (s.status === 'exited') return send(409, { error: 'Phiên đã thoát' });
        await clipboard.setClipboardImage(Buffer.from(String(body.data || ''), 'base64'), body.type);
        sessions.write(id, clipboard.IMAGE_PASTE_KEY); // Claude reads the image back from the clipboard
        return send(200, { ok: true });
      }
      if (req.method === 'POST' && action === 'name') sessions.rename(id, body.name);
      else if (req.method === 'POST' && action === 'kill') sessions.kill(id);
      else if (req.method === 'POST' && action === 'read') sessions.markRead(id);
      else if (req.method === 'DELETE' && !action) sessions.remove(id);
      else return send(404, { error: 'Không có route này' });
      return send(200, { ok: true });
    }
    return send(404, { error: 'Không có route này' });
  }

  const server = http.createServer((req, res) => {
    if (!trusted(req)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname.startsWith('/api/')) {
      if (req.headers['x-hub-token'] !== token) {
        res.writeHead(401);
        return res.end('Unauthorized');
      }
      // largest legit body is an image upload (20 MB, base64 in JSON)
      const limit = clipboard.MAX_IMAGE * 1.4 + 4096;
      let raw = '';
      let tooBig = false;
      req.on('data', chunk => {
        if (tooBig) return;
        raw += chunk;
        if (raw.length > limit) { tooBig = true; raw = ''; }
      });
      req.on('end', () => {
        if (tooBig) {
          res.writeHead(413, { 'content-type': 'application/json; charset=utf-8' });
          return res.end(JSON.stringify({ error: 'Dữ liệu gửi lên quá lớn' }));
        }
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch { /* empty body */ }
        api(req, res, url, body).catch(err => {
          res.writeHead(err.status || 500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err.message }));
        });
      });
      return;
    }

    let file = STATIC[url.pathname];
    // CodeMirror ships as many small files (modes, addons); serve them from its package folder
    if (!file && url.pathname.startsWith('/vendor/cm/')) {
      const rel = path.normalize(decodeURIComponent(url.pathname.slice('/vendor/cm/'.length)));
      const full = path.join(CODEMIRROR, rel);
      if (!rel.startsWith('..') && !path.isAbsolute(rel) && /\.(js|css)$/.test(rel) && fs.existsSync(full)) file = full;
    }
    if (!file) {
      res.writeHead(404);
      return res.end('Not found');
    }
    let content = fs.readFileSync(file);
    if (url.pathname === '/') content = content.toString().replace('__HUB_TOKEN__', token);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(content);
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (!trusted(req) || url.pathname !== '/ws' || url.searchParams.get('token') !== token) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });

  wss.on('connection', ws => {
    clients.add(ws);
    ws.send(JSON.stringify(projectsMsg()));
    ws.send(JSON.stringify({ type: 'sessions', sessions: sessions.list() }));
    for (const s of sessions.list()) ws.send(JSON.stringify({ type: 'replay', id: s.id, data: sessions.buffer(s.id) }));
    ws.send(JSON.stringify(shellsMsg()));
    for (const s of shells.list()) ws.send(JSON.stringify({ type: 'shell-replay', id: s.id, data: shells.buffer(s.id) }));
    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      const target = shells.has(msg.id) ? shells : sessions;
      if (msg.type === 'input') target.write(msg.id, msg.data);
      else if (msg.type === 'resize') target.resize(msg.id, msg.cols, msg.rows);
    });
    ws.on('close', () => clients.delete(ws));
  });

  function close() {
    clearInterval(timer);
    sessions.killAll();
    shells.killAll();
    for (const ws of clients) ws.close();
    server.close();
  }

  return { server, close, sessions, token };
}

module.exports = { createHub };
