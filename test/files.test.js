const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const files = require('../src/files');

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-files-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'secret.txt'), 'outside');
  return { root, repo };
}

test('resolveSafe allows paths under a root and blocks everything else', () => {
  const { root, repo } = sandbox();
  const roots = [repo];
  fs.writeFileSync(path.join(repo, 'src', 'a.cs'), 'x');
  assert.ok(files.resolveSafe(path.join(repo, 'src', 'a.cs'), roots).endsWith('a.cs'));
  assert.throws(() => files.resolveSafe(path.join(root, 'secret.txt'), roots), e => e.status === 403);
  assert.throws(() => files.resolveSafe(path.join(repo, '..', 'secret.txt'), roots), e => e.status === 403);
  assert.throws(() => files.resolveSafe(path.join(repo, 'nope.txt'), roots), e => e.status === 404);
  assert.throws(() => files.resolveSafe('', roots), e => e.status === 400);
  fs.rmSync(root, { recursive: true, force: true });
});

test('list puts folders first and hides noisy folders', () => {
  const { root, repo } = sandbox();
  fs.writeFileSync(path.join(repo, 'README.md'), '#');
  const names = files.list(repo).map(e => `${e.dir ? 'd' : 'f'}:${e.name}`);
  assert.deepEqual(names, ['d:src', 'f:README.md']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('read/write keep BOM and CRLF, and refuse to overwrite a file changed meanwhile', () => {
  const { root, repo } = sandbox();
  const file = path.join(repo, 'src', 'a.cs');
  fs.writeFileSync(file, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('a\r\nb\r\n')]));

  const opened = files.read(file);
  assert.equal(opened.bom, true);
  assert.equal(opened.eol, 'crlf');
  assert.equal(opened.text, 'a\r\nb\r\n');

  // the editor sends \n line endings; the file must keep its BOM and CRLF
  const saved = files.write(file, 'a\nb\nc\n', { mtime: opened.mtime, bom: opened.bom, eol: opened.eol });
  assert.equal(saved.conflict, false);
  const bytes = fs.readFileSync(file);
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(bytes.subarray(3).toString(), 'a\r\nb\r\nc\r\n');

  // someone else (e.g. Claude) writes the file after we opened it
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(file, later, later);
  assert.equal(files.write(file, 'mine', { mtime: saved.mtime }).conflict, true);
  assert.equal(files.write(file, 'mine', { mtime: saved.mtime, force: true }).conflict, false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'mine');
  fs.rmSync(root, { recursive: true, force: true });
});

test('read rejects binary and oversized files', () => {
  const { root, repo } = sandbox();
  const bin = path.join(repo, 'img.png');
  fs.writeFileSync(bin, Buffer.from([0x89, 0x50, 0x00, 0x47]));
  assert.throws(() => files.read(bin), e => e.status === 415);
  const big = path.join(repo, 'big.log');
  fs.writeFileSync(big, Buffer.alloc(files.MAX_SIZE + 1, 0x61));
  assert.throws(() => files.read(big), e => e.status === 413);
  fs.rmSync(root, { recursive: true, force: true });
});
