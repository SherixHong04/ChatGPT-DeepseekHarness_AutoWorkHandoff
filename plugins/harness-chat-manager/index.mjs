import { name, inject as dependencies, apply as install } from './lib/harness-chat-plugin.js';
import { chatPolicy, readChatJson, atomicChatJson } from './lib/harness-chats.js';
import { checkedRoot, resourcePath } from './lib/packet.js';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { installManagedSession } from './lib/managed-session.js';
export { name };

// The normal host loads this entry. Record only our own dependency readiness,
// so a missing service is distinguishable from an unimported plugin. No prompts,
// conversation data, credentials or application settings are inspected here.
export function apply(ctx, config) {
  const raw = config?.configFile ? readChatJson(config.configFile) : config;
  const filename = resourcePath(checkedRoot(raw.queueRoot), 'host-load.json', false);
  const probe = {};
  try { probe.exists = existsSync(raw.workspaceRoot); probe.directory = lstatSync(raw.workspaceRoot).isDirectory(); probe.realpath = realpathSync(raw.workspaceRoot); }
  catch (error) { probe.errorCode = String(error?.code ?? error?.name); }
  atomicChatJson(filename, { phase: 'preflight', observedAt: Date.now(), pid: process.pid,
    platform: process.platform, nodeVersion: process.versions.node, workspaceRoot: raw.workspaceRoot,
    resolvedWorkspaceRoot: path.resolve(raw.workspaceRoot), probe });
  const policy = chatPolicy(raw);
  const write = (phase, errorCode) => atomicChatJson(filename, {
    phase, observedAt: Date.now(), pid: process.pid,
    dependencies: Object.fromEntries(dependencies.map(key => [key, Boolean(ctx.get(key))])),
    ...(errorCode ? { errorCode } : {}),
  });
  write('waiting-for-services');
  ctx.inject(dependencies, async child => {
    try { await install(child, policy); installManagedSession(child, policy); write('ready'); }
    catch (error) { write('failed', String(error?.code ?? error?.name ?? 'PLUGIN_START_FAILED')); throw error; }
  });
}
