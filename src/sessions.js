const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require('@lydell/node-pty');
const { nextStatus, shouldNotify } = require('./status');
const mcp = require('./mcp');
const history = require('./history');

const MAX_BUFFER = 2 * 1024 * 1024;

function claudeCommand() {
  if (process.env.CLAUDE_HUB_CLAUDE) return process.env.CLAUDE_HUB_CLAUDE;
  const native = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  if (fs.existsSync(native)) return native;
  return process.platform === 'win32' ? 'claude.exe' : 'claude';
}

// Settings file passed with --settings so only hub-launched sessions report back.
function writeHookSettings(file) {
  const node = process.execPath.replace(/\\/g, '/');
  const report = path.join(__dirname, '..', 'hooks', 'report.js').replace(/\\/g, '/');
  const hook = event => [{ hooks: [{ type: 'command', command: `"${node}" "${report}" ${event}`, timeout: 5 }] }];
  const settings = {
    hooks: {
      SessionStart: hook('SessionStart'), // gives us the Claude session id before the first prompt
      UserPromptSubmit: hook('UserPromptSubmit'),
      PreToolUse: [{ matcher: '*', ...hook('PreToolUse')[0] }],
      PostToolUse: [{ matcher: '*', ...hook('PostToolUse')[0] }],
      Notification: hook('Notification'),
      Stop: hook('Stop'),
    },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
}

class SessionManager extends EventEmitter {
  constructor({ hookSettingsFile, port, token }) {
    super();
    this.hookSettingsFile = hookSettingsFile;
    this.port = port;
    this.token = token;
    this.sessions = new Map();
    writeHookSettings(hookSettingsFile);
  }

  // mcp: null = whatever Claude Code would load in cwd; an array = only those servers (--strict-mcp-config)
  create({ cwd, args = [], mcp = null }) {
    const id = crypto.randomUUID().slice(0, 8);
    const s = {
      id, cwd, status: 'idle', title: '', lastMessage: '', unread: false, startedAt: Date.now(), updatedAt: Date.now(),
      baseArgs: args, mcp, mcpUsed: {}, claudeSessionId: null, proc: null, buffer: '',
    };
    this.sessions.set(id, s);
    this.spawn(s, args);
    this.emit('change');
    return this.toJSON(s);
  }

  mcpConfigFile(id) {
    return path.join(path.dirname(this.hookSettingsFile), 'mcp', `${id}.json`);
  }

  spawn(s, args) {
    const extra = s.mcp ? ['--mcp-config', mcp.writeSessionConfig(this.mcpConfigFile(s.id), s.cwd, s.mcp), '--strict-mcp-config'] : [];
    const proc = pty.spawn(claudeCommand(), ['--settings', this.hookSettingsFile, ...extra, ...args], {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd: s.cwd,
      env: { ...process.env, CLAUDE_HUB_SID: s.id, CLAUDE_HUB_PORT: String(this.port), CLAUDE_HUB_TOKEN: this.token },
    });
    s.proc = proc;
    // after a restart the old process still reports for a moment; ignore it
    proc.onData(data => {
      if (s.proc !== proc) return;
      s.buffer += data;
      if (s.buffer.length > MAX_BUFFER) s.buffer = s.buffer.slice(-MAX_BUFFER);
      this.emit('data', s.id, data);
    });
    proc.onExit(({ exitCode }) => {
      if (s.proc !== proc) return;
      s.exitCode = exitCode;
      this.applyEvent(s.id, 'exit');
    });
  }

  // Claude Code reads MCP servers only at startup, so changing them means relaunching;
  // --resume keeps the same conversation when we already know its id.
  restart(id, { mcp: names = null } = {}) {
    const s = this.sessions.get(id);
    if (!s) throw new Error('Không tìm thấy phiên');
    const old = s.proc;
    const wasRunning = s.status !== 'exited';
    s.mcp = names;
    s.mcpUsed = {};
    s.status = 'idle';
    s.unread = false;
    s.updatedAt = Date.now();
    const note = `\r\n\x1b[33m── Khởi động lại phiên với ${names ? `${names.length} MCP đã chọn` : 'MCP mặc định'} ──\x1b[0m\r\n`;
    s.buffer += note;
    this.emit('data', id, note);
    const resumable = s.claudeSessionId && (this.hasSession ?? history.hasSession)(s.cwd, s.claudeSessionId);
    this.spawn(s, resumable ? ['--resume', s.claudeSessionId] : s.baseArgs);
    if (wasRunning) old.kill();
    this.emit('change');
    return this.toJSON(s);
  }

  applyEvent(id, event, payload = {}) {
    const s = this.sessions.get(id);
    if (!s) return;
    let changed = false;
    if (event === 'UserPromptSubmit' && payload.prompt) s.title = String(payload.prompt).replace(/\s+/g, ' ').slice(0, 120);
    if (event === 'Notification' && payload.message) s.lastMessage = String(payload.message).slice(0, 200);
    if (payload.claudeSessionId && payload.claudeSessionId !== s.claudeSessionId) {
      s.claudeSessionId = payload.claudeSessionId;
      changed = true;
    }
    const server = event === 'PreToolUse' ? mcp.serverOfTool(payload.tool) : null;
    if (server) {
      changed ||= !s.mcpUsed[server];
      s.mcpUsed[server] = (s.mcpUsed[server] || 0) + 1;
    }
    const prev = s.status;
    const next = nextStatus(prev, event);
    if (prev === next) {
      if (changed) this.emit('change');
      return;
    }
    s.status = next;
    s.updatedAt = Date.now();
    if (shouldNotify(prev, next)) {
      s.unread = true;
      this.emit('notify', this.toJSON(s));
    }
    this.emit('change');
  }

  rename(id, name) {
    const s = this.sessions.get(id);
    if (!s) return;
    s.name = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    this.emit('change');
  }

  markRead(id) {
    const s = this.sessions.get(id);
    if (s && s.unread) {
      s.unread = false;
      this.emit('change');
    }
  }

  write(id, data) {
    const s = this.sessions.get(id);
    if (s && s.status !== 'exited') s.proc.write(data);
  }

  resize(id, cols, rows) {
    const s = this.sessions.get(id);
    if (s && s.status !== 'exited' && cols > 0 && rows > 0) {
      try { s.proc.resize(cols, rows); } catch { /* process already gone */ }
    }
  }

  kill(id) {
    const s = this.sessions.get(id);
    if (s && s.status !== 'exited') s.proc.kill();
  }

  remove(id) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (s.status !== 'exited') s.proc.kill();
    this.sessions.delete(id);
    fs.rm(this.mcpConfigFile(id), { force: true }, () => {});
    this.emit('change');
  }

  killAll() {
    for (const s of this.sessions.values()) if (s.status !== 'exited') s.proc.kill();
  }

  buffer(id) {
    return this.sessions.get(id)?.buffer ?? '';
  }

  toJSON(s) {
    const { proc, buffer, ...rest } = s;
    return rest;
  }

  list() {
    return [...this.sessions.values()].map(s => this.toJSON(s));
  }
}

module.exports = { SessionManager, writeHookSettings, claudeCommand };
