const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { isRepo } = require('./git');

const HOME = process.env.CLAUDE_HUB_HOME || path.join(os.homedir(), '.claude-hub');
const FILE = path.join(HOME, 'config.json');

function load() {
  try {
    const cfg = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return { projects: Array.isArray(cfg.projects) ? cfg.projects : [] };
  } catch {
    return { projects: [] };
  }
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

module.exports = { HOME, load, save, findRepos, addProjects, removeProject, samePath };
