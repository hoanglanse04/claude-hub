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

test('listHistory reads saved Claude sessions for a cwd, newest first', () => {
  const { listHistory } = require('../src/history');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-hist-'));
  const cwd = path.join(root, 'work', 'my_app');
  const dir = path.join(root, cwd.replace(/[^a-zA-Z0-9]/g, '-').toUpperCase()); // folder case differs from cwd
  fs.mkdirSync(dir, { recursive: true });
  const line = o => JSON.stringify(o);
  const user = (text, extra = {}) => line({ type: 'user', cwd, gitBranch: 'feat/x', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: text }, ...extra });
  const older = '11111111-1111-1111-1111-111111111111';
  const newer = '22222222-2222-2222-2222-222222222222';
  fs.writeFileSync(path.join(dir, `${older}.jsonl`), [
    user([{ type: 'text', text: '<ide_opened_file>x.cs</ide_opened_file>' }, { type: 'text', text: 'sửa lỗi đăng nhập' }]),
    user([{ type: 'tool_result', content: 'ignored' }]),
    line({ type: 'ai-title', aiTitle: 'Lỗi đăng nhập' }),
    line({ type: 'last-prompt', lastPrompt: 'chạy test đi' }),
  ].join('\n'));
  fs.writeFileSync(path.join(dir, `${newer}.jsonl`), user('thêm API') + '\n');
  fs.writeFileSync(path.join(dir, '33333333-3333-3333-3333-333333333333.jsonl'), line({ type: 'queue-operation' }) + '\n'); // no prompts
  fs.writeFileSync(path.join(dir, '44444444-4444-4444-4444-444444444444.jsonl'), user('khác thư mục', { cwd: path.join(root, 'work', 'my-app') }) + '\n');
  const old = new Date(Date.now() - 60000);
  fs.utimesSync(path.join(dir, `${older}.jsonl`), old, old);

  const list = listHistory(cwd, root);
  assert.deepEqual(list.map(s => s.id), [newer, older]);
  assert.equal(list[1].title, 'Lỗi đăng nhập');
  assert.equal(list[1].firstPrompt, 'sửa lỗi đăng nhập');
  assert.equal(list[1].lastPrompt, 'chạy test đi');
  assert.equal(list[1].prompts, 1);
  assert.equal(list[1].gitBranch, 'feat/x');
  assert.deepEqual(listHistory(path.join(root, 'nope'), root), []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('aliases are keyed by path regardless of case and cleared by an empty name', () => {
  const config = require('../src/config');
  const cfg = { projects: [], aliases: {} };
  const dir = path.join(os.tmpdir(), 'Repo-A');
  assert.equal(config.setAlias(cfg, dir, '  RIS   bản test  '), 'RIS bản test');
  assert.equal(config.aliasOf(cfg, dir.toUpperCase()), process.platform === 'win32' ? 'RIS bản test' : '');
  assert.equal(config.aliasOf(cfg, dir), 'RIS bản test');
  config.setAlias(cfg, dir, '');
  assert.equal(config.aliasOf(cfg, dir), '');
  assert.deepEqual(cfg.aliases, {});
});

test('a folder holding repos becomes a workspace; a repo or its subfolder does not', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ws-'));
  const config = require('../src/config');
  for (const name of ['v1', 'v2']) execFileSync('git', ['init', '-q', path.join(root, name)]);
  fs.mkdirSync(path.join(root, 'v1', 'src'));
  fs.mkdirSync(path.join(root, 'empty'));
  const cfg = { projects: [], workspaces: [] };

  assert.equal(await config.addWorkspace(cfg, root), true);
  assert.equal(await config.addWorkspace(cfg, root), false); // already there
  assert.equal(await config.addWorkspace(cfg, path.join(root, 'v1')), false); // a repo
  assert.equal(await config.addWorkspace(cfg, path.join(root, 'v1', 'src')), false); // inside a repo
  assert.equal(await config.addWorkspace(cfg, path.join(root, 'empty')), false); // no repos below
  assert.equal(cfg.workspaces.length, 1);

  assert.ok(config.isInside(path.join(root, 'v2'), root));
  assert.ok(!config.isInside(root, path.join(root, 'v2')));
  config.removeWorkspace(cfg, root);
  assert.deepEqual(cfg.workspaces, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('childEnv drops the markers of a parent Claude session but keeps the rest', () => {
  const { childEnv } = require('../src/config');
  process.env.CLAUDE_CODE_CHILD_SESSION = '1';
  process.env.CLAUDECODE = '1';
  try {
    const env = childEnv({ CLAUDE_HUB_SID: 'x' });
    assert.equal(env.CLAUDE_CODE_CHILD_SESSION, undefined);
    assert.equal(env.CLAUDECODE, undefined);
    assert.equal(env.CLAUDE_HUB_SID, 'x');
    assert.equal(env.PATH ?? env.Path, process.env.PATH ?? process.env.Path);
  } finally {
    delete process.env.CLAUDE_CODE_CHILD_SESSION;
    delete process.env.CLAUDECODE;
  }
});

test('a repo that keeps other repos inside brings them in too, right after it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-nested-'));
  const config = require('../src/config');
  const outer = path.join(root, 'mini');
  for (const dir of [outer, path.join(outer, 'admin'), path.join(outer, 'deep', 'api')]) {
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('git', ['init', '-q', dir]);
  }
  // a linked worktree inside the repo is not a separate project
  fs.mkdirSync(path.join(outer, 'wt'));
  fs.writeFileSync(path.join(outer, 'wt', '.git'), 'gitdir: ../.git/worktrees/wt\n');
  fs.mkdirSync(path.join(outer, 'node_modules', 'x', '.git'), { recursive: true });

  const cfg = { projects: [path.join(root, 'other')] };
  const added = await config.addProjects(cfg, outer);
  assert.deepEqual(added.map(p => path.relative(root, p)).sort(), ['mini', path.join('mini', 'admin'), path.join('mini', 'deep', 'api')].sort());

  // an older config that only had the outer repo picks the inner ones up, placed under it
  const old = { projects: [outer, path.join(root, 'zzz')] };
  assert.equal(config.addNestedProjects(old).length, 2);
  assert.deepEqual(old.projects.map(p => path.relative(root, p)), ['mini', path.join('mini', 'admin'), path.join('mini', 'deep', 'api'), 'zzz']);
  assert.equal(config.addNestedProjects(old).length, 0);
  fs.rmSync(root, { recursive: true, force: true });
});
