import test from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { TaskTools } from '../src/task-tools.js';
import type { ToolRuntimeOptions } from '../src/task-tools.js';
import { runJob } from '../src/job-runner.js';
import { ToolStore } from '../src/tool-store.js';
import type { Job } from '../src/tool-store.js';
import { defaultQuotaPolicy } from '../src/quota.js';
import { baseTime, errorCode, fixture } from './helpers.js';
import type { Command } from '../src/contracts.js';
import { HandoffError } from '../src/contracts.js';

function usage(now: number, usedPercent = 1) { return { ordinaryUsageAllowed: true,
  rateLimitsByLimitId: { codex: { spendControlReached: false, primary: { usedPercent, windowDurationMins: 300, resetsAt: Math.floor(now / 1000) + 3600 },
    secondary: { usedPercent, windowDurationMins: 10080, resetsAt: Math.floor(now / 1000) + 604800 } } } }; }
function setup(t: TestContext, options: ToolRuntimeOptions = {}, realClock = false) {
  const f = fixture(t), endpoint = path.join(f.root, 'endpoint.json'), config = path.join(f.root, 'tools.json');
  if (realClock) f.advance(Date.now() - baseTime);
  const now = realClock ? Date.now : () => baseTime;
  writeFileSync(endpoint, JSON.stringify({ launcher: path.join(f.root, 'dsh.cmd'), profile: 'work-handoff-fixture', provider: 'deepseek-account', model: 'deepseek-flash', maxTokens: 4096 }));
  writeFileSync(config, JSON.stringify({ schemaVersion: 1, db: f.db, store: path.join(f.root, 'tools.sqlite'), workRoot: f.workRoot,
    endpointFile: endpoint, resourceRoots: [f.resources], quotaPolicy: defaultQuotaPolicy }));
  const tools = new TaskTools(config, { clock: now, ...options }); f.onCleanup(() => tools.close());
  f.publish();
  const ctx = { taskId: 'task-a', conversationId: 'original-chat' }, call = (name: string, args: Record<string, unknown> = {}) => tools.call(name, { ...ctx, ...args });
  const revision = () => f.ledger.getTask('task-a').revision;
  const quota = () => tools.call('handoff_record_quota', { usage: usage(now()), observedAt: now() });
  return { ...f, tools, config, endpoint, now, ctx, call, revision, quota };
}
test('an execution without a time limit is not marked uncertain only because five minutes elapsed', async t => {
  let clock = baseTime;
  const f = setup(t, { clock: () => clock, launchJob: () => 123 });
  f.ledger.publishPacket({ ...f.packet('task-a', 2), deadlineAt: null }, f.ledger.getTask('task-a').revision);
  await f.quota(); const command = f.enqueue();
  await f.tools.call('handoff_dispatch', { commandId: command.id, conversationId: 'original-chat', plan: { outputs: ['input.txt'], deletions: [] } });
  f.advance(600_000); clock += 600_000;
  await f.tools.call('handoff_record_quota', { usage: usage(clock), observedAt: clock });
  const status = await f.call('handoff_status') as { action: string };
  assert.equal(status.action, 'await_harness_or_work');
});

test('task tools retain conversation, resource root and work root scope without broadening host permissions', async t => {
  const f = setup(t);
  await assert.rejects(f.call('handoff_status', { conversationId: 'other-chat' }), errorCode('WRONG_CONVERSATION'));
  const outside = path.join(f.root, 'other'); mkdirSync(outside);
  await assert.rejects(f.tools.call('handoff_publish', { input: { ...f.input('other-task'), resourceRoot: outside }, revision: null }), errorCode('RESOURCE_ROOT_NOT_ALLOWED'));
  await assert.rejects(f.tools.call('handoff_publish', { input: { ...f.input('other-task'), workRoot: outside }, revision: null }), errorCode('WRONG_WORK_ROOT'));
  await assert.rejects(f.call('handoff_status', { unsafe: true }), errorCode('UNKNOWN_FIELD'));
});

test('threshold confirmation blocks packaging and new dispatch before the user choice; decline stays blocked', async t => {
  const f=setup(t,{launchJob:()=>{throw Error('must not launch');}});
  await f.tools.call('handoff_record_quota',{usage:usage(baseTime,72),observedAt:baseTime});
  const input=f.input('pending-task');
  await assert.rejects(f.tools.call('handoff_publish',{input,revision:null}),errorCode('HANDOFF_CONFIRMATION_REQUIRED'));
  await assert.rejects(f.tools.call('handoff_prepare_context',{taskId:input.taskId,conversationId:input.conversationId}),errorCode('HANDOFF_CONFIRMATION_REQUIRED'));
  const command=f.enqueue();
  await assert.rejects(f.tools.call('handoff_dispatch',{commandId:command.id,conversationId:'original-chat'}),errorCode('HANDOFF_CONFIRMATION_REQUIRED'));
  const args={taskId:input.taskId,conversationId:input.conversationId,title:input.title};
  let prompts=0;const interaction={prompt:async()=>{prompts++;return 'decline' as const;}};
  assert.equal((await f.tools.call('handoff_confirm',args,interaction) as {allowed:boolean}).allowed,false);
  await f.tools.call('handoff_confirm',args,interaction);assert.equal(prompts,1);
  await assert.rejects(f.tools.call('handoff_publish',{input,revision:null}),errorCode('HANDOFF_CONFIRMATION_REQUIRED'));
  await f.tools.call('handoff_confirm',{...args,reconsider:true},{prompt:async()=> 'handoff'});
  assert((await f.tools.call('handoff_publish',{input,revision:null}) as {task:unknown}).task);
});
test('async dispatch persists a unique launch intent, handles lost response and refuses plan changes', async t => {
  let launches = 0;
  const f = setup(t, { launchJob: () => { launches++; return 123; } }), command = f.enqueue();
  await assert.rejects(f.tools.call('handoff_dispatch', { commandId: command.id, conversationId: 'original-chat' }), errorCode('QUOTA_NOT_READY'));
  await f.quota();
  const args = { commandId: command.id, conversationId: 'original-chat', plan: { outputs: ['input.txt'], deletions: [], timeoutMs: 5000 } };
  assert.equal((await f.tools.call('handoff_dispatch', args) as { started: boolean }).started, true);
  assert.equal((await f.tools.call('handoff_dispatch', args) as { started: boolean }).started, false); assert.equal(launches, 1);
  await assert.rejects(f.tools.call('handoff_dispatch', { ...args, plan: { ...args.plan, timeoutMs: 6000 } }), errorCode('JOB_PLAN_CONFLICT'));
  const another = new TaskTools(f.config); try { assert.equal((await another.call('handoff_dispatch', args) as { started: boolean }).started, false); } finally { another.close(); }
});
test('uncertain launch stays unknown across reopen and never silently starts another model', async t => {
  let launches = 0; const f = setup(t, { launchJob: () => { launches++; throw new Error('simulated spawn uncertainty'); } }), command = f.enqueue(); await f.quota();
  const args = { commandId: command.id, conversationId: 'original-chat' };
  await assert.rejects(f.tools.call('handoff_dispatch', args));
  const again = await f.tools.call('handoff_dispatch', args) as { started: boolean; needsReconciliation: boolean };
  assert.equal(again.started, false); assert.equal(again.needsReconciliation, true); assert.equal(launches, 1);
  assert.equal((await f.call('handoff_next') as { action: string }).action, 'reconcile');
});
test('background job consumes its exact intent once and terminal receipt can settle interrupted bookkeeping', async t => {
  let job: Job | undefined;
  const f = setup(t, { launchJob: value => { job = value; return 123; } }, true), command = f.enqueue(); await f.quota();
  await f.tools.call('handoff_dispatch', { commandId: command.id, conversationId: 'original-chat' }); assert(job);
  const peer = fileURLToPath(new URL('./fixtures/harness-peer.js', import.meta.url));
  await runJob(f.config, command.id, job.token, { launch: (_endpoint, cwd) => ({ executable: process.execPath, args: [peer], cwd }) });
  assert.equal(f.ledger.getCommand(command.id).status, 'succeeded'); assert.equal(f.tools.store.get<Job>('job', command.id)?.phase, 'settled');
  await assert.rejects(runJob(f.config, command.id, job.token), errorCode('JOB_NOT_RESERVED'));
  f.tools.store.update(command.id, job.token, previous => ({ ...previous, phase: 'unknown' }));
  await f.tools.call('handoff_recover_receipt', { commandId: command.id, conversationId: 'original-chat' });
  assert.equal(f.tools.store.get<Job>('job', command.id)?.phase, 'settled');
  assert.equal(readFileSync(path.join(f.ledger.executionDirectory(command.id), '.fixture-prompt-count'), 'utf8'), '1\n');
});
test('GPT round trip requires actual review, writes with backup, verifies originals and completes', async t => {
  const f = setup(t), command = f.enqueue('task-a', 'work'); await f.quota();
  const context = { commandId: command.id, conversationId: 'original-chat' };
  const started = await f.tools.call('handoff_work_begin', context) as { directory: string };
  writeFileSync(path.join(started.directory, 'input.txt'), 'GPT reviewed output\n');
  const result = await f.tools.call('handoff_work_finish', { ...context, summary: 'done', acceptanceNotes: ['checked actual file'], files: ['input.txt'], deletions: [] }) as { command: Command; snapshot: { id: string } };
  const snapshotId = result.snapshot.id, resultId = result.command.resultId;
  await assert.rejects(f.tools.call('handoff_prepare_commit', { snapshotId, conversationId: 'original-chat', revision: f.revision() }), errorCode('REVIEW_REQUIRED'));
  const read = await f.tools.call('handoff_read_snapshot', { snapshotId, conversationId: 'original-chat', files: ['input.txt'] }) as { contents: { text: string }[] };
  assert.equal(read.contents[0]?.text, 'GPT reviewed output\n');
  await assert.rejects(f.tools.call('handoff_read_snapshot', { snapshotId, conversationId: 'original-chat', files: ['../second.txt'] }));
  await f.call('handoff_review', { revision: f.revision(), snapshotId, resultId, decision: 'accept', reason: 'Compared the actual content to the explicit requirement.' });
  await assert.rejects(f.call('handoff_complete', { revision: f.revision(), resultId }), errorCode('WRITEBACK_REQUIRED'));
  const commit = await f.tools.call('handoff_prepare_commit', { snapshotId, conversationId: 'original-chat', revision: f.revision() }) as { id: string };
  await f.tools.call('handoff_apply_commit', { commitId: commit.id, conversationId: 'original-chat' });
  assert.equal(readFileSync(path.join(f.tools.files.backupDirectory(commit.id), 'input.txt'), 'utf8'), 'only designated task content\n');
  assert.equal(readFileSync(path.join(f.resources, 'input.txt'), 'utf8'), 'GPT reviewed output\n');
  writeFileSync(path.join(f.resources, 'input.txt'), 'external change\n');
  await assert.rejects(f.call('handoff_complete', { revision: f.revision(), resultId }), errorCode('RESOURCE_CHANGED'));
  writeFileSync(path.join(f.resources, 'input.txt'), 'GPT reviewed output\n');
  await f.call('handoff_complete', { revision: f.revision(), resultId }); assert.equal(f.ledger.getTask('task-a').stage, 'completed');
});
test('GPT pause retains a stage snapshot and settles only the cooperative current execution', async t => {
  const f = setup(t), command = f.enqueue('task-a', 'work'); await f.quota();
  const context = { commandId: command.id, conversationId: 'original-chat' };
  const began = await f.tools.call('handoff_work_begin', context) as { directory: string };
  writeFileSync(path.join(began.directory, 'input.txt'), 'partial GPT progress\n');
  await f.call('handoff_control', { revision: f.revision(), operation: 'pause', idempotencyKey: 'pause-exact' });
  assert.equal(f.ledger.getTask('task-a').control, 'pause_requested');
  await assert.rejects(f.tools.call('handoff_work_finish', { ...context, summary: 'invalid finish while pausing', acceptanceNotes: [], files: ['input.txt'], deletions: [] }), errorCode('TASK_NOT_OPEN'));
  const stopped = await f.tools.call('handoff_work_stop', { ...context, files: ['input.txt'], deletions: [], reason: 'Current executor stopped editing.' }) as { snapshot: { id: string } };
  assert.equal(f.ledger.getTask('task-a').control, 'paused');
  assert.equal(readFileSync(path.join(f.tools.files.snapshotDirectory(stopped.snapshot.id), 'input.txt'), 'utf8'), 'partial GPT progress\n');
  assert.equal(readFileSync(path.join(f.resources, 'input.txt'), 'utf8'), 'only designated task content\n');
});
test('a failed GPT copy preparation settles as failed rather than leaving a fictitious running executor', async t => {
  const f = setup(t), command = f.enqueue('task-a', 'work'); await f.quota();
  const original = f.tools.files.prepareExecution.bind(f.tools.files);
  f.tools.files.prepareExecution = () => { throw new HandoffError('FIXTURE_DISK_FAILURE', 'simulated owned fixture disk failure'); };
  try { await assert.rejects(f.tools.call('handoff_work_begin', { commandId: command.id, conversationId: 'original-chat' }), errorCode('FIXTURE_DISK_FAILURE')); }
  finally { f.tools.files.prepareExecution = original; }
  assert.equal(f.ledger.getCommand(command.id).status, 'failed');
  assert.equal(readFileSync(path.join(f.resources, 'input.txt'), 'utf8'), 'only designated task content\n');
});
test('tool-mediated Harness rework inherits the reviewed snapshot and then requires GPT finish', async t => {
  let job: Job | undefined;
  const f = setup(t, { launchJob: value => { job = value; return 123; } }, true); await f.quota();
  const peer = fileURLToPath(new URL('./fixtures/harness-peer.js', import.meta.url));
  const execute = async (command: Command, mode: string) => {
    await f.tools.call('handoff_dispatch', { commandId: command.id, conversationId: 'original-chat' }); assert(job);
    await runJob(f.config, command.id, job.token, { launch: (_endpoint, cwd) => ({ executable: process.execPath, args: [peer, mode], cwd }) });
    const status = await f.call('handoff_status') as { attempts: { commandId: string; snapshotId: string }[] };
    return { command: f.ledger.getCommand(command.id), snapshotId: status.attempts.find(a => a.commandId === command.id)!.snapshotId };
  };
  const first = await execute(f.enqueue(), 'success');
  await f.call('handoff_review', { revision: f.revision(), resultId: first.command.resultId, snapshotId: first.snapshotId, decision: 'rework', reason: 'Refine the actual fixture content.' });
  const revised = await execute(f.enqueue('task-a', 'harness', 'rework'), 'verify-seed');
  assert.equal(readFileSync(path.join(f.tools.files.snapshotDirectory(revised.snapshotId), 'input.txt'), 'utf8'), 'refined previous result\n');
  await assert.rejects(f.call('handoff_review', { revision: f.revision(), resultId: revised.command.resultId, snapshotId: revised.snapshotId, decision: 'rework', reason: 'Attempt forbidden second rework.' }), errorCode('REWORK_LIMIT'));
  const finish = f.enqueue('task-a', 'work', 'finish');
  await assert.rejects(f.tools.call('handoff_work_begin', { commandId: finish.id, conversationId: 'original-chat' }), errorCode('FINISH_SEED_REQUIRED'));
  const began = await f.tools.call('handoff_work_begin', { commandId: finish.id, conversationId: 'original-chat', seedSnapshotId: revised.snapshotId }) as { directory: string };
  assert.equal(readFileSync(path.join(began.directory, 'input.txt'), 'utf8'), 'refined previous result\n');
  writeFileSync(path.join(began.directory, 'input.txt'), 'GPT final output\n');
  const final = await f.tools.call('handoff_work_finish', { commandId: finish.id, conversationId: 'original-chat', summary: 'GPT finish', acceptanceNotes: ['read actual content'], files: ['input.txt'], deletions: [] }) as { command: Command; snapshot: { id: string } };
  await f.call('handoff_review', { revision: f.revision(), resultId: final.command.resultId, snapshotId: final.snapshot.id, decision: 'accept', reason: 'Final output meets fixture requirement.' });
  const commit = await f.tools.call('handoff_prepare_commit', { snapshotId: final.snapshot.id, conversationId: 'original-chat', revision: f.revision() }) as { id: string };
  await f.tools.call('handoff_apply_commit', { commitId: commit.id, conversationId: 'original-chat' });
  await f.call('handoff_complete', { revision: f.revision(), resultId: final.command.resultId });
  assert.equal(f.ledger.getTask('task-a').reworkCount, 1); assert.equal(f.ledger.getTask('task-a').stage, 'completed');
});
test('tool quota store refuses old observations and never stores raw native account fields', async t => {
  const f = setup(t); await f.quota();
  await assert.rejects(f.tools.call('handoff_record_quota', { usage: usage(baseTime), observedAt: baseTime - 1 }), errorCode('STALE_QUOTA_UPDATE'));
  assert.equal((await f.call('handoff_next') as { action: string }).action, 'gpt_work');
  await f.tools.call('handoff_record_quota', { usage: usage(baseTime, 90), observedAt: baseTime });
  assert.equal((await f.call('handoff_next') as { action: string }).action, 'wait_quota');
  const data = readFileSync(f.tools.config.store); assert(!data.includes(Buffer.from('accountId')));
});
test('official MCP client negotiates stdio, discovers tools and rejects malformed requests without models', async t => {
  const f = setup(t, {}, true), client = new Client({ name: 'owned-local-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/mcp-server.js', import.meta.url)), '--config', f.config], stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport);
    const listed = await client.listTools(); assert(listed.tools.some(tool => tool.name === 'handoff_dispatch'));
    const capabilities = await client.callTool({ name: 'handoff_capabilities', arguments: {} }); assert(!capabilities.isError);
    const rejected = await client.callTool({ name: 'handoff_status', arguments: { taskId: 'task-a', conversationId: 'wrong' } });
    assert.equal(rejected.isError, true); assert(JSON.stringify(rejected).includes('WRONG_CONVERSATION'));
    assert.equal((await client.callTool({ name: 'handoff_status', arguments: { taskId: 7 } })).isError, true);
  } finally { await client.close(); }
});
test('an actual detached job survives MCP client closure and sends exactly one fixture prompt', { skip: process.platform !== 'win32' }, async t => {
  const f = setup(t, {}, true), command = f.enqueue(); await f.quota();
  const peer = fileURLToPath(new URL('./fixtures/harness-peer.js', import.meta.url));
  writeFileSync(path.join(f.root, 'dsh.cmd'), `@echo off\r\n"${process.execPath}" "${peer}"\r\n`);
  const client = new Client({ name: 'owned-disconnect-test', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/mcp-server.js', import.meta.url)), '--config', f.config], stderr: 'pipe' });
  transport.stderr?.on('data', () => {});
  try {
    await client.connect(transport);
    const sent = await client.callTool({ name: 'handoff_dispatch', arguments: { commandId: command.id, conversationId: 'original-chat' } });
    assert(!sent.isError, JSON.stringify(sent));
  } finally { await client.close(); }
  const deadline = Date.now() + 15_000;
  while (!['settled', 'unknown'].includes(f.tools.store.get<Job>('job', command.id)?.phase ?? '')) {
    assert(Date.now() < deadline, 'owned background job did not settle'); await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.equal(f.ledger.getCommand(command.id).status, 'succeeded');
  assert.equal(f.tools.store.get<Job>('job', command.id)?.phase, 'settled');
  assert.equal(readFileSync(path.join(f.ledger.executionDirectory(command.id), '.fixture-prompt-count'), 'utf8'), '1\n');
  assert.equal(readFileSync(path.join(f.resources, 'input.txt'), 'utf8'), 'only designated task content\n');
});
test('tool database rejects a foreign schema without changing it', async t => {
  const f = setup(t), foreign = path.join(f.root, 'foreign.sqlite');
  const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(foreign); db.exec('CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES (\'keep\');'); db.close();
  const before = readFileSync(foreign); assert.throws(() => new ToolStore(foreign), errorCode('UNSUPPORTED_TOOL_DATABASE'));
  assert.deepEqual(readFileSync(foreign), before);
});
