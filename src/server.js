const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { WebSocketServer } = require('ws');
const git = require('./git');
const config = require('./config');
const { SessionManager } = require('./sessions');

const PUBLIC = path.join(__dirname, '..', 'public');
const MODULES = path.join(__dirname, '..', 'node_modules');
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
  const sessions = new SessionManager({ hookSettingsFile: path.join(config.HOME, 'hook-settings.json'), port, token });
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
        }
        return { path: repo, name, worktrees };
      } catch (err) {
        return { path: repo, name, worktrees: [], error: err.message };
      }
    }));
  }

  let scanning = null;
  function refreshProjects() {
    if (!scanning) {
      scanning = scanProjects().then(result => {
        projects = result;
        const json = JSON.stringify(result);
        if (json !== projectsJSON) {
          projectsJSON = json;
          broadcast({ type: 'projects', projects });
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
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([\w-]+)(?:\/(kill|read))?$/);

    if (route === 'POST /api/hook') {
      sessions.applyEvent(body.sid, body.event, body.payload || {});
      return send(200, { ok: true });
    }
    if (route === 'GET /api/state') {
      await refreshProjects();
      return send(200, { projects, sessions: sessions.list() });
    }
    if (route === 'POST /api/refresh') {
      await refreshProjects();
      return send(200, { ok: true });
    }
    if (route === 'POST /api/projects') {
      if (!body.path || !fs.existsSync(body.path)) return send(400, { error: 'Thư mục không tồn tại' });
      const added = await config.addProjects(cfg, body.path);
      if (!added.length) return send(400, { error: 'Không tìm thấy git repo mới trong thư mục này' });
      config.save(cfg);
      await refreshProjects();
      return send(200, { added });
    }
    if (route === 'DELETE /api/projects') {
      config.removeProject(cfg, body.path);
      config.save(cfg);
      await refreshProjects();
      return send(200, { ok: true });
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
    if (route === 'POST /api/open') {
      openTool(body.cwd, body.tool);
      return send(200, { ok: true });
    }
    if (route === 'POST /api/sessions') {
      if (!body.cwd || !fs.existsSync(body.cwd)) return send(400, { error: 'Thư mục không tồn tại' });
      const args = body.continue ? ['--continue'] : [];
      return send(200, sessions.create({ cwd: body.cwd, args }));
    }
    if (sessionMatch) {
      const [, id, action] = sessionMatch;
      if (req.method === 'POST' && action === 'kill') sessions.kill(id);
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
      let raw = '';
      req.on('data', chunk => { raw += chunk; });
      req.on('end', () => {
        let body = {};
        try { body = raw ? JSON.parse(raw) : {}; } catch { /* empty body */ }
        api(req, res, url, body).catch(err => {
          res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err.message }));
        });
      });
      return;
    }

    const file = STATIC[url.pathname];
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
    ws.send(JSON.stringify({ type: 'projects', projects }));
    ws.send(JSON.stringify({ type: 'sessions', sessions: sessions.list() }));
    for (const s of sessions.list()) ws.send(JSON.stringify({ type: 'replay', id: s.id, data: sessions.buffer(s.id) }));
    ws.on('message', raw => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.type === 'input') sessions.write(msg.id, msg.data);
      else if (msg.type === 'resize') sessions.resize(msg.id, msg.cols, msg.rows);
    });
    ws.on('close', () => clients.delete(ws));
  });

  function close() {
    clearInterval(timer);
    sessions.killAll();
    for (const ws of clients) ws.close();
    server.close();
  }

  return { server, close, sessions, token };
}

module.exports = { createHub };
