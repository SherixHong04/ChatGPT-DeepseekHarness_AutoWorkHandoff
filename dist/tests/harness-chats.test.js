import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HarnessChatManager, apply } from '../src/harness-chat-plugin.js';
import { chatPolicy, FileChatPort, initializeChatQueue, newChatBinding, validateChatOperation } from '../src/harness-chats.js';
import { TaskTools } from '../src/task-tools.js';
import { defaultQuotaPolicy } from '../src/quota.js';
import { HandoffError } from '../src/contracts.js';
import { baseTime, errorCode, fixture } from './helpers.js';
function setup(t) {
    const f = fixture(t), queueRoot = path.join(f.root, 'chat-queue'), workspaceRoot = path.join(f.workRoot, 'GPT-handoff');
    mkdirSync(queueRoot);
    mkdirSync(workspaceRoot);
    const policy = chatPolicy({ queueRoot, workspaceRoot, enabledAt: baseTime });
    initializeChatQueue(policy);
    const binding = (taskId = 'task-a') => newChatBinding(f.packet(taskId), policy);
    const sessions = new Map();
    const active = new Set(), archived = [], workspaces = new Map();
    let creates = 0, renames = 0, archives = 0, failCreate = 'none', failArchive = false;
    const host = {
        workspaceRegistry: {
            async resolveByPath(directory) { return [...workspaces.values()].find(w => w.path === directory); },
            async create(directory) {
                const workspace = { id: 'ws-' + workspaces.size, path: directory, sessionIds: [],
                    async attachSession(sessionId) {
                        assert.equal(sessions.get(sessionId)?.cwd, directory);
                        if (!workspace.sessionIds.includes(sessionId))
                            workspace.sessionIds.push(sessionId);
                    } };
                workspaces.set(workspace.id, workspace);
                return workspace;
            },
            get: id => workspaces.get(id), archivedSessionIds: archived,
            async archiveSession(sessionId) {
                assert.equal(arguments.length, 1, 'no stopActivity option');
                if (active.has(sessionId))
                    throw new HandoffError('workspace/session-active', 'active');
                if (failArchive)
                    throw new HandoffError('FIXTURE_ARCHIVE_FAILED', 'owned failure');
                if (!archived.includes(sessionId)) {
                    archives++;
                    archived.push(sessionId);
                }
            },
        },
        sessionController: {
            async create({ sessionId, workspaceId }) {
                creates++;
                if (failCreate === 'before')
                    throw new Error('create failed before reply');
                const ws = workspaces.get(workspaceId);
                sessions.set(sessionId, { cwd: ws.path, title: null, sequence: -1 });
                await ws.attachSession(sessionId);
                if (failCreate === 'after')
                    throw new Error('created but reply lost');
                return { sessionId };
            },
            async rename({ sessionId, title }) { renames++; const s = sessions.get(sessionId); s.title = title; return { title, seq: ++s.sequence }; },
        },
        sessionQuery: { async observeSession(sessionId) {
                const s = sessions.get(sessionId);
                if (!s)
                    throw Object.assign(new Error('missing'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' });
                return { header: { id: sessionId, cwd: s.cwd }, events: [], projections: { asOfSeq: s.sequence, values: { title: s.title } }, [Symbol.dispose]() { } };
            } },
        async waterfall(_event, { sessionId }) { return active.has(sessionId) ? ['running turn'] : []; },
    };
    const manager = new HarnessChatManager(host, policy);
    return { ...f, policy, binding, sessions, active, archived, workspaces, host, manager,
        counts: () => ({ creates, renames, archives }), failCreate: (mode) => { failCreate = mode; },
        failArchive: (value) => { failArchive = value; } };
}
test('new managed tasks share one real workspace, receive names, and retries preserve user renames', async (t) => {
    const f = setup(t), first = f.binding(), second = f.binding('task-b');
    const a = await f.manager.call({ kind: 'prepare', binding: first }), b = await f.manager.call({ kind: 'prepare', binding: second });
    assert.equal(a.workspaceId, b.workspaceId);
    assert.equal(f.workspaces.size, 1);
    assert.notEqual(a.sessionId, b.sessionId);
    assert.match(a.title, /^GPT交接 · /);
    f.sessions.get(first.sessionId).title = '用户自己的标题';
    assert.equal((await f.manager.call({ kind: 'prepare', binding: first })).title, '用户自己的标题');
    assert.deepEqual(f.counts(), { creates: 2, renames: 2, archives: 0 });
    assert.equal(newChatBinding({ ...f.packet(), version: 2, title: 'revised title' }, f.policy).sessionId, first.sessionId);
});
test('legacy dates, foreign identifiers and pre-existing unregistered chats are never taken over', async (t) => {
    const f = setup(t), binding = f.binding();
    await assert.rejects(f.manager.call({ kind: 'prepare', binding: { ...binding, createdAt: baseTime - 1 } }), errorCode('CHAT_LEGACY_EXCLUDED'));
    assert.throws(() => validateChatOperation({ kind: 'prepare', binding: { ...binding, sessionId: 'ordinary-chat' } }), errorCode('CHAT_IDENTITY_MISMATCH'));
    f.sessions.set(binding.sessionId, { cwd: f.resources, title: 'existing', sequence: 7 });
    await assert.rejects(f.manager.call({ kind: 'prepare', binding }), errorCode('CHAT_ALREADY_EXISTS_UNMANAGED'));
    assert.equal(f.sessions.get(binding.sessionId)?.title, 'existing');
    assert.equal(f.workspaces.size, 0);
    assert.equal(f.counts().renames, 0);
});
test('a lost creation receipt reconciles the exact session; an unknown non-creation is not sent again', async (t) => {
    const f = setup(t), binding = f.binding();
    f.failCreate('after');
    await assert.rejects(f.manager.call({ kind: 'prepare', binding }));
    f.failCreate('none');
    assert.equal((await f.manager.call({ kind: 'prepare', binding })).sessionId, binding.sessionId);
    assert.equal(f.counts().creates, 1);
    const another = f.binding('task-b');
    f.failCreate('before');
    await assert.rejects(f.manager.call({ kind: 'prepare', binding: another }));
    f.failCreate('none');
    await assert.rejects(f.manager.call({ kind: 'prepare', binding: another }), errorCode('CHAT_CREATE_UNKNOWN'));
    assert.equal(f.counts().creates, 2);
});
test('archive requires the reviewed version and idle state, is idempotent, and preserves chat history', async (t) => {
    const f = setup(t), binding = f.binding(), prepared = await f.manager.call({ kind: 'prepare', binding });
    const operation = { kind: 'archive', binding, approval: { resultId: 'result', snapshotId: 'snapshot', sequence: prepared.sequence } };
    f.active.add(binding.sessionId);
    await assert.rejects(f.manager.call(operation), errorCode('CHAT_STILL_ACTIVE'));
    f.active.clear();
    f.sessions.get(binding.sessionId).sequence++;
    await assert.rejects(f.manager.call(operation), errorCode('CHAT_CHANGED_AFTER_REVIEW'));
    operation.approval.sequence++;
    assert.equal((await f.manager.call(operation)).archived, true);
    assert.equal((await f.manager.call(operation)).archived, true);
    assert.equal(f.counts().archives, 1);
    assert(f.sessions.has(binding.sessionId));
    assert.equal(f.workspaces.get(prepared.workspaceId)?.sessionIds.includes(binding.sessionId), true);
});
test('archive failures and workspace mismatches leave the registered conversation visible', async (t) => {
    const f = setup(t), binding = f.binding(), state = await f.manager.call({ kind: 'prepare', binding });
    f.failArchive(true);
    await assert.rejects(f.manager.call({ kind: 'archive', binding, approval: { resultId: 'result', snapshotId: 'snapshot', sequence: state.sequence } }), errorCode('FIXTURE_ARCHIVE_FAILED'));
    assert.equal(f.archived.length, 0);
    f.sessions.get(binding.sessionId).cwd = f.resources;
    await assert.rejects(f.manager.call({ kind: 'inspect', binding }), errorCode('CHAT_WORKSPACE_MISMATCH'));
});
test('the official plugin and file client exchange real requests without a model, listener or idle polling timer', async (t) => {
    const f = setup(t), disposers = [];
    writeFileSync(path.join(f.policy.queueRoot, 'requests', '0'.repeat(64) + '.json'), '{invalid request');
    await apply({ ...f.host, effect(action) { disposers.push(action()); }, logger: { warn() { } } }, f.policy);
    f.onCleanup(() => { for (const dispose of disposers)
        dispose(); });
    const port = new FileChatPort(f.policy, 2000), binding = f.binding();
    await port.call({ kind: 'prepare', binding });
    await port.call({ kind: 'prepare', binding });
    const state = await port.call({ kind: 'inspect', binding });
    assert.equal(f.counts().creates, 1);
    f.active.add(binding.sessionId);
    const archive = { kind: 'archive', binding, approval: { resultId: 'result', snapshotId: 'snapshot', sequence: state.sequence } };
    await assert.rejects(port.call(archive), errorCode('CHAT_STILL_ACTIVE'));
    f.active.clear();
    assert.equal((await port.call(archive)).archived, true);
    assert.equal((await port.call({ kind: 'inspect', binding })).archived, true);
});
test('replaying an old published packet cannot enroll its historical task into new chat management', async (t) => {
    const f = toolSetup(t);
    f.ledger.publishPacket(f.packet(), null);
    await f.publish();
    await assert.rejects(f.call('handoff_chat_prepare'), errorCode('CHAT_LEGACY_EXCLUDED'));
    assert.equal(f.counts().creates, 0);
});
test('missing or mismatched plugin readiness cannot create an ungrouped fallback conversation', async (t) => {
    const f = setup(t), port = new FileChatPort(f.policy, 100);
    await assert.rejects(port.call({ kind: 'prepare', binding: f.binding() }), errorCode('HARNESS_CHAT_PLUGIN_UNAVAILABLE'));
    writeFileSync(path.join(f.policy.queueRoot, 'ready.json'), JSON.stringify({ protocol: 'other' }));
    await assert.rejects(port.call({ kind: 'prepare', binding: f.binding() }), errorCode('HARNESS_CHAT_PLUGIN_MISMATCH'));
    assert.equal(f.counts().creates, 0);
});
function toolSetup(t) {
    const f = setup(t), endpoint = path.join(f.root, 'endpoint.json'), config = path.join(f.root, 'tools.json');
    writeFileSync(endpoint, JSON.stringify({ launcher: path.join(f.root, 'dsh.cmd'), profile: 'work-handoff-fixture', provider: 'deepseek-account', model: 'deepseek-flash' }));
    writeFileSync(config, JSON.stringify({ schemaVersion: 1, db: f.db, store: path.join(f.root, 'tools.sqlite'), workRoot: f.workRoot,
        endpointFile: endpoint, resourceRoots: [f.resources], quotaPolicy: defaultQuotaPolicy, chatManagement: f.policy }));
    const port = { call: operation => f.manager.call(operation) }, tools = new TaskTools(config, { clock: () => baseTime, chatPort: port });
    f.onCleanup(() => tools.close());
    const context = { taskId: 'task-a', conversationId: 'original-chat' }, revision = () => f.ledger.getTask('task-a').revision;
    const call = (name, args = {}) => tools.call(name, { ...context, ...args });
    const quota = () => tools.call('handoff_record_quota', { observedAt: baseTime, usage: { ordinaryUsageAllowed: true, rateLimitsByLimitId: { codex: {
                    spendControlReached: false, primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: baseTime / 1000 + 3600 },
                    secondary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: baseTime / 1000 + 604800 }
                } } } });
    const publish = () => tools.call('handoff_publish', { input: f.input(), revision: null });
    const gptResult = async () => {
        await quota();
        const command = f.enqueue('task-a', 'work');
        const started = await tools.call('handoff_work_begin', { commandId: command.id, conversationId: 'original-chat' });
        // A no-change result is sufficient to test completion and archive policy without unrelated writeback.
        assert.equal(readFileSync(path.join(started.directory, 'input.txt'), 'utf8'), 'only designated task content\n');
        return tools.call('handoff_work_finish', { commandId: command.id, conversationId: 'original-chat', summary: 'verified unchanged',
            acceptanceNotes: ['actual content inspected'], files: ['input.txt'], deletions: [] });
    };
    return { ...f, tools, call, revision, publish, gptResult };
}
test('task tools register only newly published tasks and preserve the new chat identity across packet revisions', async (t) => {
    const f = toolSetup(t);
    f.ledger.publishPacket(f.packet('legacy-task'), null);
    await assert.rejects(f.tools.call('handoff_chat_prepare', { taskId: 'legacy-task', conversationId: 'original-chat' }), errorCode('CHAT_LEGACY_EXCLUDED'));
    await f.publish();
    const first = await f.call('handoff_chat_prepare');
    await f.tools.call('handoff_publish', { input: f.input('task-a', 2), revision: f.revision() });
    const again = await f.call('handoff_chat_prepare');
    assert.equal(again.binding.sessionId, first.binding.sessionId);
    await assert.rejects(f.call('handoff_chat_prepare', { conversationId: 'another-chat' }), errorCode('WRONG_CONVERSATION'));
    const queued = f.enqueue();
    await assert.rejects(f.tools.call('handoff_dispatch', { commandId: queued.id, conversationId: 'original-chat' }), errorCode('MANAGED_PLAN_REQUIRED'));
    assert.equal(f.ledger.getCommand(queued.id).status, 'queued');
    assert.equal(f.counts().creates, 1);
});
test('completion automatically archives an accepted new chat, while an unaccepted result cannot archive it', async (t) => {
    const f = toolSetup(t);
    await f.publish();
    await f.call('handoff_chat_prepare');
    const output = await f.gptResult();
    await assert.rejects(f.call('handoff_chat_archive', { resultId: output.command.resultId }), errorCode('REVIEW_REQUIRED'));
    await f.call('handoff_review', { revision: f.revision(), snapshotId: output.snapshot.id, resultId: output.command.resultId,
        decision: 'accept', reason: 'Read and checked the current artifact and conversation.' });
    const done = await f.call('handoff_complete', { revision: f.revision(), resultId: output.command.resultId });
    assert.equal(done.chatManagement.status, 'archived');
    assert.equal(f.ledger.getTask('task-a').stage, 'completed');
    assert.equal((await f.call('handoff_chat_archive', { resultId: output.command.resultId })).status, 'archived');
    assert.equal(f.counts().archives, 1);
});
test('a newer user turn prevents archive but does not undo completion or resend work', async (t) => {
    const f = toolSetup(t);
    await f.publish();
    const prepared = await f.call('handoff_chat_prepare');
    const output = await f.gptResult();
    await f.call('handoff_review', { revision: f.revision(), snapshotId: output.snapshot.id,
        resultId: output.command.resultId, decision: 'accept', reason: 'actual prior version accepted' });
    f.sessions.get(prepared.state.sessionId).sequence++;
    const done = await f.call('handoff_complete', { revision: f.revision(), resultId: output.command.resultId });
    assert.equal(done.chatManagement.status, 'pending');
    assert.equal(done.chatManagement.reason, 'CHAT_CHANGED_AFTER_REVIEW');
    assert.equal(f.ledger.getTask('task-a').stage, 'completed');
    assert.equal(f.counts().archives, 0);
    assert.equal(f.ledger.listCommands('task-a').length, 1);
    assert(existsSync(f.resources));
});
test('a GPT-only task does not create an empty Harness conversation or require its management plugin to complete', async (t) => {
    const f = toolSetup(t);
    await f.publish();
    const output = await f.gptResult();
    await f.call('handoff_review', { revision: f.revision(), snapshotId: output.snapshot.id, resultId: output.command.resultId,
        decision: 'accept', reason: 'Actual GPT-only output checked; no Harness chat exists.' });
    const done = await f.call('handoff_complete', { revision: f.revision(), resultId: output.command.resultId });
    assert.equal(done.chatManagement.status, 'not-created');
    assert.equal(f.counts().creates, 0);
    assert.equal(f.counts().archives, 0);
});
test('test chat names are bounded UTF-8 and no forced archive or arbitrary management operation is accepted', t => {
    const f = setup(t);
    const named = newChatBinding({ ...f.packet('test-case'), title: '采购核对'.repeat(60) }, f.policy);
    assert.match(named.title, /^测试 · /);
    assert(Buffer.byteLength(named.title) <= 76);
    assert.throws(() => validateChatOperation({ kind: 'delete', binding: named }), errorCode('CHAT_OPERATION_NOT_ALLOWED'));
    assert.throws(() => validateChatOperation({ kind: 'archive', binding: named, stopActivity: true,
        approval: { resultId: 'r', snapshotId: 's', sequence: 0 } }), errorCode('UNKNOWN_FIELD'));
});
//# sourceMappingURL=harness-chats.test.js.map