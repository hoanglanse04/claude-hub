#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createHub } = require('../src/server');

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const port = Number(portArg !== -1 ? args[portArg + 1] : process.env.CLAUDE_HUB_PORT_LISTEN || 4317);
const noOpen = args.includes('--no-open');
const url = `http://127.0.0.1:${port}/`;

if (args.includes('--help') || args.includes('-h')) {
  console.log(`claude-hub [--port 4317] [--no-open]

Mở dashboard quản lý các phiên Claude Code tại ${url}
Đóng cửa sổ này (hoặc Ctrl+C) sẽ dừng toàn bộ các phiên đang chạy trong hub.`);
  process.exit(0);
}

// Edge in app mode gives a separate window without browser chrome; fall back to the default browser.
function openWindow() {
  if (noOpen) return;
  const edges = [
    path.join(process.env['ProgramFiles(x86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.ProgramFiles || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];
  const edge = process.platform === 'win32' && edges.find(p => fs.existsSync(p));
  const opts = { detached: true, stdio: 'ignore' };
  if (edge) spawn(edge, [`--app=${url}`, '--window-size=1400,900'], opts).unref();
  else if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '""', url], opts).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], opts).unref();
}

const hub = createHub({ port });
hub.server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Hub đã chạy sẵn ở ${url}, mở lại cửa sổ dashboard.`);
    openWindow();
    process.exit(0);
  }
  throw err;
});
hub.server.listen(port, '127.0.0.1', () => {
  console.log(`Hoàng Lân HUB đang chạy: ${url}`);
  console.log('Giữ cửa sổ này mở. Đóng nó (hoặc Ctrl+C) sẽ dừng mọi phiên Claude trong hub.');
  openWindow();
});

function shutdown() {
  hub.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
