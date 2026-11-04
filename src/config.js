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
async function findRepos(dir, depth = 2) {
  const top = await isRepo(dir);
  if (top) return [top];
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
  cfg.projects.push(...added);
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

module.exports = { HOME, load, save, findRepos, addProjects, removeProject, addWorkspace, removeWorkspace, isInside, samePath, aliasOf, setAlias };
