// Isolated simulated user. Never use the real Codex home, Harness profile or account.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const root = fileURLToPath(new URL('../', import.meta.url)); fs.mkdirSync(path.join(root, '.local'), { recursive: true });
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const dir = fs.mkdtempSync(path.join(root, '.local', 'share-check-'));
const project = path.join(dir, 'source project'), state = path.join(dir, 'runtime state'), home = path.join(dir, 'test user home'), launcher = path.join(dir, 'dsh.cmd');
fs.mkdirSync(project); fs.mkdirSync(home); fs.writeFileSync(launcher, '@echo off\r\nexit /b 1\r\n');
const initialConfig = 'model = "user-model"\n[mcp_servers.unrelated]\ncommand = "kept"\n';
const otherHook = { matcher: 'keep-me', hooks: [{ type: 'command', command: 'owned-fixture-no-execution' }] };
fs.writeFileSync(path.join(home, 'config.toml'), initialConfig);
fs.writeFileSync(path.join(home, 'hooks.json'), JSON.stringify({ customProperty: 'kept', hooks: { PostToolUse: [otherHook] } }));
const run = (args, expect = 0) => {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts/setup.mjs'), ...args, '--state', state, '--codex-home', home], { cwd: root, encoding: 'utf8', windowsHide: true });
  assert.ifError(r.error); assert.equal(r.status, expect, r.stderr); return r.stdout;
};
run(['init', '--project', project, '--harness-launcher', launcher]);
const config = JSON.parse(fs.readFileSync(path.join(state, 'tools.local.json'), 'utf8'));
assert.equal(config.resourceRoots[0], project); assert(!Object.hasOwn(JSON.parse(fs.readFileSync(config.endpointFile)), 'maxTokens'));
run(['install']); assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), initialConfig);
run(['install', '--apply']);
assert(fs.readFileSync(path.join(home, 'config.toml'), 'utf8').startsWith(initialConfig));
const merged = JSON.parse(fs.readFileSync(path.join(home, 'hooks.json'), 'utf8'));
assert.deepEqual(merged.hooks.PostToolUse[0], otherHook); assert.equal(merged.customProperty, 'kept');
assert.equal(merged.hooks.PostToolUse.length, 3); assert(fs.existsSync(path.join(home, 'skills/work-handoff-loop/SKILL.md')));
assert(!fs.existsSync(path.join(home, 'trusted_hooks.json'))); assert(!fs.existsSync(path.join(home, 'automations')));
const skillPath = path.join(home, 'skills/work-handoff-loop/SKILL.md'), skillBefore = fs.readFileSync(skillPath);
const projectlessState = path.join(dir, 'projectless runtime');
const projectless = spawnSync(process.execPath, [path.join(root, 'scripts/setup.mjs'), 'init', '--harness-launcher', launcher, '--state', projectlessState], { cwd: root, encoding: 'utf8', windowsHide: true });
assert.equal(projectless.status, 0, projectless.stderr);
const projectlessConfig = JSON.parse(fs.readFileSync(path.join(projectlessState, 'tools.local.json'), 'utf8'));
assert.deepEqual(projectlessConfig.resourceRoots, []); assert.equal(projectlessConfig.quotaHooks.scope, 'all-conversations'); assert(fs.existsSync(projectlessConfig.taskContext.root));
const relocatedProgram = path.join(dir, 'installed program'); fs.mkdirSync(path.join(relocatedProgram, 'scripts'), { recursive: true });
fs.copyFileSync(path.join(root, 'scripts/setup.mjs'), path.join(relocatedProgram, 'scripts/setup.mjs'));
fs.cpSync(path.join(root, 'dist'), path.join(relocatedProgram, 'dist'), { recursive: true });
fs.cpSync(path.join(root, 'plugins'), path.join(relocatedProgram, 'plugins'), { recursive: true });
const defaultInit = spawnSync(process.execPath, [path.join(relocatedProgram, 'scripts/setup.mjs'), 'init', '--harness-launcher', launcher], { cwd: relocatedProgram, encoding: 'utf8', windowsHide: true });
assert.equal(defaultInit.status, 0, defaultInit.stderr);
const defaultConfig = JSON.parse(fs.readFileSync(path.join(relocatedProgram, '.local/runtime/tools.local.json'), 'utf8'));
assert(!defaultConfig.workRoot.toLowerCase().startsWith((relocatedProgram + path.sep).toLowerCase()));
assert(defaultConfig.workRoot.startsWith(dir + path.sep));
const selfClient = new Client({ name: 'isolated-self-project-fixture', version: '1' });
try {
  await selfClient.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(relocatedProgram, 'dist/src/mcp-server.js'), '--config', path.join(relocatedProgram, '.local/runtime/tools.local.json')], cwd: relocatedProgram, stderr: 'pipe' }));
  const result = await selfClient.callTool({ name: 'handoff_publish', arguments: { revision: null, input: {
    taskId: 'self-project-fixture', conversationId: 'synthetic-self-project-chat', version: 1, requirementsVersion: 1,
    title: 'isolated fixture', objective: 'check separate storage', requirements: ['only selected file'], summary: 'No model or actual chat',
    remainingWork: ['fixture only'], acceptanceCriteria: ['copy root outside source'], recipients: ['work', 'harness'],
    resourceRoot: relocatedProgram, files: ['dist/src/task-context.js'],
  } } });
  assert(!result.isError, JSON.stringify(result));
} finally { await selfClient.close(); }
fs.appendFileSync(skillPath, '\nOwned user edit fixture\n');
assert(run(['uninstall', '--apply'], 1).length >= 0);
assert(fs.readFileSync(skillPath, 'utf8').includes('Owned user edit fixture'));
assert(fs.readFileSync(path.join(home, 'config.toml'), 'utf8').includes('[mcp_servers.work_handoff_tasks]'));
fs.writeFileSync(skillPath, skillBefore);
const backup = JSON.parse(fs.readFileSync(path.join(state, 'install-backup.local.json'), 'utf8'));
assert.equal(backup.ownedChangesOnly, true); assert(!('config' in backup));
// Real standard MCP handshake, but no native quota API or model task.
const client = new Client({ name: 'shared-preview-isolated-check', version: '1.0' });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist/src/mcp-server.js'), '--config', path.join(state, 'tools.local.json')], stderr: 'pipe' }));
  const reply = await client.callTool({ name: 'handoff_capabilities', arguments: {} }); assert(!reply.isError);
  const cap = JSON.parse(reply.content.find(x => x.type === 'text').text); assert.equal(cap.version, expectedVersion); assert.equal(cap.managedDesktopDispatch, true);
  assert.equal(cap.quotaHookBridge.scope, 'all-conversations'); assert.equal(cap.taskContext.configured, true);
} finally { await client.close(); }
fs.appendFileSync(path.join(home, 'config.toml'), '\n# user changed after installation\n');
run(['uninstall']); assert(fs.readFileSync(path.join(home, 'config.toml'), 'utf8').includes('[mcp_servers.work_handoff_tasks]'));
run(['uninstall', '--apply']);
assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), initialConfig + '\n# user changed after installation\n');
const finalHooks = JSON.parse(fs.readFileSync(path.join(home, 'hooks.json'), 'utf8'));
assert.deepEqual(finalHooks.hooks.PostToolUse, [otherHook]); assert.equal(finalHooks.customProperty, 'kept');
assert(!fs.existsSync(path.join(home, 'skills/work-handoff-loop/SKILL.md'))); assert(fs.existsSync(path.join(state, 'tasks.sqlite')));
const report = { passed: true, scope: 'isolated directories with spaces, no real desktop profile or model', cases: [
  'personal configuration generated', 'preview does not mutate settings', 'owned MCP and hooks installed', 'other settings/hooks preserved',
  'no hook trust or timer created', 'no full user config backup', 'standard MCP handshake and managed capability', 'projectless fresh init defaults to all conversations', 'default copies stay outside the program project',
  'edited skill blocks uninstall without partial settings removal', 'uninstall preserves later user edits', 'task databases retained', 'no generation or execution limits injected' ], modelCalls: 0 };
fs.writeFileSync(path.join(root, 'verification/install-check.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
