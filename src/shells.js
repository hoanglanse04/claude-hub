const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const pty = require('@lydell/node-pty');

const MAX_BUFFER = 1024 * 1024;

// Shells the browser may ask for; anything else is rejected so the API can't run arbitrary programs.
function shellCatalog() {
  if (process.platform !== 'win32') {
    return { bash: { label: 'bash', file: process.env.SHELL || '/bin/bash', args: ['-l'] } };
  }
  const root = process.env.SystemRoot || 'C:\\Windows';
  const list = {
    powershell: { label: 'PowerShell', file: path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'] },
    cmd: { label: 'cmd', file: path.join(root, 'System32', 'cmd.exe'), args: [] },
  };
  const pwsh = [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe')].find(f => fs.existsSync(f));
  if (pwsh) list.pwsh = { label: 'pwsh', file: pwsh, args: ['-NoLogo'] };
  const bash = [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe')].find(f => fs.existsSync(f));
  if (bash) list.gitbash = { label: 'Git Bash', file: bash, args: ['--login', '-i'] };
  return list;
}

class ShellManager extends EventEmitter {
  constructor() {
    super();
    this.shells = new Map();
    this.catalog = shellCatalog();
  }

  kinds() {
    return Object.entries(this.catalog).map(([id, s]) => ({ id, label: s.label }));
  }

  create({ cwd, kind }) {
    const def = this.catalog[kind] || Object.values(this.catalog)[0];
    const id = `sh-${crypto.randomUUID().slice(0, 8)}`;
    const proc = pty.spawn(def.file, def.args, { name: 'xterm-256color', cols: 100, rows: 28, cwd, env: process.env });
    const s = { id, cwd, kind: kind in this.catalog ? kind : Object.keys(this.catalog)[0], label: def.label, status: 'running', startedAt: Date.now(), proc, buffer: '' };
    this.shells.set(id, s);
    proc.onData(data => {
      s.buffer += data;
      if (s.buffer.length > MAX_BUFFER) s.buffer = s.buffer.slice(-MAX_BUFFER);
      this.emit('data', id, data);
    });
    proc.onExit(({ exitCode }) => {
      s.status = 'exited';
      s.exitCode = exitCode;
      this.emit('change');
    });
    this.emit('change');
    return this.toJSON(s);
  }

  has(id) {
    return this.shells.has(id);
  }

  write(id, data) {
    const s = this.shells.get(id);
    if (s && s.status !== 'exited') s.proc.write(data);
  }

  resize(id, cols, rows) {
    const s = this.shells.get(id);
    if (s && s.status !== 'exited' && cols > 0 && rows > 0) {
      try { s.proc.resize(cols, rows); } catch { /* process already gone */ }
    }
  }

  remove(id) {
    const s = this.shells.get(id);
    if (!s) return;
    if (s.status !== 'exited') s.proc.kill();
    this.shells.delete(id);
    this.emit('change');
  }

  killAll() {
    for (const s of this.shells.values()) if (s.status !== 'exited') s.proc.kill();
  }

  buffer(id) {
    return this.shells.get(id)?.buffer ?? '';
  }

  toJSON(s) {
    const { proc, buffer, ...rest } = s;
    return rest;
  }

  list() {
    return [...this.shells.values()].map(s => this.toJSON(s));
  }
}

module.exports = { ShellManager, shellCatalog };
