const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { samePath } = require('./config');

const CLAUDE_JSON = process.env.CLAUDE_HUB_CLAUDE_JSON || path.join(os.homedir(), '.claude.json');

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// MCP servers Claude Code would load in cwd, with the scope that wins (local > project > user).
// Returns full configs; use publicInfo() before sending anything to the browser.
function available(cwd, claudeJson = CLAUDE_JSON) {
  const servers = new Map();
  const put = (scope, entries) => {
    for (const [name, config] of Object.entries(entries || {})) servers.set(name, { name, scope, config });
  };
  const global = readJSON(claudeJson) || {};
  put('user', global.mcpServers);
  put('project', readJSON(path.join(cwd, '.mcp.json'))?.mcpServers);
  for (const [dir, p] of Object.entries(global.projects || {})) {
    if (samePath(dir, cwd)) put('local', p.mcpServers);
  }
  return [...servers.values()];
}

// What the UI may see: no env, headers or args that could carry secrets.
function publicInfo(server) {
  const c = server.config || {};
  const type = c.type || (c.url ? 'http' : 'stdio');
  let target = '';
  if (c.url) {
    try { target = new URL(c.url).host; } catch { target = ''; }
  } else {
    // "cmd /c npx -y @playwright/mcp@latest" -> "@playwright/mcp@latest"
    const parts = [c.command, ...(c.args || [])].filter(Boolean).map(String);
    target = parts.find(a => a.startsWith('@') || /mcp/i.test(a)) || path.basename(parts[0] || '');
  }
  return { name: server.name, scope: server.scope, type, target };
}

// Per-session --mcp-config file holding only the chosen servers.
function writeSessionConfig(file, cwd, names) {
  const chosen = new Set(names);
  const mcpServers = {};
  for (const s of available(cwd)) if (chosen.has(s.name)) mcpServers[s.name] = s.config;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ mcpServers }, null, 2));
  return file;
}

// "playwright: cmd /c npx ... - ✔ Connected" -> { playwright: { ok: true, detail: 'Connected' } }
function parseList(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(': ');
    const dash = line.lastIndexOf(' - ');
    if (colon < 1 || dash < colon) continue;
    const name = line.slice(0, colon).trim();
    const status = line.slice(dash + 3).trim();
    out[name] = { ok: /^[✔✓]/.test(status), pending: /^⏸/.test(status), detail: status.replace(/^[✔✓✘✗⏸!]\s*/, '') };
  }
  return out;
}

// Runs `claude mcp list` in cwd; it starts every configured server once, so it takes a few seconds.
function health(claudeCommand, cwd) {
  return new Promise(resolve => {
    execFile(claudeCommand, ['mcp', 'list'], { cwd, timeout: 90000, windowsHide: true }, (err, stdout) => {
      resolve(parseList(String(stdout || '')));
    });
  });
}

// "mcp__playwright__browser_click" -> "playwright"
function serverOfTool(tool) {
  const m = /^mcp__(.+?)__/.exec(tool || '');
  return m ? m[1] : null;
}

module.exports = { available, publicInfo, writeSessionConfig, parseList, health, serverOfTool };
