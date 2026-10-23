// Read-only, no model/SDK/account calls, no task/chat/timer creation.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadToolsConfig } from '../dist/src/task-tools.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const { values } = parseArgs({ options: { config: { type: 'string' } } });
const checks = [], add = (name, passed, detail) => checks.push({ name, passed, detail });
const policy = JSON.parse(fs.readFileSync(path.join(root, 'config/compatibility-policy.json'), 'utf8'));
add('low-cost-policy', ['automaticModelTest', 'automaticTestChat', 'automaticTestTimer', 'increaseQuotaQueryFrequency', 'unknownExecutionMayResend', 'restoreWholeUserConfiguration'].every(key => policy[key] === false), 'Compatibility checks cannot create model tasks, chats or timers, increase quota frequency, resend unknown commands or restore whole user settings');
add('node-runtime', Number(process.versions.node.split('.')[0]) >= 24, process.versions.node);
add('platform', process.platform === 'win32', 'Windows preview; other systems not validated');
let signature = null;
try {
  if (!values.config) throw Error('Supply --config <generated tools.local.json>');
  const config = loadToolsConfig(path.resolve(values.config));
  add('config-schema-and-owned-paths', true, 'Input paths, separate databases and policy structure validated');
  add('global-conversation-monitoring', config.quotaHooks?.scope === 'all-conversations', 'Quota monitoring is separate from the legacy file root list');
  add('automatic-task-context', config.taskContext !== undefined, 'Current project, explicit references or a projectless brief can be prepared per task without editing global roots');
  const endpoint = JSON.parse(fs.readFileSync(config.endpointFile, 'utf8'));
  add('no-test-execution-or-token-limit', !('maxTokens' in endpoint), 'Execution deadline is optional; no trial override in generated config');
  for (const [file, protocol] of [['ready.json', 'work-handoff-chat-management-v1'], ['run-ready.json', 'work-handoff-managed-session-v1']]) {
    const filename = path.join(config.chatManagement.queueRoot, file);
    const record = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : null;
    add(file, record?.protocol === protocol && record.workspaceRoot === config.chatManagement.workspaceRoot,
      record ? 'Marker found; an actual operation still needs a fresh matching acknowledgement' : 'Plugin is not loaded; use normal Harness plugin installation/reload');
  }
  const ownVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
  signature = createHash('sha256').update(JSON.stringify({ config, ownVersion, node: process.versions.node,
    protocols: ['work-handoff-chat-management-v1', 'work-handoff-managed-session-v1'] })).digest('hex');
} catch (e) { add('configuration', false, e.message); }
const passed = checks.every(c => c.passed);
console.log(JSON.stringify({ stage: passed ? 'basic-check-passed-real-task-pending' : 'needs-attention', passed, signature, checks,
  modelCalls: 0, tasksCreated: 0, timersCreated: 0, nativeQuotaChecked: false, nativeHooksActuallyTriggered: false,
  appVersions: { gptDesktop: 'not-inferred-from-CLI', harnessDesktop: 'not-inferred-from-marker' },
  note: 'Use the next authorized real task as end-to-end validation. Do not claim full compatibility from file markers or this signature.' }, null, 2));
if (!passed) process.exitCode = 2;
