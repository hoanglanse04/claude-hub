const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const skills = require('../src/skills');

function writeSkill(dir, folder, body) {
  fs.mkdirSync(path.join(dir, folder), { recursive: true });
  fs.writeFileSync(path.join(dir, folder, 'SKILL.md'), body);
}

test('frontmatter reads name and a quoted description', () => {
  const fm = skills.frontmatter('﻿---\r\nname: brainstorming\r\ndescription: "Use before creative work"\r\n---\r\n# x');
  assert.deepEqual(fm, { name: 'brainstorming', description: 'Use before creative work' });
});

test('available lists plugin skills (incl. custom skills path) and user/project skills for cwd', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-skills-'));
  try {
    const claudeDir = path.join(root, 'claude');
    const cwd = path.join(root, 'repo');
    const other = path.join(root, 'other');
    const pluginA = path.join(root, 'plug-a');
    const pluginB = path.join(root, 'plug-b');
    writeSkill(path.join(claudeDir, 'skills'), 'ris-verify', '---\nname: ris-verify\ndescription: build and test\n---');
    writeSkill(path.join(cwd, '.claude', 'skills'), 'deploy', '---\ndescription: deploy it\n---');
    writeSkill(path.join(pluginA, 'skills'), 'tdd', '---\nname: test-driven-development\ndescription: tests first\n---');
    writeSkill(path.join(pluginB, '.claude', 'skills'), 'design', '---\nname: design\ndescription: d\n---');
    fs.mkdirSync(path.join(pluginB, '.claude-plugin'), { recursive: true });
    fs.writeFileSync(path.join(pluginB, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'ui', skills: './.claude/skills/' }));

    const list = async () => [
      { id: 'superpowers@official', version: '7.0.0', scope: 'user', enabled: true, installPath: pluginA },
      { id: 'ui@market', version: '2.0.0', scope: 'user', enabled: false, installPath: pluginB },
      { id: 'notes@official', version: '1.0.0', scope: 'project', enabled: false, projectPath: other, installPath: pluginA },
    ];
    const out = await skills.available('claude', cwd, { claudeDir, list });

    assert.deepEqual(out.plugins.map(p => [p.id, p.enabled]), [['superpowers@official', true], ['ui@market', false]]);
    assert.deepEqual(out.plugins[0].skills.map(s => s.name), ['superpowers:test-driven-development']);
    assert.deepEqual(out.plugins[1].skills.map(s => s.name), ['ui:design']);
    assert.deepEqual(out.skills.map(s => [s.name, s.scope]), [['ris-verify', 'user'], ['deploy', 'project']]);
    assert.ok(out.skills[0].tokens > 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('validate rejects names that could break out of a permission rule', () => {
  assert.equal(skills.validate(null), null);
  assert.deepEqual(skills.validate({ plugins: { 'a@b': 0 }, off: ['x', 'p:y', 'x'] }), { plugins: { 'a@b': false }, off: ['x', 'p:y'] });
  assert.throws(() => skills.validate({ off: ['x) Bash(*'] }));
  assert.throws(() => skills.validate({ plugins: { 'not a plugin': true } }));
});

test('sessionSettings keeps the hooks and turns skills off both ways', () => {
  const base = { hooks: { Stop: [] } };
  assert.equal(skills.sessionSettings(base, null), base);
  const out = skills.sessionSettings(base, { plugins: { 'ui@market': false }, off: ['dataviz', 'superpowers:brainstorming'] });
  assert.deepEqual(out, {
    hooks: { Stop: [] },
    enabledPlugins: { 'ui@market': false },
    skillOverrides: { dataviz: 'off', 'superpowers:brainstorming': 'off' },
    permissions: { deny: ['Skill(dataviz)', 'Skill(superpowers:brainstorming)'] },
  });
});

test('changing skills restarts with a per-session settings file and keeps the MCP choice', () => {
  const pty = require('@lydell/node-pty');
  const spawned = [];
  const realSpawn = pty.spawn;
  pty.spawn = (cmd, args) => {
    const proc = { args, kill() {}, onData() {}, onExit() {}, write() {}, resize() {} };
    spawned.push(proc);
    return proc;
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-skills-s-'));
  try {
    const { SessionManager } = require('../src/sessions');
    const hookFile = path.join(home, 'hook-settings.json');
    const m = new SessionManager({ hookSettingsFile: hookFile, port: 1, token: 't' });
    const s = m.create({ cwd: home, mcp: [] });
    const settingsArg = args => args[args.indexOf('--settings') + 1];
    assert.equal(settingsArg(spawned[0].args), hookFile);

    m.restart(s.id, { skills: { plugins: { 'ui@market': false }, off: [] } });
    const args = spawned[1].args;
    assert.ok(args.includes('--strict-mcp-config'), 'MCP choice survives a skill change');
    const file = settingsArg(args);
    assert.notEqual(file, hookFile);
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(written.enabledPlugins, { 'ui@market': false });
    assert.ok(written.hooks.Stop, 'status hooks are still installed');

    m.restart(s.id, { skills: null });
    assert.equal(settingsArg(spawned[2].args), hookFile);
    m.remove(s.id);
  } finally {
    pty.spawn = realSpawn;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('a tui override goes into the session settings and survives a restart', () => {
  const pty = require('@lydell/node-pty');
  const spawned = [];
  const realSpawn = pty.spawn;
  pty.spawn = (cmd, args) => {
    const proc = { args, kill() {}, onData() {}, onExit() {}, write() {}, resize() {} };
    spawned.push(proc);
    return proc;
  };
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-tui-'));
  try {
    const { SessionManager } = require('../src/sessions');
    const m = new SessionManager({ hookSettingsFile: path.join(home, 'hook-settings.json'), port: 1, token: 't' });
    const s = m.create({ cwd: home, tui: 'default' });
    const read = proc => JSON.parse(fs.readFileSync(proc.args[proc.args.indexOf('--settings') + 1], 'utf8'));
    assert.equal(read(spawned[0]).tui, 'default');
    assert.ok(read(spawned[0]).hooks.Stop);
    m.restart(s.id, { mcp: [] });
    assert.equal(read(spawned[1]).tui, 'default');
    m.remove(s.id);
  } finally {
    pty.spawn = realSpawn;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
