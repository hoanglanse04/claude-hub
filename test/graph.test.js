const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { layout } = require('../src/graph');
const { parseRefs, parseLog, log } = require('../src/git');

test('linear history stays in one lane', () => {
  const { rows, width } = layout([
    { hash: 'c', parents: ['b'] },
    { hash: 'b', parents: ['a'] },
    { hash: 'a', parents: [] },
  ]);
  assert.equal(width, 1);
  assert.deepEqual(rows.map(r => r.col), [0, 0, 0]);
  assert.deepEqual(rows[2].segments, [{ x1: 0, y1: 0, x2: 0, y2: 0.5, color: 0 }]); // root: only the line coming in
});

test('a merge opens a second lane that joins back at the fork point', () => {
  //   m      merge of b and c
  //   |\
  //   | c
  //   b |
  //   |/
  //   a
  const { rows, width } = layout([
    { hash: 'm', parents: ['b', 'c'] },
    { hash: 'c', parents: ['a'] },
    { hash: 'b', parents: ['a'] },
    { hash: 'a', parents: [] },
  ]);
  assert.equal(width, 2);
  assert.deepEqual(rows.map(r => r.col), [0, 1, 0, 0]);
  assert.ok(rows[0].segments.some(s => s.x1 === 0 && s.y1 === 0.5 && s.x2 === 1 && s.y2 === 1), 'merge line goes to lane 1');
  assert.notEqual(rows[1].color, rows[0].color, 'the side branch gets its own color');
  // at the fork point the side lane curves into the commit dot
  assert.ok(rows[3].segments.some(s => s.x1 === 1 && s.y1 === 0 && s.x2 === 0 && s.y2 === 0.5));
});

test('parseRefs classifies HEAD, local, remote and tag refs', () => {
  assert.deepEqual(parseRefs('HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1.0'), [
    { name: 'main', kind: 'head' },
    { name: 'origin/main', kind: 'remote' },
    { name: 'v1.0', kind: 'tag' },
  ]);
  assert.deepEqual(parseRefs(''), []);
});

test('parseLog reads the hub log format', () => {
  const rec = (...f) => f.join('\x1f') + '\x1e';
  const out = parseLog(rec('aaa', 'bbb ccc', 'Lan', '1700000000', 'refs/heads/x', 'Merge x') + '\n' + rec('bbb', '', 'Lan', '1690000000', '', 'init'));
  assert.equal(out.length, 2);
  assert.deepEqual(out[0].parents, ['bbb', 'ccc']);
  assert.equal(out[0].time, 1700000000000);
  assert.deepEqual(out[1].parents, []);
});

test('log + layout work on this repository', async () => {
  const commits = await log(path.join(__dirname, '..'), { limit: 50 });
  assert.ok(commits.length > 0);
  const { rows } = layout(commits);
  assert.equal(rows.length, commits.length);
});
