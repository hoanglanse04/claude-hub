const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { parseWorktrees, parseStatus, worktreeDirFor } = require('../src/git');
const { nextStatus, shouldNotify } = require('../src/status');

test('parseWorktrees reads branches, detached heads and skips bare', () => {
  const text = [
    'worktree D:/repo', 'HEAD aaa', 'branch refs/heads/main', '',
    'worktree D:/repo.wt/feature-x', 'HEAD bbb', 'branch refs/heads/feature/x', '',
    'worktree D:/repo.wt/old', 'HEAD ccc', 'detached', '',
    'worktree D:/bare', 'bare', '',
  ].join('\n');
  const wts = parseWorktrees(text);
  assert.equal(wts.length, 3);
  assert.equal(wts[0].branch, 'main');
  assert.equal(wts[1].branch, 'feature/x');
  assert.equal(wts[2].detached, true);
  assert.equal(wts[2].branch, null);
});

test('parseStatus handles modified, untracked, renamed and quoted paths', () => {
  const files = parseStatus([' M src/a.cs', '?? new.txt', 'R  old.cs -> renamed.cs', 'A  "with space.cs"', ''].join('\n'));
  assert.deepEqual(files, [
    { code: 'M', file: 'src/a.cs' },
    { code: '??', file: 'new.txt' },
    { code: 'R', file: 'renamed.cs' },
    { code: 'A', file: 'with space.cs' },
  ]);
});

test('worktreeDirFor puts worktrees next to the repo with a safe name', () => {
  assert.equal(worktreeDirFor(path.join('D:', 'src', 'app'), 'feature/login fix'), path.join('D:', 'src', 'app.wt', 'feature-login-fix'));
});

test('status follows the hook lifecycle', () => {
  let s = 'idle';
  s = nextStatus(s, 'Notification');
  assert.equal(s, 'idle', 'idle reminder before any prompt is ignored');
  s = nextStatus(s, 'UserPromptSubmit');
  assert.equal(s, 'running');
  s = nextStatus(s, 'PreToolUse');
  s = nextStatus(s, 'Notification');
  assert.equal(s, 'waiting', 'permission prompt');
  s = nextStatus(s, 'PostToolUse');
  assert.equal(s, 'running', 'approved');
  s = nextStatus(s, 'Stop');
  assert.equal(s, 'done');
  assert.equal(nextStatus(s, 'Notification'), 'done', 'idle reminder after a turn is not a request');
  s = nextStatus(s, 'exit');
  assert.equal(nextStatus(s, 'UserPromptSubmit'), 'exited');
});

test('only waiting and done transitions notify', () => {
  assert.equal(shouldNotify('running', 'waiting'), true);
  assert.equal(shouldNotify('running', 'done'), true);
  assert.equal(shouldNotify('done', 'done'), false);
  assert.equal(shouldNotify('idle', 'running'), false);
  assert.equal(shouldNotify('running', 'exited'), false);
});

test('addProjects finds repos inside a folder and skips duplicates', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-'));
  process.env.CLAUDE_HUB_HOME = path.join(root, '.hub');
  const config = require('../src/config');
  for (const name of ['a', 'group/b']) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', dir]);
  }
  fs.mkdirSync(path.join(root, 'not-a-repo'));
  const cfg = { projects: [] };
  const added = await config.addProjects(cfg, root);
  assert.deepEqual(added.map(p => path.relative(root, p)).sort(), ['a', path.join('group', 'b')]);
  assert.deepEqual(await config.addProjects(cfg, path.join(root, 'a')), []);
  config.removeProject(cfg, path.join(root, 'A'));
  assert.equal(cfg.projects.length, process.platform === 'win32' ? 1 : 2);
  fs.rmSync(root, { recursive: true, force: true });
});
