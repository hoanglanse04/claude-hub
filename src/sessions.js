const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const pty = require('@lydell/node-pty');
const { nextStatus, shouldNotify } = require('./status');

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

  create({ cwd, args = [] }) {
    const id = crypto.randomUUID().slice(0, 8);
    const proc = pty.spawn(claudeCommand(), ['--settings', this.hookSettingsFile, ...args], {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd,
      env: { ...process.env, CLAUDE_HUB_SID: id, CLAUDE_HUB_PORT: String(this.port), CLAUDE_HUB_TOKEN: this.token },
    });
    const s = { id, cwd, status: 'idle', title: '', lastMessage: '', unread: false, startedAt: Date.now(), updatedAt: Date.now(), proc, buffer: '' };
    this.sessions.set(id, s);
    proc.onData(data => {
      s.buffer += data;
      if (s.buffer.length > MAX_BUFFER) s.buffer = s.buffer.slice(-MAX_BUFFER);
      this.emit('data', id, data);
    });
    proc.onExit(({ exitCode }) => {
      s.exitCode = exitCode;
      this.applyEvent(id, 'exit');
    });
    this.emit('change');
    return this.toJSON(s);
  }

  applyEvent(id, event, payload = {}) {
    const s = this.sessions.get(id);
    if (!s) return;
    if (event === 'UserPromptSubmit' && payload.prompt) s.title = String(payload.prompt).replace(/\s+/g, ' ').slice(0, 120);
    if (event === 'Notification' && payload.message) s.lastMessage = String(payload.message).slice(0, 200);
    const prev = s.status;
    const next = nextStatus(prev, event);
    if (prev === next) return;
    s.status = next;
    s.updatedAt = Date.now();
    if (shouldNotify(prev, next)) {
      s.unread = true;
      this.emit('notify', this.toJSON(s));
    }
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
