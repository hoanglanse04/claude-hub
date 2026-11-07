const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { IGNORED, MAX_SIZE } = require('./files');

// Listing and searching a whole project, VS Code style: inside a git repo the list follows
// .gitignore (git ls-files), outside one we walk the folders and skip the usual noise.
const MAX_FILES = 100000;
// Build output and dependency folders that git usually ignores; skipped when walking by hand.
const WALK_SKIP = new Set([...IGNORED, 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', 'packages', '.cache', '.playwright-mcp']);

function gitLsFiles(dir) {
  return new Promise(resolve => {
    execFile('git', ['-C', dir, 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--deduplicate'],
      { maxBuffer: 256 * 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve(err ? null : stdout.split('\0').filter(Boolean)));
  });
}

const isRepo = dir => fs.existsSync(path.join(dir, '.git'));

// Relative paths (with "/" separators) of the files under root.
async function listFiles(root, { limit = MAX_FILES } = {}) {
  const out = [];
  const add = rel => { if (out.length < limit) out.push(rel); };

  async function viaGit(dir, prefix) {
    const names = await gitLsFiles(dir);
    if (!names) return walk(dir, prefix);
    for (const name of names) {
      if (out.length >= limit) return;
      // an untracked folder that git reports as a whole ("sub/") is a nested repo
      if (name.endsWith('/')) {
        const sub = path.join(dir, name);
        if (isRepo(sub)) await viaGit(sub, prefix + name);
        continue;
      }
      add(prefix + name);
    }
  }

  async function walk(dir, prefix) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= limit) return;
      if (e.isDirectory()) {
        if (WALK_SKIP.has(e.name)) continue;
        const sub = path.join(dir, e.name);
        if (isRepo(sub)) await viaGit(sub, `${prefix}${e.name}/`);
        else await walk(sub, `${prefix}${e.name}/`);
      } else if (e.isFile()) {
        add(prefix + e.name);
      }
    }
  }

  await (isRepo(root) ? viaGit(root, '') : walk(root, ''));
  return { files: out, truncated: out.length >= limit };
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildMatcher(query, { regex = false, caseSensitive = false, wholeWord = false } = {}) {
  let src = regex ? query : escapeRegExp(query);
  if (wholeWord) src = `\\b(?:${src})\\b`;
  return new RegExp(src, caseSensitive ? 'g' : 'gi');
}

// Converts a simple glob list ("*.cs, src/**") into a test on relative paths.
function globTest(globs) {
  const list = String(globs || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!list.length) return null;
  const res = list.map(g => {
    const body = g.replace(/\\/g, '/').split('**').map(part => part.split('*').map(p => p.split('?').map(escapeRegExp).join('[^/]')).join('[^/]*')).join('.*');
    // a pattern without "/" matches the file name anywhere (like VS Code); otherwise the path
    return g.includes('/') ? new RegExp(`^${body}(/.*)?$`, 'i') : new RegExp(`(^|/)${body}(/.*)?$`, 'i');
  });
  return rel => res.some(r => r.test(rel));
}

const MAX_LINE = 300;

// Searches every text file under root. Stops after maxMatches matching lines.
async function searchText(root, query, opts = {}) {
  const { maxMatches = 2000, include, exclude } = opts;
  if (!query) return { results: [], matches: 0, files: 0, truncated: false };
  const re = buildMatcher(query, opts);
  const inc = globTest(include);
  const exc = globTest(exclude);
  const { files } = await listFiles(root);
  const results = [];
  let matches = 0;
  let truncated = false;
  let scanned = 0;
  for (const rel of files) {
    if (inc && !inc(rel)) continue;
    if (exc && exc(rel)) continue;
    const full = path.join(root, rel);
    let buf;
    try {
      const st = fs.statSync(full);
      if (!st.isFile() || st.size > MAX_SIZE) continue;
      buf = fs.readFileSync(full);
    } catch { continue; }
    if (buf.subarray(0, 8000).includes(0)) continue;
    const lines = buf.toString('utf8').split(/\r?\n/);
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      re.lastIndex = 0;
      const m = re.exec(line);
      if (!m) continue;
      // keep the preview short but centred on the match
      const start = Math.max(0, m.index - 60);
      const text = line.slice(start, start + MAX_LINE);
      hits.push({ line: i + 1, col: m.index, len: Math.max(m[0].length, 1), text, offset: start });
      if (++matches >= maxMatches) { truncated = true; break; }
    }
    if (hits.length) results.push({ file: rel, hits });
    if (truncated) break;
    // let other requests run while a big search is going
    if (++scanned % 200 === 0) await new Promise(r => setImmediate(r));
  }
  return { results, matches, files: results.length, truncated };
}

module.exports = { listFiles, searchText, buildMatcher, globTest };
