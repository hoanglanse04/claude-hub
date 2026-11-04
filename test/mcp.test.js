const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const mcp = require('../src/mcp');

test('available merges user, project and local scopes with local winning', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-mcp-'));
  const cwd = path.join(root, 'app');
  fs.mkdirSync(cwd);
  const claudeJson = path.join(root, '.claude.json');
  fs.writeFileSync(claudeJson, JSON.stringify({
    mcpServers: { playwright: { command: 'npx', args: ['@playwright/mcp'] }, mysql: { command: 'npx', args: ['mysql-mcp'], env: { MYSQL_PASS: 'secret' } } },
    projects: { [cwd.replace(/\\/g, '/')]: { mcpServers: { mysql: { command: 'npx', args: ['mysql-mcp', '--local'] } } } },
  }));
  fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { type: 'http', url: 'https://docs.example/mcp?key=abc' } } }));

  const list = mcp.available(cwd, claudeJson);
  const byName = Object.fromEntries(list.map(s => [s.name, s]));
  assert.deepEqual(Object.keys(byName).sort(), ['docs', 'mysql', 'playwright']);
  assert.equal(byName.mysql.scope, 'local');
  assert.equal(byName.docs.scope, 'project');

  const pub = list.map(mcp.publicInfo);
  assert.ok(!JSON.stringify(pub).includes('secret'));
  assert.ok(!JSON.stringify(pub).includes('key=abc'));
  assert.equal(pub.find(p => p.name === 'docs').target, 'docs.example');
  fs.rmSync(root, { recursive: true, force: true });
});

test('parseList reads `claude mcp list` output', () => {
  const out = mcp.parseList([
    'Checking MCP server health…', '',
    'claude.ai Claude Docs: https://api.anthropic.com/v1/pages/mcp - ✔ Connected',
    'playwright: cmd /c npx -y @playwright/mcp@latest - ✔ Connected',
    'mysql: cmd /c npx -y mcp-server-mysql - ✘ Failed to connect — CONNECTION_CLOSED',
  ].join('\r\n'));
  assert.equal(out.playwright.ok, true);
  assert.equal(out['claude.ai Claude Docs'].ok, true);
  assert.equal(out.mysql.ok, false);
  assert.match(out.mysql.detail, /Failed to connect/);
});

test('serverOfTool extracts the MCP server from a tool name', () => {
  assert.equal(mcp.serverOfTool('mcp__playwright__browser_click'), 'playwright');
  assert.equal(mcp.serverOfTool('Bash'), null);
});

test('restart relaunches with the chosen MCP servers and resumes the conversation', () => {
  // stand-in for node-pty so no real claude process starts
  const pty = require('@lydell/node-pty');
  const spawned = [];
  const realSpawn = pty.spawn;
  pty.spawn = (cmd, args) => {
    const proc = { args, killed: false, kill() { this.killed = true; }, onData() {}, onExit(fn) { this.exit = fn; }, write() {}, resize() {} };
    spawned.push(proc);
    return proc;
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-mcp-s-'));
  try {
    const { SessionManager } = require('../src/sessions');
    const m = new SessionManager({ hookSettingsFile: path.join(home, 'hook-settings.json'), port: 1, token: 't' });
    m.hasSession = () => true; // pretend Claude already saved the conversation
    const s = m.create({ cwd: home });
    assert.ok(!spawned[0].args.includes('--strict-mcp-config'));

    m.applyEvent(s.id, 'SessionStart', { claudeSessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    m.applyEvent(s.id, 'PreToolUse', { tool: 'mcp__playwright__browser_click' });
    assert.equal(m.sessions.get(s.id).mcpUsed.playwright, 1);

    m.restart(s.id, { mcp: [] });
    assert.equal(spawned[0].killed, true);
    const args = spawned[1].args;
    assert.ok(args.includes('--strict-mcp-config'));
    assert.deepEqual(args.slice(-2), ['--resume', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee']);
    const cfgFile = args[args.indexOf('--mcp-config') + 1];
    assert.deepEqual(JSON.parse(fs.readFileSync(cfgFile, 'utf8')), { mcpServers: {} });

    // the killed process exiting later must not mark the relaunched session as exited
    spawned[0].exit?.({ exitCode: 0 });
    assert.notEqual(m.sessions.get(s.id).status, 'exited');

    m.remove(s.id);
  } finally {
    pty.spawn = realSpawn;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
