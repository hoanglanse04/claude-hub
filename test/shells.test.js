const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');

test('shell manager only launches shells from its catalog, PowerShell first', () => {
  const pty = require('@lydell/node-pty');
  const realSpawn = pty.spawn;
  const spawned = [];
  pty.spawn = (file, args, opts) => {
    const proc = { file, args, opts, kill() { this.killed = true; }, onData() {}, onExit() {}, write() {}, resize() {} };
    spawned.push(proc);
    return proc;
  };
  try {
    const { ShellManager } = require('../src/shells');
    const m = new ShellManager();
    const kinds = m.kinds().map(k => k.id);
    if (process.platform === 'win32') {
      assert.equal(kinds[0], 'powershell');
      assert.ok(kinds.includes('cmd'));
    }

    const s = m.create({ cwd: os.tmpdir(), kind: 'calc.exe' }); // not in the catalog
    assert.equal(s.kind, kinds[0]);
    assert.equal(spawned[0].opts.cwd, os.tmpdir());
    assert.ok(!spawned[0].file.includes('calc'));
    assert.ok(s.id.startsWith('sh-'));

    m.remove(s.id);
    assert.equal(spawned[0].killed, true);
    assert.equal(m.list().length, 0);
  } finally {
    pty.spawn = realSpawn;
  }
});
