const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

process.env.CLAUDE_HUB_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-srv-'));
const { createHub } = require('../src/server');

const PORT = 47317;
const base = `http://127.0.0.1:${PORT}`;

test('server', async t => {
  const hub = createHub({ port: PORT });
  await new Promise(r => hub.server.listen(PORT, '127.0.0.1', r));
  t.after(() => hub.close());
  const headers = { 'content-type': 'application/json', 'x-hub-token': hub.token };

  await t.test('serves the page with the token injected', async () => {
    const html = await (await fetch(base + '/')).text();
    assert.ok(html.includes(hub.token));
  });

  await t.test('serves CodeMirror files but nothing outside its package', async () => {
    assert.equal((await fetch(base + '/vendor/cm/lib/codemirror.js')).status, 200);
    assert.equal((await fetch(base + '/vendor/cm/..%2F..%2Fpackage.json')).status, 404);
  });

  await t.test('editor API refuses files outside registered projects', async () => {
    const outside = path.join(os.tmpdir(), `hub-outside-${process.pid}.txt`);
    fs.writeFileSync(outside, 'secret');
    const res = await fetch(base + '/api/fs/read?path=' + encodeURIComponent(outside), { headers });
    assert.equal(res.status, 403);
    assert.ok(!(await res.text()).includes('secret'));
    fs.rmSync(outside, { force: true });
  });

  await t.test('rejects API calls without the token', async () => {
    assert.equal((await fetch(base + '/api/state')).status, 401);
  });

  await t.test('rejects a malformed resume id before spawning claude', async () => {
    const res = await fetch(base + '/api/sessions', { method: 'POST', headers, body: JSON.stringify({ cwd: '.', resume: '--dangerously-skip-permissions' }) });
    assert.equal(res.status, 400);
  });

  await t.test('lists history for a cwd', async () => {
    const res = await fetch(base + '/api/history?cwd=' + encodeURIComponent(os.tmpdir()), { headers });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray((await res.json()).sessions));
  });

  await t.test('rejects requests from other origins', async () => {
    const res = await fetch(base + '/api/state', { headers: { ...headers, origin: 'http://evil.example' } });
    assert.equal(res.status, 403);
  });

  await t.test('hook reporter updates session status', async () => {
    // a fake session record is enough to exercise the hook path end to end
    hub.sessions.sessions.set('fake', { id: 'fake', cwd: '.', status: 'idle', title: '', unread: false, proc: { kill() {} }, buffer: '' });
    const notified = new Promise(r => hub.sessions.once('notify', r));
    const env = { ...process.env, CLAUDE_HUB_SID: 'fake', CLAUDE_HUB_PORT: String(PORT), CLAUDE_HUB_TOKEN: hub.token };
    const run = (event, input) => new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [path.join(__dirname, '..', 'hooks', 'report.js'), event], { env }, err => err ? reject(err) : resolve());
      child.stdin.end(JSON.stringify(input));
    });
    await run('UserPromptSubmit', { prompt: 'sửa lỗi đăng nhập', session_id: 'x' });
    await run('Stop', { session_id: 'x' });
    const s = await notified;
    assert.equal(s.status, 'done');
    assert.equal(s.title, 'sửa lỗi đăng nhập');
    assert.equal(s.unread, true);
  });

  await t.test('hook reporter exits quietly when the hub is unreachable', async () => {
    const env = { ...process.env, CLAUDE_HUB_SID: 'x', CLAUDE_HUB_PORT: '1', CLAUDE_HUB_TOKEN: 'x' };
    await new Promise((resolve, reject) => {
      const child = execFile(process.execPath, [path.join(__dirname, '..', 'hooks', 'report.js'), 'Stop'], { env }, err => err ? reject(err) : resolve());
      child.stdin.end('{}');
    });
  });
});
