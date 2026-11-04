const fs = require('node:fs');
const path = require('node:path');

// Folders that are noise in a file tree and can be huge.
const IGNORED = new Set(['.git', 'node_modules', 'bin', 'obj', '.vs', '.idea', '__pycache__']);
const MAX_SIZE = 2 * 1024 * 1024;

const real = p => fs.realpathSync.native(path.resolve(p));

function inside(child, dir) {
  const rel = path.relative(dir, child);
  return !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Resolve p and make sure it lives under one of the allowed roots (after following symlinks),
// so the editor can't be pointed at C:\Windows or ..\..\ anything.
function resolveSafe(p, roots) {
  if (!p) throw httpError(400, 'Thiếu đường dẫn');
  let target;
  try { target = real(p); } catch { throw httpError(404, 'File hoặc thư mục không tồn tại'); }
  const ok = roots.some(r => {
    try { return inside(target, real(r)); } catch { return false; }
  });
  if (!ok) throw httpError(403, 'Đường dẫn nằm ngoài các dự án/workspace của hub');
  return target;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function list(dir) {
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(e => !(e.isDirectory() && IGNORED.has(e.name)))
    .map(e => ({ name: e.name, dir: e.isDirectory() }))
    .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

function read(file) {
  const st = fs.statSync(file);
  if (st.isDirectory()) throw httpError(400, 'Đây là thư mục');
  if (st.size > MAX_SIZE) throw httpError(413, `File quá lớn để mở trong hub (${(st.size / 1048576).toFixed(1)} MB, tối đa 2 MB)`);
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 8000).includes(0)) throw httpError(415, 'File nhị phân, không mở được trong editor');
  const bom = buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
  const text = buf.toString('utf8', bom ? 3 : 0);
  return { text, bom, eol: text.includes('\r\n') ? 'crlf' : 'lf', mtime: st.mtimeMs, size: st.size };
}

// Refuses to overwrite a file that changed on disk since it was opened (e.g. Claude edited it), unless forced.
function write(file, text, { mtime, bom = false, eol = 'lf', force = false } = {}) {
  const st = fs.statSync(file);
  if (st.isDirectory()) throw httpError(400, 'Đây là thư mục');
  if (!force && mtime != null && Math.abs(st.mtimeMs - mtime) > 1) {
    return { conflict: true, mtime: st.mtimeMs };
  }
  let body = String(text).replace(/\r\n/g, '\n');
  if (eol === 'crlf') body = body.replace(/\n/g, '\r\n');
  fs.writeFileSync(file, bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, 'utf8')]) : body);
  return { conflict: false, mtime: fs.statSync(file).mtimeMs };
}

module.exports = { resolveSafe, list, read, write, IGNORED, MAX_SIZE };
