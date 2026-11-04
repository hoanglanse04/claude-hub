const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { samePath } = require('./config');

const CLAUDE_DIR = process.env.CLAUDE_HUB_CLAUDE_DIR || path.join(os.homedir(), '.claude');
// skill names end up inside permission rules like Skill(name), so keep them plain
const NAME_RE = /^[\w.-]+(:[\w.-]+)?$/;
const PLUGIN_RE = /^[\w.-]+@[\w.-]+$/;

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// "---\nname: x\ndescription: \"...\"\n---" -> { name, description }
function frontmatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

// Every <dir>/<skill>/SKILL.md, with a rough token cost of what Claude keeps in context (name + description).
function readSkillDir(dir, prefix = '') {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    let text;
    try { text = fs.readFileSync(path.join(dir, e.name, 'SKILL.md'), 'utf8'); } catch { continue; }
    const fm = frontmatter(text);
    const name = fm.name || e.name;
    const description = fm.description || '';
    out.push({ name: prefix + name, description, tokens: Math.ceil((name.length + description.length) / 4) });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function pluginSkills(installPath, pluginName) {
  const manifest = readJSON(path.join(installPath, '.claude-plugin', 'plugin.json')) || {};
  const dirs = ['skills', ...[].concat(manifest.skills || [])].map(d => path.resolve(installPath, d));
  const seen = new Map();
  for (const dir of new Set(dirs)) for (const s of readSkillDir(dir, `${pluginName}:`)) seen.set(s.name, s);
  return [...seen.values()];
}

// `claude plugin list --json` run in cwd: plugins installed for that folder and whether they are on there.
function listPlugins(claudeCommand, cwd) {
  return new Promise(resolve => {
    execFile(claudeCommand, ['plugin', 'list', '--json'], { cwd, timeout: 60000, windowsHide: true }, (err, stdout) => {
      let list;
      try { list = JSON.parse(String(stdout || '[]')); } catch { list = []; }
      resolve(Array.isArray(list) ? list : []);
    });
  });
}

async function available(claudeCommand, cwd, { claudeDir = CLAUDE_DIR, list = listPlugins } = {}) {
  const plugins = (await list(claudeCommand, cwd))
    .filter(p => p.scope === 'user' || (p.projectPath && samePath(p.projectPath, cwd)))
    .map(p => {
      const name = String(p.id).split('@')[0];
      return { id: p.id, name, version: p.version, scope: p.scope, enabled: !!p.enabled, skills: pluginSkills(p.installPath, name) };
    });
  const skills = [
    ...readSkillDir(path.join(claudeDir, 'skills')).map(s => ({ ...s, scope: 'user' })),
    ...readSkillDir(path.join(cwd, '.claude', 'skills')).map(s => ({ ...s, scope: 'project' })),
  ];
  return { plugins, skills };
}

// null = Claude Code defaults; otherwise { plugins: { id: bool }, off: [skill names] }
function validate(sel) {
  if (sel == null) return null;
  if (typeof sel !== 'object') throw new Error('Cấu hình skill không hợp lệ');
  const plugins = {};
  for (const [id, on] of Object.entries(sel.plugins || {})) {
    if (!PLUGIN_RE.test(id)) throw new Error(`Plugin không hợp lệ: ${id}`);
    plugins[id] = !!on;
  }
  const off = [...new Set([].concat(sel.off || []).map(String))];
  const bad = off.filter(n => !NAME_RE.test(n));
  if (bad.length) throw new Error(`Tên skill không hợp lệ: ${bad.join(', ')}`);
  return { plugins, off };
}

// Settings layered on top of the hook settings for one session (passed with --settings).
// skillOverrides removes a standalone skill from Claude's context; plugin skills ignore it,
// so the deny rule is what actually blocks those.
function sessionSettings(base, sel) {
  if (!sel) return base;
  const out = { ...base, enabledPlugins: { ...sel.plugins } };
  if (sel.off.length) {
    out.skillOverrides = Object.fromEntries(sel.off.map(n => [n, 'off']));
    out.permissions = { deny: sel.off.map(n => `Skill(${n})`) };
  }
  return out;
}

module.exports = { frontmatter, readSkillDir, pluginSkills, listPlugins, available, validate, sessionSettings };
