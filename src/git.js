const { execFile } = require('node:child_process');
const path = require('node:path');

function git(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim()));
      resolve(stdout);
    });
  });
}

// Output of `git worktree list --porcelain`
function parseWorktrees(text) {
  const result = [];
  let cur = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      cur = { path: path.resolve(line.slice(9)), branch: null, head: null, bare: false, detached: false };
      result.push(cur);
    } else if (!cur) {
      continue;
    } else if (line.startsWith('HEAD ')) {
      cur.head = line.slice(5);
    } else if (line.startsWith('branch ')) {
      cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    } else if (line === 'bare') {
      cur.bare = true;
    } else if (line === 'detached') {
      cur.detached = true;
    }
  }
  return result.filter(w => !w.bare);
}

// Output of `git status --porcelain=v1`
function parseStatus(text) {
  const files = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.length < 4) continue;
    const code = line.slice(0, 2);
    let file = line.slice(3);
    const arrow = file.indexOf(' -> ');
    if (arrow !== -1) file = file.slice(arrow + 4);
    files.push({ code: code.trim() || code, file: file.replace(/^"(.*)"$/, '$1') });
  }
  return files;
}

async function isRepo(dir) {
  try {
    const out = await git(dir, ['rev-parse', '--show-toplevel']);
    return path.resolve(out.trim());
  } catch {
    return null;
  }
}

async function listWorktrees(repo) {
  return parseWorktrees(await git(repo, ['worktree', 'list', '--porcelain']));
}

async function changedFiles(dir) {
  return parseStatus(await git(dir, ['status', '--porcelain=v1']));
}

async function diff(dir, file) {
  const tracked = await git(dir, ['diff', 'HEAD', '--', file]).catch(() => '');
  if (tracked.trim()) return tracked;
  // untracked file: show it as a whole-file addition
  return git(dir, ['diff', '--no-index', '--', process.platform === 'win32' ? 'NUL' : '/dev/null', file])
    .catch(err => err.message);
}

function worktreeDirFor(repo, branch) {
  const safe = branch.replace(/[^\w.-]+/g, '-');
  return path.join(path.dirname(repo), `${path.basename(repo)}.wt`, safe);
}

async function addWorktree(repo, branch) {
  const dir = worktreeDirFor(repo, branch);
  const exists = await git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).then(() => true, () => false);
  await git(repo, exists ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir]);
  return dir;
}

module.exports = { parseWorktrees, parseStatus, isRepo, listWorktrees, changedFiles, diff, addWorktree, worktreeDirFor };
