const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { samePath } = require('./config');

const ROOT = process.env.CLAUDE_HUB_HISTORY_ROOT || path.join(os.homedir(), '.claude', 'projects');
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Claude Code names each project folder after the cwd with every non-alphanumeric char replaced by '-'.
// Drive letter case varies (d--x vs D--x), so match case-insensitively.
function projectDirs(cwd, root) {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase();
  let names;
  try { names = fs.readdirSync(root); } catch { return []; }
  return names.filter(n => n.toLowerCase() === slug).map(n => path.join(root, n));
}

// Text the user actually typed: skip tool results and IDE/command wrappers like <ide_opened_file>.
function promptText(message) {
  const content = message?.content;
  const parts = typeof content === 'string' ? [content] : Array.isArray(content) ? content.filter(c => c.type === 'text').map(c => c.text) : [];
  const text = parts.map(t => t.replace(/<([\w-]+)>[\s\S]*?<\/\1>/g, '')).join(' ').replace(/\s+/g, ' ').trim();
  return text;
}

function parseSession(file) {
  const out = { id: path.basename(file, '.jsonl'), title: '', firstPrompt: '', lastPrompt: '', prompts: 0, gitBranch: '', cwd: '', startedAt: 0 };
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (o.type === 'ai-title' && o.aiTitle) out.title = o.aiTitle;
    else if (o.type === 'custom-title' && o.customTitle) out.title = o.customTitle;
    else if (o.type === 'last-prompt' && o.lastPrompt) out.lastPrompt = o.lastPrompt;
    else if (o.type === 'user' && !o.isSidechain && !o.isMeta) {
      const text = promptText(o.message);
      if (text) {
        out.prompts++;
        if (!out.firstPrompt) out.firstPrompt = text;
      }
    }
    if (o.cwd && !out.cwd) out.cwd = o.cwd;
    if (o.gitBranch) out.gitBranch = o.gitBranch;
    if (o.timestamp && !out.startedAt) out.startedAt = Date.parse(o.timestamp) || 0;
  }
  return out;
}

const cache = new Map(); // file -> { key, value }

// Saved Claude Code sessions for a directory, newest first.
function listHistory(cwd, root = ROOT) {
  const result = [];
  for (const dir of projectDirs(cwd, root)) {
    let files;
    try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl') && ID_RE.test(f.slice(0, -6))); } catch { continue; }
    for (const f of files) {
      const file = path.join(dir, f);
      let st;
      try { st = fs.statSync(file); } catch { continue; }
      const key = `${st.mtimeMs}:${st.size}`;
      let hit = cache.get(file);
      if (!hit || hit.key !== key) {
        hit = { key, value: parseSession(file) };
        cache.set(file, hit);
      }
      const s = hit.value;
      // different paths can share a slug (a_b vs a-b); trust the cwd recorded in the file
      if (!s.prompts || (s.cwd && !samePath(s.cwd, cwd))) continue;
      result.push({ ...s, updatedAt: st.mtimeMs });
    }
  }
  return result.sort((a, b) => b.updatedAt - a.updatedAt);
}

// Whether Claude Code has saved anything for this conversation yet (it writes the file on the first message).
function hasSession(cwd, id, root = ROOT) {
  if (!ID_RE.test(id || '')) return false;
  return projectDirs(cwd, root).some(dir => fs.existsSync(path.join(dir, `${id}.jsonl`)));
}

module.exports = { listHistory, hasSession, promptText, ID_RE };
