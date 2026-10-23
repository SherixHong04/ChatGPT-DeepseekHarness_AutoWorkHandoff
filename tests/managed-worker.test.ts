import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { TaskTools } from '../src/task-tools.js';
import type { ManagedPort } from '../src/managed-worker.js';
import type { RunState } from '../src/managed-session.js';
import { fixture, baseTime, errorCode } from './helpers.js';
import { defaultQuotaPolicy } from '../src/quota.js';
import type { TestContext } from 'node:test';
async function setup(t: TestContext) {
  const f = fixture(t), queue = path.join(f.root, 'queue'), shared = path.join(f.root, 'shared'); mkdirSync(queue); mkdirSync(shared);
  const endpoint = path.join(f.root, 'endpoint.json'), config = path.join(f.root, 'tools.json');
  writeFileSync(endpoint, JSON.stringify({ launcher: path.join(f.root, 'dsh.cmd'), profile: 'work-handoff-fixture', provider: 'deepseek-account', model: 'test' }));
  writeFileSync(config, JSON.stringify({ schemaVersion: 1, db: f.db, store: path.join(f.root, 'tools.sqlite'), workRoot: f.workRoot,
    endpointFile: endpoint, resourceRoots: [f.resources], quotaPolicy: defaultQuotaPolicy, chatManagement: { queueRoot: queue, workspaceRoot: shared, enabledAt: baseTime } }));
  let active = false, seq = 5, sends = 0, lost = false, changing = false, archived = false;
  const chat = (sessionId: string) => ({ sessionId, workspaceId: 'test-ws', title: 'task', sequence: seq, active, archived });
  const port: ManagedPort = async (_policy, input): Promise<RunState> => {
    if (input.kind === 'start') {
      sends++; active = true;
      if (lost) throw Error('owned lost acknowledgement');
      writeFileSync(path.join(input.directory, 'input.txt'), 'fixture worker result\n');
    }
    const observed = seq; if (changing) seq++;
    return { chat: { ...chat(input.binding.sessionId), sequence: observed }, phase: 'accepted', acceptedAt: baseTime,
      sequence: observed, turnReason: active ? null : 'completed', messages: [{ role: 'user', seq: observed, text: 'Latest real task requirement fixture' }] };
  };
  const tools = new TaskTools(config, { clock: () => baseTime, managedPort: port, chatPort: { async call(op) { if (op.kind === 'archive') archived = true; return chat(op.binding.sessionId); } } });
  f.onCleanup(() => tools.close());
  const ctx = { taskId: 'task-a', conversationId: 'original-chat' }, revision = () => f.ledger.getTask('task-a').revision;
  const call = (name: string, args = {}) => tools.call(name, { ...ctx, ...args });
  await tools.call('handoff_publish', { input: { ...f.input(), deadlineAt: null }, revision: null }); await call('handoff_chat_prepare');
  await tools.call('handoff_record_quota', { observedAt: baseTime, usage: { ordinaryUsageAllowed: true, rateLimitsByLimitId: { codex: {
    spendControlReached: false, primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: baseTime / 1000 + 3600 }, secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: baseTime / 1000 + 604800 } } } } });
  const command = f.enqueue(), args = { commandId: command.id, conversationId: 'original-chat', plan: { outputs: ['input.txt'], deletions: [] } };
  return { ...f, tools, call, command, args, revision, sends: () => sends, lost: () => { lost = true; },
    idle: () => { active = false; seq++; }, change: () => { seq++; }, changing: () => { changing = true; } };
}
test('formal managed tools dispatch once, wait while active, collect stable files and preserve original until commit', async t => {
  const f = await setup(t);
  assert.equal((await f.tools.call('handoff_dispatch', f.args) as { started: boolean }).started, true);
  assert.equal((await f.tools.call('handoff_dispatch', f.args) as { started: boolean }).started, false); assert.equal(f.sends(), 1);
  await assert.rejects(f.tools.call('handoff_managed_collect', { commandId: f.command.id, conversationId: 'original-chat' }), errorCode('HARNESS_STILL_WORKING'));
  f.idle(); const result = await f.tools.call('handoff_managed_collect', { commandId: f.command.id, conversationId: 'original-chat' }) as any;
  assert.equal(result.command.status, 'succeeded'); assert.equal(readFileSync(path.join(f.resources, 'input.txt'), 'utf8'), 'only designated task content\n');
  await f.call('handoff_review', { revision: f.revision(), resultId: result.command.resultId, snapshotId: result.snapshot.id, decision: 'accept', reason: 'fixture file inspected' });
  const commit = await f.tools.call('handoff_prepare_commit', { conversationId: 'original-chat', revision: f.revision(), snapshotId: result.snapshot.id }) as { id: string };
  f.change(); await assert.rejects(f.tools.call('handoff_apply_commit', { conversationId: 'original-chat', commitId: commit.id }), errorCode('CHAT_CHANGED_AFTER_REVIEW'));
  assert.equal(readFileSync(path.join(f.resources, 'input.txt'), 'utf8'), 'only designated task content\n');
});
test('uncertain desktop acceptance never sends a second prompt, including after reopening task tools', async t => {
  const f = await setup(t); f.lost(); await assert.rejects(f.tools.call('handoff_dispatch', f.args));
  assert.equal(f.ledger.getCommand(f.command.id).status, 'unknown');
  assert.equal((await f.tools.call('handoff_dispatch', f.args) as { started: boolean }).started, false); assert.equal(f.sends(), 1);
  const reopened = new TaskTools(f.tools.configFile, { clock: () => baseTime, managedPort: async () => { throw Error('Reopened client must never send'); } });
  try { assert.equal((await reopened.call('handoff_dispatch', f.args) as { started: boolean }).started, false); }
  finally { reopened.close(); }
  assert.equal(f.sends(), 1);
});
test('user continuation during collection prevents publishing a terminal result', async t => {
  const f = await setup(t); await f.tools.call('handoff_dispatch', f.args); f.idle(); f.changing();
  await assert.rejects(f.tools.call('handoff_managed_collect', { commandId: f.command.id, conversationId: 'original-chat' }), errorCode('CHAT_CHANGED_DURING_COLLECTION'));
  assert.equal(f.ledger.getCommand(f.command.id).status, 'running'); assert.equal(f.ledger.getCommand(f.command.id).resultId, null);
});
test('stable result becomes unreviewable if user continues before acceptance', async t => {
  const f = await setup(t); await f.tools.call('handoff_dispatch', f.args); f.idle();
  const result = await f.tools.call('handoff_managed_collect', { commandId: f.command.id, conversationId: 'original-chat' }) as any; f.change();
  await assert.rejects(f.call('handoff_review', { revision: f.revision(), resultId: result.command.resultId, snapshotId: result.snapshot.id, decision: 'accept', reason: 'old view' }), errorCode('CHAT_CHANGED_AFTER_COLLECTION'));
});
test('a genuine later user turn can be collected without sending a model request or using the rework allowance', async t => {
  const f = await setup(t); await f.tools.call('handoff_dispatch', f.args); f.idle();
  const first = await f.tools.call('handoff_managed_collect', { commandId: f.command.id, conversationId: 'original-chat' }) as any;
  await f.call('handoff_review', { revision: f.revision(), resultId: first.command.resultId, snapshotId: first.snapshot.id, decision: 'accept', reason: 'first fixture accepted' });
  const same = await f.tools.call('handoff_managed_collect', { commandId: f.command.id, conversationId: 'original-chat' }) as any;
  assert.equal(same.unchanged, true); f.change();
  const latest = await f.tools.call('handoff_managed_collect', { commandId: f.command.id, conversationId: 'original-chat' }) as any;
  assert.notEqual(latest.command.resultId, first.command.resultId); assert.notEqual(latest.snapshot.id, first.snapshot.id);
  assert.equal(f.sends(), 1); assert.equal(f.ledger.getTask('task-a').reworkCount, 0);
  await assert.rejects(f.call('handoff_review', { revision: f.revision(), resultId: first.command.resultId, snapshotId: first.snapshot.id, decision: 'accept', reason: 'old fixture view' }), errorCode('STALE_RESULT'));
});
test('formal shared pipeline accepts an actual fixture file, verifies backup, commits and archives once', async t => {
  const f = await setup(t); await f.tools.call('handoff_dispatch', f.args); f.idle();
  const result = await f.tools.call('handoff_managed_collect', { commandId: f.command.id, conversationId: 'original-chat' }) as any;
  await f.call('handoff_review', { revision: f.revision(), resultId: result.command.resultId, snapshotId: result.snapshot.id, decision: 'accept', reason: 'actual fixture bytes verified' });
  const commit = await f.tools.call('handoff_prepare_commit', { conversationId: 'original-chat', revision: f.revision(), snapshotId: result.snapshot.id }) as { id: string };
  assert.equal(readFileSync(path.join(f.tools.files.backupDirectory(commit.id), 'input.txt'), 'utf8'), 'only designated task content\n');
  await f.tools.call('handoff_apply_commit', { conversationId: 'original-chat', commitId: commit.id });
  assert.equal(readFileSync(path.join(f.resources, 'input.txt'), 'utf8'), 'fixture worker result\n');
  const final = await f.call('handoff_complete', { revision: f.revision(), resultId: result.command.resultId }) as any;
  assert.equal(final.stage, 'completed'); assert.equal(final.chatManagement.status, 'archived'); assert.equal(f.sends(), 1);
});
