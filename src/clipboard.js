const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/bmp': '.bmp' };
const MAX_IMAGE = 20 * 1024 * 1024;

// Claude Code pastes images by reading the OS clipboard itself when it gets its paste key
// (Alt+V on Windows). A dropped or picked file has to land on the clipboard first.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$img = [System.Drawing.Image]::FromFile($env:HUB_IMAGE_FILE)
try { [System.Windows.Forms.Clipboard]::SetImage($img) } finally { $img.Dispose() }
`;

function setClipboardImage(buffer, type) {
  if (process.platform !== 'win32') {
    return Promise.reject(Object.assign(new Error('Gửi ảnh bằng file hiện chỉ có trên Windows; hãy sao chép ảnh rồi dán (Ctrl+V)'), { status: 501 }));
  }
  if (!TYPES[type]) return Promise.reject(Object.assign(new Error('Chỉ gửi được ảnh PNG, JPG, GIF, WebP hoặc BMP'), { status: 415 }));
  if (buffer.length > MAX_IMAGE) return Promise.reject(Object.assign(new Error('Ảnh lớn hơn 20 MB'), { status: 413 }));
  const file = path.join(os.tmpdir(), `claude-hub-${crypto.randomUUID()}${TYPES[type]}`);
  fs.writeFileSync(file, buffer);
  const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded], {
      env: { ...process.env, HUB_IMAGE_FILE: file }, windowsHide: true, timeout: 30000,
    }, (err, stdout, stderr) => {
      fs.rm(file, { force: true }, () => {});
      if (err) return reject(new Error(`Không đưa được ảnh vào clipboard: ${String(stderr || err.message).trim().split('\n')[0]}`));
      resolve();
    });
  });
}

// the key Claude Code binds to chat:imagePaste
const IMAGE_PASTE_KEY = process.platform === 'win32' ? '\x1bv' : '\x16';

module.exports = { setClipboardImage, IMAGE_PASTE_KEY, MAX_IMAGE, TYPES };
