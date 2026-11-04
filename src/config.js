const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { isRepo } = require('./git');

const HOME = process.env.CLAUDE_HUB_HOME || path.join(os.homedir(), '.claude-hub');
const FILE = path.join(HOME, 'config.json');

function load() {
  try {
    const cfg = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      projects: Array.isArray(cfg.projects) ? cfg.projects : [],
      workspaces: Array.isArray(cfg.workspaces) ? cfg.workspaces : [],
      aliases: cfg.aliases && typeof cfg.aliases === 'object' ? cfg.aliases : {},
    };
  } catch {
    return { projects: [], workspaces: [], aliases: {} };
  }
}

// Display names the user gave to a repo or worktree folder, keyed by normalized path.
const aliasKey = dir => path.resolve(dir).toLowerCase();

function aliasOf(cfg, dir) {
  return cfg.aliases?.[aliasKey(dir)] || '';
}

function setAlias(cfg, dir, name) {
  cfg.aliases ??= {};
  const clean = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (clean) cfg.aliases[aliasKey(dir)] = clean;
  else delete cfg.aliases[aliasKey(dir)];
  return clean;
}

function save(cfg) {
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(cfg, null, 2));
}

// A repo path adds that repo; any other folder adds every repo found up to two levels below it.
// folders that never hold a repo of their own but can be huge
const SKIP_DIRS = new Set(['node_modules', 'bin', 'obj', 'dist', 'build', 'target', 'packages-cache']);

// dir has its own repository: a .git folder, or a submodule's .git file. A linked worktree also has a
// .git file, but it points into another repo's worktrees/ and is shown under that repo instead.
function hasOwnGit(dir) {
  const dotGit = path.join(dir, '.git');
  try {
    if (fs.statSync(dotGit).isDirectory()) return true;
    return !/[\\/]worktrees[\\/]/.test(fs.readFileSync(dotGit, 'utf8'));
  } catch {
    return false;
  }
}

// Repos below a repo folder (not the folder itself), up to two levels down,
// e.g. a parent repo that keeps ris_admin_v1 and ris_api_v1 as separate repos inside it.
function nestedRepos(dir, depth = 2) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    const child = path.join(dir, e.name);
    if (hasOwnGit(child)) found.push(child);
    else if (depth > 1) found.push(...nestedRepos(child, depth - 1));
  }
  return found;
}

async function findRepos(dir, depth = 2) {
  const top = await isRepo(dir);
  if (top) return [top, ...nestedRepos(top)];
  if (depth === 0) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name === 'node_modules') continue;
    const child = path.join(dir, e.name);
    if (fs.existsSync(path.join(child, '.git')) || depth > 1) found.push(...await findRepos(child, depth - 1));
  }
  return [...new Set(found)];
}

function samePath(a, b) {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

async function addProjects(cfg, dir) {
  const repos = await findRepos(path.resolve(dir));
  const added = repos.filter(r => !cfg.projects.some(p => samePath(p, r)));
  for (const repo of added) insertProject(cfg, repo);
  return added;
}

// A repo inside another registered repo goes right after it (and its other children) in the sidebar.
function insertProject(cfg, repo) {
  const parent = cfg.projects.findLastIndex(p => !samePath(p, repo) && isInside(repo, p));
  if (parent === -1) return cfg.projects.push(repo);
  let at = parent + 1;
  while (at < cfg.projects.length && isInside(cfg.projects[at], cfg.projects[parent])) at++;
  cfg.projects.splice(at, 0, repo);
}

// Projects added before nested repos were picked up: register their inner repos too.
function addNestedProjects(cfg) {
  const added = [];
  for (const repo of [...cfg.projects]) {
    if (!fs.existsSync(repo)) continue;
    for (const inner of nestedRepos(repo)) {
      if (cfg.projects.some(p => samePath(p, inner))) continue;
      insertProject(cfg, inner);
      added.push(inner);
    }
  }
  return added;
}

function removeProject(cfg, dir) {
  cfg.projects = cfg.projects.filter(p => !samePath(p, dir));
}

// A folder that is not itself inside a repo but holds repos becomes a workspace,
// so a Claude session can be opened there to work across all of them.
async function addWorkspace(cfg, dir) {
  const full = path.resolve(dir);
  cfg.workspaces ??= [];
  if (await isRepo(full)) return false;
  if (cfg.workspaces.some(w => samePath(w, full))) return false;
  if (!(await findRepos(full)).length) return false;
  cfg.workspaces.push(full);
  return true;
}

function removeWorkspace(cfg, dir) {
  cfg.workspaces = (cfg.workspaces || []).filter(w => !samePath(w, dir));
}

// path is dir itself or somewhere below it
function isInside(child, dir) {
  const rel = path.relative(path.resolve(dir), path.resolve(child));
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Markers Claude Code sets for its own child processes. If the hub was started from inside a Claude
// session, passing them on makes every hub session think it is a sub-session (and stop saving transcripts).
const PARENT_SESSION_VARS = [
  'CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_EFFORT',
  'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN',
];

function childEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of PARENT_SESSION_VARS) delete env[k];
  return { ...env, ...extra };
}

module.exports = { HOME, load, save, findRepos, nestedRepos, addNestedProjects, addProjects, removeProject, addWorkspace, removeWorkspace, isInside, samePath, aliasOf, setAlias, childEnv };
