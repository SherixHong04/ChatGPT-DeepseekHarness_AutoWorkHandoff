import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { toolsConfig } from '../dist/src/task-tools.js';
import { defaultQuotaPolicy } from '../dist/src/quota.js';
import { defaultQuotaHookPolicy } from '../dist/src/quota-hooks.js';
const root = fs.realpathSync(fileURLToPath(new URL('../', import.meta.url)));
const sha = value => createHash('sha256').update(value).digest('hex');
function noLink(filename) {
  const absolute = path.resolve(filename); let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) throw Error('Linked path refused: ' + current);
  }
  return absolute;
}
function json(filename, data) { noLink(filename); fs.writeFileSync(filename, JSON.stringify(data, null, 2) + '\n', { flag: 'wx' }); }
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  project: { type: 'string', multiple: true }, state: { type: 'string' }, 'harness-launcher': { type: 'string' },
  model: { type: 'string' }, 'codex-home': { type: 'string' }, apply: { type: 'boolean' },
} });
const mode = positionals[0] ?? 'help';
const state = noLink(values.state ?? path.join(root, '.local/runtime'));
const codexHome = noLink(values['codex-home'] ?? process.env.CODEX_HOME ?? path.join(process.env.USERPROFILE ?? process.env.HOME, '.codex'));
const configFile = path.join(state, 'tools.local.json');
const toml = value => JSON.stringify(value);
const hook = (tool, input) => ({ type: 'mcp_tool', server: 'work_handoff_tasks', tool, input, timeout: 10 });
const event = (name, toolName = false) => hook('handoff_hook_event', { conversationId: '${session_id}', cwd: '${cwd}', event: name, ...(toolName ? { toolName: '${tool_name}' } : {}) });
function hookGroups() { return {
  SessionStart: [{ matcher: 'startup|resume|clear|compact|fork', hooks: [event('SessionStart')] }],
  UserPromptSubmit: [{ hooks: [event('UserPromptSubmit')] }],
  PostToolUse: [
    { matcher: '^mcp__codex_app(?:__|\\.)get_usage_limits$', hooks: [hook('handoff_hook_quota', { conversationId: '${session_id}', usage: '${tool_response}', toolName: '${tool_name}', toolUseId: '${tool_use_id}' })] },
    { matcher: '*', hooks: [event('PostToolUse', true)] },
  ],
}; }
function skillSources() {
  const base = path.join(root, 'skills/work-handoff-loop'), files = [];
  function visit(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name); noLink(full); if (e.isDirectory()) visit(full); else files.push({ relative: path.relative(base, full), from: full });
  } } visit(base); return files;
}
if (mode === 'init') {
  if (!values['harness-launcher']) throw Error('init requires --harness-launcher <dsh.cmd>; --project is optional for legacy paths');
  if (fs.existsSync(state)) throw Error('State directory already exists: use it or choose a new --state; nothing replaced');
  const projects = (values.project ?? []).map(p => fs.realpathSync(noLink(p)));
  // The tool's own source project must also be transferable. Keep its copies outside the program tree.
  const dataRoot = values.state ? state : noLink(path.join(path.dirname(root), path.basename(root) + '-Data'));
  if (!values.state && fs.existsSync(dataRoot)) throw Error('Default data directory already exists: preserve it and inspect the earlier installation');
  const workRoot = path.join(dataRoot, 'work');
  const launcher = noLink(values['harness-launcher']); if (!fs.statSync(launcher).isFile() || path.basename(launcher).toLowerCase() !== 'dsh.cmd') throw Error('Provide the installed Harness dsh.cmd file');
  // Keep all runtime output out of authorized input trees to avoid accidental recursive packaging.
  for (const p of projects) if (state.toLowerCase() === p.toLowerCase() || state.toLowerCase().startsWith((p + path.sep).toLowerCase()) || p.toLowerCase().startsWith((state + path.sep).toLowerCase())
    || workRoot.toLowerCase() === p.toLowerCase() || workRoot.toLowerCase().startsWith((p + path.sep).toLowerCase()) || p.toLowerCase().startsWith((workRoot + path.sep).toLowerCase())) throw Error('State/copies and authorized source directories must be separate');
  fs.mkdirSync(state, { recursive: true });
  for (const dir of ['work', 'shared', 'contexts', 'queue', 'queue/requests', 'queue/responses', 'queue/bindings']) fs.mkdirSync(path.join(state, dir), { recursive: true });
  fs.mkdirSync(workRoot, { recursive: true }); noLink(workRoot);
  const chat = { queueRoot: path.join(state, 'queue'), workspaceRoot: path.join(state, 'shared'), enabledAt: Date.now() };
  json(path.join(state, 'chat-policy.local.json'), chat);
  json(path.join(state, 'endpoint.local.json'), { launcher, profile: 'work-handoff-legacy', provider: 'deepseek-account', model: values.model ?? 'desktop-default-unused-by-managed-route' });
  const config = toolsConfig({ schemaVersion: 1, db: path.join(state, 'tasks.sqlite'), store: path.join(state, 'tool-records.sqlite'), workRoot,
    endpointFile: path.join(state, 'endpoint.local.json'), resourceRoots: projects, quotaPolicy: defaultQuotaPolicy, chatManagement: chat,
    quotaHooks: { ...defaultQuotaHookPolicy, scope: 'all-conversations' }, taskContext: { root: path.join(state, 'contexts') } });
  json(configFile, config);
  // Stage a personalized local plugin, never put this directory into a shared archive.
  const bundle = path.join(state, 'harness-plugin'); fs.mkdirSync(bundle);
  for (const f of ['index.mjs', 'package.json']) fs.copyFileSync(path.join(root, 'plugins/harness-chat-manager', f), path.join(bundle, f), fs.constants.COPYFILE_EXCL);
  fs.mkdirSync(path.join(bundle, 'lib'));
  for (const name of fs.readdirSync(path.join(root, 'plugins/harness-chat-manager/lib'))) fs.copyFileSync(path.join(root, 'plugins/harness-chat-manager/lib', name), path.join(bundle, 'lib', name), fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(path.join(bundle, 'cordis.patch.yml'), '- insert:\n    - id: work-handoff-chat-manager\n      name: "@local/work-handoff-chat-manager"\n      config:\n        configFile: ' + JSON.stringify(path.join(state, 'chat-policy.local.json').replaceAll('\\', '/')) + '\n', { flag: 'wx' });
  json(path.join(state, 'hooks.staged.json'), { hooks: hookGroups() });
  const stanza = '[mcp_servers.work_handoff_tasks]\ncommand = ' + toml(process.execPath) + '\nargs = [' + [path.join(root, 'dist/src/mcp-server.js'), '--config', configFile].map(toml).join(', ') + ']\nstartup_timeout_sec = 15\ntool_timeout_sec = 60\n';
  fs.writeFileSync(path.join(state, 'mcp.staged.toml'), stanza, { flag: 'wx' });
  console.log(JSON.stringify({ configFile, harnessBundle: bundle, next: 'install (preview), then install --apply; install the local Harness bundle through its normal plugin manager and review native hooks' }, null, 2));
} else if (mode === 'install') {
  const config = toolsConfig(JSON.parse(fs.readFileSync(configFile, 'utf8'))); void config;
  const configPath = noLink(path.join(codexHome, 'config.toml')), hooksPath = noLink(path.join(codexHome, 'hooks.json'));
  const text = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  if (/\bwork_handoff_tasks\b/.test(text)) throw Error('Existing Work Handoff reference (including quoted/inline tables): preserve it; reconcile before installing another');
  if (/^\[hooks(?:\.|\])/m.test(text)) throw Error('Inline hooks already configured: merge the staged definitions manually, do not create a duplicate source');
  const hooks = fs.existsSync(hooksPath) ? JSON.parse(fs.readFileSync(hooksPath, 'utf8')) : {};
  const owned = hookGroups(); hooks.hooks ??= {};
  for (const groups of Object.values(hooks.hooks)) {
    if (!Array.isArray(groups)) throw Error('Unknown hook format: preserve original');
    for (const group of groups) if (group.hooks?.some(h => h.server === 'work_handoff_tasks')) throw Error('Existing project hooks: preserve and reconcile manually');
  }
  const skill = noLink(path.join(codexHome, 'skills/work-handoff-loop'));
  if (fs.existsSync(skill)) throw Error('Existing skill: preserve user content');
  const registry = path.join(state, 'install-manifest.local.json'); if (fs.existsSync(registry)) throw Error('Installation manifest exists; no repeated installation');
  if (!values.apply) { console.log(JSON.stringify({ preview: true, targets: [configPath, hooksPath, skill], changes: 'Append one MCP section, merge four hook groups, copy one skill. No trust record, account, app core or security setting changes.' }, null, 2)); }
  else {
    fs.mkdirSync(codexHome, { recursive: true });
    const stanza = fs.readFileSync(path.join(state, 'mcp.staged.toml'), 'utf8');
    const beforeHooks = fs.existsSync(hooksPath) ? fs.readFileSync(hooksPath, 'utf8') : null;
    for (const [eventName, groups] of Object.entries(owned)) hooks.hooks[eventName] = [...(hooks.hooks[eventName] ?? []), ...groups];
    const sources = skillSources();
    // Store recovery data outside the release. Installation never modifies trust or approval settings.
    json(registry, { schemaVersion: 1, phase: 'installing', codexHome, configPath, hooksPath, skill, stanza, hooks: owned,
      files: sources.map(row => ({ relative: row.relative, sha256: sha(fs.readFileSync(row.from)) })) });
    json(path.join(state, 'install-backup.local.json'), { configExisted: fs.existsSync(configPath), hooksExisted: beforeHooks !== null,
      ownedChangesOnly: true, configBeforeSha256: sha(text), hooksBeforeSha256: beforeHooks === null ? null : sha(beforeHooks) });
    // Recheck originals before applying; no stale whole-file overwrite.
    if ((fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '') !== text || (fs.existsSync(hooksPath) ? fs.readFileSync(hooksPath, 'utf8') : null) !== beforeHooks) throw Error('User settings changed during planning; preserve and retry after inspection');
    fs.writeFileSync(configPath, text + (text && !text.endsWith('\n') ? '\n' : '') + stanza);
    fs.writeFileSync(hooksPath, JSON.stringify(hooks, null, 2) + '\n');
    for (const row of sources) { const to = path.join(skill, row.relative); noLink(to); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(row.from, to, fs.constants.COPYFILE_EXCL); }
    const manifest = JSON.parse(fs.readFileSync(registry, 'utf8')); manifest.phase = 'installed'; fs.writeFileSync(registry, JSON.stringify(manifest, null, 2) + '\n');
    console.log(JSON.stringify({ installed: true, reviewNativeHooksRequired: true, trustWritten: false, harnessPluginInstalled: false, next: 'Install the staged local Harness bundle using its normal plugin manager, then review hooks and reload the desktop apps normally.' }));
  }
} else if (mode === 'uninstall') {
  const registry = path.join(state, 'install-manifest.local.json'), manifest = JSON.parse(fs.readFileSync(registry, 'utf8'));
  if (path.resolve(manifest.codexHome) !== codexHome) throw Error('Specify the original --codex-home');
  if (path.resolve(manifest.configPath) !== path.join(codexHome, 'config.toml') || path.resolve(manifest.hooksPath) !== path.join(codexHome, 'hooks.json')
    || path.resolve(manifest.skill) !== path.join(codexHome, 'skills/work-handoff-loop')) throw Error('Installation ownership paths differ: no changes');
  for (const row of manifest.files) if (path.isAbsolute(row.relative) || row.relative.split(/[\\/]/).some(p => !p || p === '.' || p === '..')) throw Error('Invalid installed relative file');
  const configPath = noLink(manifest.configPath), hooksPath = noLink(manifest.hooksPath), skill = noLink(manifest.skill);
  const config = fs.readFileSync(configPath, 'utf8'), hooks = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
  // Remove exactly our unchanged registration, never restore a complete user config backup.
  if (!config.includes(manifest.stanza)) throw Error('Project registration was edited; preserve and uninstall manually');
  for (const row of manifest.files) if (fs.existsSync(path.join(skill, row.relative)) && sha(fs.readFileSync(noLink(path.join(skill, row.relative)))) !== row.sha256) throw Error('Installed skill was edited; preserve and uninstall manually');
  for (const [name, ownGroups] of Object.entries(manifest.hooks)) {
    for (const own of ownGroups) {
      const groups = hooks.hooks?.[name] ?? [], key = JSON.stringify(own), index = groups.findIndex(g => JSON.stringify(g) === key);
      if (index < 0) throw Error('Owned hook was edited; preserve and uninstall manually'); groups.splice(index, 1);
    }
  }
  if (!values.apply) console.log(JSON.stringify({ preview: true, preserve: 'All task data, backups, credentials, other MCP settings, other hooks and edited files' }));
  else {
    fs.writeFileSync(configPath, config.replace(manifest.stanza, ''));
    fs.writeFileSync(hooksPath, JSON.stringify(hooks, null, 2) + '\n');
    for (const row of manifest.files) if (fs.existsSync(path.join(skill, row.relative))) fs.unlinkSync(noLink(path.join(skill, row.relative)));
    // Remove only empty owned directories, bottom-up; never recursively delete a computed tree.
    for (const dir of ['references', ''].map(p => path.join(skill, p))) if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
    manifest.phase = 'uninstalled'; fs.writeFileSync(registry, JSON.stringify(manifest, null, 2) + '\n');
    console.log('Removed owned registration/hooks/skill. Runtime data kept. Remove the local Harness plugin through its normal plugin manager.');
  }
} else {
  console.log('Work Handoff shared preview\n  node scripts/setup.mjs init --harness-launcher <installed-dsh.cmd> [--project <legacy-source-root>] [--state <new-state-root>]\n  node scripts/setup.mjs install [--apply] [--state <state-root>] [--codex-home <home>]\n  node scripts/setup.mjs uninstall [--apply] [--state <state-root>] [--codex-home <original-home>]\nAll supported conversations are monitored; task sources register automatically. No operation creates a model task, scheduler or trusted-hook record.');
}
