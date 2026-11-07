const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const search = require('../src/search');

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// A folder (not a repo) holding a git repo with a .gitignore and a nested repo, plus loose files.
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-search-'));
  const repo = path.join(root, 'app');
  write(path.join(repo, '.gitignore'), 'dist/\n*.log\n');
  write(path.join(repo, 'src', 'PatientService.cs'), 'class PatientService {\n  void ResetPassword() {}\n}\n');
  write(path.join(repo, 'src', 'ui', 'patient.jsx'), 'const resetpassword = 1;\n');
  write(path.join(repo, 'dist', 'bundle.js'), 'ResetPassword();\n');
  write(path.join(repo, 'debug.log'), 'ResetPassword\n');
  write(path.join(repo, 'img.png'), Buffer.from([0x89, 0x50, 0, 0, 0x52, 0x65]));
  execFileSync('git', ['init', '-q', repo]);
  const inner = path.join(repo, 'api');
  write(path.join(inner, 'Controller.cs'), 'ResetPassword(id);\n');
  execFileSync('git', ['init', '-q', inner]);
  write(path.join(root, 'notes.md'), 'reset password notes\n');
  write(path.join(root, 'node_modules', 'x', 'index.js'), 'ResetPassword\n');
  return { root, repo };
}

test('listFiles follows .gitignore inside repos, includes nested repos and skips noise outside', async () => {
  const { root, repo } = sandbox();
  const inRepo = (await search.listFiles(repo)).files.sort();
  assert.deepStrictEqual(inRepo, ['.gitignore', 'api/Controller.cs', 'img.png', 'src/PatientService.cs', 'src/ui/patient.jsx']);
  const all = (await search.listFiles(root)).files.sort();
  assert.ok(all.includes('notes.md'));
  assert.ok(all.includes('app/api/Controller.cs'));
  assert.ok(!all.some(f => f.includes('node_modules') || f.includes('dist/')));
  assert.strictEqual((await search.listFiles(root, { limit: 2 })).truncated, true);
});

test('searchText finds lines with case, whole word, regex and file filters', async () => {
  const { repo } = sandbox();
  const files = r => r.results.map(x => x.file).sort();

  const plain = await search.searchText(repo, 'resetpassword');
  assert.deepStrictEqual(files(plain), ['api/Controller.cs', 'src/PatientService.cs', 'src/ui/patient.jsx']);
  const hit = plain.results.find(x => x.file === 'src/PatientService.cs').hits[0];
  assert.deepStrictEqual([hit.line, hit.col, hit.len], [2, 7, 13]);

  assert.deepStrictEqual(files(await search.searchText(repo, 'ResetPassword', { caseSensitive: true })), ['api/Controller.cs', 'src/PatientService.cs']);
  assert.deepStrictEqual(files(await search.searchText(repo, 'Reset', { wholeWord: true })), []);
  assert.deepStrictEqual(files(await search.searchText(repo, 'Reset\\w+\\(id', { regex: true })), ['api/Controller.cs']);
  assert.deepStrictEqual(files(await search.searchText(repo, 'resetpassword', { include: '*.cs' })), ['api/Controller.cs', 'src/PatientService.cs']);
  assert.deepStrictEqual(files(await search.searchText(repo, 'resetpassword', { exclude: 'api/**, *.jsx' })), ['src/PatientService.cs']);

  const capped = await search.searchText(repo, 'resetpassword', { maxMatches: 1 });
  assert.strictEqual(capped.matches, 1);
  assert.strictEqual(capped.truncated, true);
});

test('globTest matches file names anywhere and paths from the root', () => {
  const t = search.globTest('*.cs, ClientApp/src/**');
  assert.ok(t('a/b/X.cs'));
  assert.ok(t('ClientApp/src/pages/a.jsx'));
  assert.ok(!t('a.js'));
  assert.strictEqual(search.globTest(''), null);
});
