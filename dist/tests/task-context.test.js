import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { TaskTools } from '../src/task-tools.js';
import { QuotaHookBridge, defaultQuotaHookPolicy } from '../src/quota-hooks.js';
import { defaultQuotaPolicy } from '../src/quota.js';
import { fixture, baseTime, errorCode } from './helpers.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
function setup(t) {
    const f = fixture(t), contexts = path.join(f.root, 'contexts');
    mkdirSync(contexts);
    const endpoint = path.join(f.root, 'endpoint.json'), config = path.join(f.root, 'tools.json');
    writeFileSync(endpoint, JSON.stringify({ launcher: path.join(f.root, 'dsh.cmd'), profile: 'work-handoff-context-fixture', provider: 'deepseek-account', model: 'unused' }));
    writeFileSync(config, JSON.stringify({ schemaVersion: 1, db: f.db, store: path.join(f.root, 'tools.sqlite'), workRoot: f.workRoot,
        endpointFile: endpoint, resourceRoots: [], quotaPolicy: defaultQuotaPolicy,
        quotaHooks: { ...defaultQuotaHookPolicy, scope: 'all-conversations' }, taskContext: { root: contexts } }));
    const tools = new TaskTools(config, { clock: () => baseTime });
    f.onCleanup(() => tools.close());
    const input = (taskId, conversationId, files) => {
        const { resourceRoot: _r, workRoot: _w, files: _f, ...rest } = f.input(taskId);
        return { ...rest, conversationId, deadlineAt: null, ...(files ? { files } : {}) };
    };
    const hook = (conversationId, cwd) => tools.call('handoff_hook_event', { conversationId, cwd, event: 'SessionStart' });
    return { ...f, tools, input, hook, contexts, config };
}
test('global checks cover independent projects and a chat without a directory, with no file grants', async (t) => {
    const f = setup(t), other = path.join(f.root, 'another project');
    mkdirSync(other);
    for (const [chat, cwd] of [['project-a', f.resources], ['project-b', other], ['no-project', ''], ['missing-project', path.join(f.root, 'gone')]]) {
        const result = await f.hook(chat, cwd);
        assert.match(result.hookSpecificOutput.additionalContext, /get_usage_limits/);
        assert.equal(f.tools.store.get('quota-hook', chat)?.conversationId, chat);
        assert.equal(f.tools.store.get('task-context', chat), null);
    }
    assert.equal(f.tools.ledger.listTasks().length, 0);
    assert.equal(f.tools.store.quota(), null);
});
test('two projects auto-publish from host context using relative names without editing configuration', async (t) => {
    const f = setup(t), projectB = path.join(f.root, 'project B');
    mkdirSync(projectB);
    mkdirSync(path.join(projectB, 'src'));
    writeFileSync(path.join(projectB, 'src', 'feature.txt'), 'B\n');
    await f.hook('chat-A', f.resources);
    await f.hook('chat-B', projectB);
    await f.tools.call('handoff_publish', { revision: null, input: f.input('auto-A', 'chat-A', ['input.txt']) });
    await f.tools.call('handoff_publish', { revision: null, input: f.input('auto-B', 'chat-B', ['feature.txt']) });
    assert.equal(f.tools.ledger.getPacket('auto-A').packet.resourceRoot, f.resources);
    assert.equal(f.tools.ledger.getPacket('auto-B').packet.resourceRoot, projectB);
    assert.equal(f.tools.ledger.getPacket('auto-B').packet.resources[0]?.path, 'src/feature.txt');
    assert.equal(readFileSync(path.join(projectB, 'src', 'feature.txt'), 'utf8'), 'B\n');
    await assert.rejects(f.tools.call('handoff_status', { taskId: 'auto-A', conversationId: 'chat-B' }), errorCode('WRONG_CONVERSATION'));
});
test('projectless work creates its own stable brief and publishes without paths or source files', async (t) => {
    const f = setup(t);
    await f.hook('writing-chat', '');
    const request = { revision: null, input: f.input('writing', 'writing-chat') };
    await f.tools.call('handoff_publish', request);
    const packet = f.tools.ledger.getPacket('writing').packet;
    assert(packet.resourceRoot.startsWith(f.contexts + path.sep));
    assert.equal(packet.resources.length, 1);
    assert.equal(readFileSync(path.join(packet.resourceRoot, packet.resources[0].path), 'utf8'), request.input.summary + '\n');
    assert.equal(packet.workRoot, f.workRoot);
    const again = await f.tools.call('handoff_prepare_context', { taskId: 'writing', conversationId: 'writing-chat', summary: request.input.summary });
    assert.equal(again.state, 'ready');
});
test('an attachment absolute path auto-selects only its own directory and explicit resource', async (t) => {
    const f = setup(t), attachmentDir = path.join(f.root, 'attachments');
    mkdirSync(attachmentDir);
    const file = path.join(attachmentDir, 'brief.txt');
    writeFileSync(file, 'attached\n');
    writeFileSync(path.join(attachmentDir, 'unrelated.txt'), 'do not collect');
    await f.hook('attachment-chat', '');
    await f.tools.call('handoff_publish', { revision: null, input: f.input('attachment-task', 'attachment-chat', [file]) });
    const packet = f.tools.ledger.getPacket('attachment-task').packet;
    assert.equal(packet.resourceRoot, attachmentDir);
    assert.deepEqual(packet.resources.map(x => x.path), ['brief.txt']);
});
test('ambiguous file names return all choices in one result and do not publish or grant a task', async (t) => {
    const f = setup(t);
    for (const sub of ['first', 'second']) {
        mkdirSync(path.join(f.resources, sub));
        writeFileSync(path.join(f.resources, sub, 'report.txt'), sub);
    }
    await f.hook('ambiguous-chat', f.resources);
    const result = await f.tools.call('handoff_publish', { revision: null, input: f.input('ambiguous', 'ambiguous-chat', ['report.txt', 'missing.txt']) });
    assert.equal(result.state, 'needs-selection');
    if (result.state === 'needs-selection') {
        assert.equal(result.choices.length, 2);
        assert.deepEqual(result.choices[0]?.candidates, ['first/report.txt', 'second/report.txt']);
    }
    assert.equal(f.tools.ledger.listTasks().length, 0);
    assert.equal(f.tools.store.get('task-context', 'ambiguous'), null);
    await f.tools.call('handoff_publish', { revision: null, input: f.input('ambiguous', 'ambiguous-chat', ['first/report.txt']) });
    assert.equal(f.tools.ledger.getPacket('ambiguous').packet.resources.length, 1);
});
test('preparing does not reuse another conversation or broaden scopes to credentials/directories', async (t) => {
    const f = setup(t);
    await f.hook('owner', f.resources);
    await f.tools.call('handoff_prepare_context', { taskId: 'scope', conversationId: 'owner', files: ['input.txt'] });
    await assert.rejects(f.tools.call('handoff_prepare_context', { taskId: 'scope', conversationId: 'other', files: ['input.txt'] }), errorCode('WRONG_CONVERSATION'));
    writeFileSync(path.join(f.resources, '.env'), 'SECRET_FIXTURE_ONLY');
    await assert.rejects(f.tools.call('handoff_publish', { revision: null, input: f.input('secret', 'owner', ['.env']) }), errorCode('SENSITIVE_RESOURCE'));
    await assert.rejects(f.tools.call('handoff_prepare_context', { taskId: 'directory', conversationId: 'owner', files: [f.resources] }));
    assert.equal(f.tools.ledger.listTasks().length, 0);
    assert.equal(f.tools.store.get('task-context', 'scope')?.files.length, 1);
});
test('global checking follows current directory changes without creating a new confirmation or extra quota request', async (t) => {
    const f = setup(t), bridge = new QuotaHookBridge(f.tools.store, [], { ...defaultQuotaHookPolicy, scope: 'all-conversations' }, defaultQuotaPolicy, () => baseTime);
    bridge.event({ conversationId: 'moving', cwd: f.resources, event: 'SessionStart' });
    const before = f.tools.store.get('quota-hook', 'moving');
    assert.deepEqual(bridge.event({ conversationId: 'moving', cwd: f.root, event: 'PostToolUse', toolName: 'regular-tool' }), {});
    const after = f.tools.store.get('quota-hook', 'moving');
    assert.equal(after.checkId, before.checkId);
    assert.equal(after.cwd, f.root);
});
test('independent standard MCP clients in different project directories share global setup without mixing conversations', async (t) => {
    const f = setup(t), projectB = path.join(f.root, 'second MCP project');
    mkdirSync(projectB);
    writeFileSync(path.join(projectB, 'other.txt'), 'independent\n');
    const server = fileURLToPath(new URL('../src/mcp-server.js', import.meta.url));
    const clients = [];
    try {
        for (const [conversationId, cwd, taskId, file] of [['wire-A', f.resources, 'wire-task-A', 'input.txt'], ['wire-B', projectB, 'wire-task-B', 'other.txt']]) {
            const client = new Client({ name: 'isolated-universal-fixture', version: '1' });
            clients.push(client);
            await client.connect(new StdioClientTransport({ command: process.execPath, args: [server, '--config', f.config], cwd: cwd, stderr: 'pipe' }));
            const call = async (name, args) => {
                const result = await client.callTool({ name, arguments: args });
                assert(!result.isError, JSON.stringify(result));
                return JSON.parse(result.content.find(x => x.type === 'text').text);
            };
            // Explicitly synthetic lifecycle inputs in an isolated ledger; not a native hook test.
            await call('handoff_hook_event', { conversationId, cwd, event: 'SessionStart' });
            const result = await call('handoff_publish', { revision: null, input: f.input(taskId, conversationId, [file]) });
            assert.equal(result.packet.resourceRoot, cwd);
            assert.equal(result.packet.conversationId, conversationId);
        }
        assert.equal(f.tools.ledger.listTasks().length, 2);
        const foreign = await clients[1].callTool({ name: 'handoff_status', arguments: { taskId: 'wire-task-A', conversationId: 'wire-B' } });
        assert(foreign.isError);
        assert.match(JSON.stringify(foreign), /WRONG_CONVERSATION/);
        const collision = await Promise.all(clients.map((client, index) => client.callTool({ name: 'handoff_prepare_context', arguments: {
                taskId: 'same-id-concurrent', conversationId: index === 0 ? 'wire-A' : 'wire-B', files: [index === 0 ? 'input.txt' : 'other.txt'],
            } })));
        assert.equal(collision.filter(x => !x.isError).length, 1);
        assert.match(JSON.stringify(collision.find(x => x.isError)), /WRONG_CONVERSATION/);
    }
    finally {
        for (const client of clients)
            await client.close();
    }
});
test('auto-registered project keeps original binding through copy, review, backup, writeback and reopening', async (t) => {
    const f = setup(t);
    await f.hook('end-to-end-local', f.resources);
    await f.tools.call('handoff_publish', { revision: null, input: f.input('context-roundtrip', 'end-to-end-local', ['input.txt']) });
    await f.tools.call('handoff_record_quota', { observedAt: baseTime, usage: { ordinaryUsageAllowed: true, rateLimits: { spendControlReached: false, primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: Math.floor(baseTime / 1000) + 3600 }, secondary: { usedPercent: 1, windowDurationMins: 10080, resetsAt: Math.floor(baseTime / 1000) + 604800 } } } });
    const context = { taskId: 'context-roundtrip', conversationId: 'end-to-end-local' };
    const revision = () => f.tools.ledger.getTask(context.taskId).revision;
    const command = await f.tools.call('handoff_enqueue', { ...context, revision: revision(), request: { idempotencyKey: 'local-only-final', packetVersion: 1, side: 'work', kind: 'execute', instructions: 'Only fixture input' } });
    const ctx = { commandId: command.id, conversationId: context.conversationId };
    const copy = await f.tools.call('handoff_work_begin', ctx);
    writeFileSync(path.join(copy.directory, 'input.txt'), 'context output\n');
    const result = await f.tools.call('handoff_work_finish', { ...ctx, summary: 'local fixture', acceptanceNotes: ['read file'], files: ['input.txt'], deletions: [] });
    await f.tools.call('handoff_review', { ...context, revision: revision(), resultId: result.command.resultId, snapshotId: result.snapshot.id, decision: 'accept', reason: 'Fixture content matches expected bytes' });
    const commit = await f.tools.call('handoff_prepare_commit', { conversationId: context.conversationId, revision: revision(), snapshotId: result.snapshot.id });
    assert.equal(readFileSync(path.join(f.tools.files.backupDirectory(commit.id), 'input.txt'), 'utf8'), 'only designated task content\n');
    await f.tools.call('handoff_apply_commit', { conversationId: context.conversationId, commitId: commit.id });
    assert.equal(readFileSync(path.join(f.resources, 'input.txt'), 'utf8'), 'context output\n');
    await f.tools.call('handoff_complete', { ...context, revision: revision(), resultId: result.command.resultId });
    const reopened = new TaskTools(f.config);
    try {
        assert.equal((await reopened.call('handoff_status', context)).task.stage, 'completed');
    }
    finally {
        reopened.close();
    }
});
//# sourceMappingURL=task-context.test.js.map