import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ManagedSession } from '../src/managed-session.js';
import { HarnessChatManager } from '../src/harness-chat-plugin.js';
import { initializeChatQueue, newChatBinding } from '../src/harness-chats.js';
import { fingerprint } from '../src/packet.js';
import { fixture, baseTime, errorCode } from './helpers.js';
async function setup(t, acceptedPromptModes) {
    const f = fixture(t), queueRoot = path.join(f.root, 'queue'), workspaceRoot = path.join(f.root, 'shared');
    mkdirSync(queueRoot);
    mkdirSync(workspaceRoot);
    mkdirSync(path.join(queueRoot, 'runs'));
    const policy = { queueRoot, workspaceRoot, enabledAt: baseTime };
    initializeChatQueue(policy);
    const binding = newChatBinding(f.packet(), policy);
    const workspace = { id: 'workspace', path: workspaceRoot, sessionIds: [], async attachSession(id) { this.sessionIds.push(id); } };
    let created = false, seq = 0, calls = 0, active = false, loseReply = false;
    const events = [];
    const host = {
        workspaceRegistry: { async resolveByPath() { return workspace; }, async create() { return workspace; }, get() { return workspace; },
            archivedSessionIds: [], async archiveSession() { } },
        sessionController: { async create({ sessionId }) { created = true; return { sessionId }; }, async rename() { return { title: 'task', seq }; },
            async prompt(request) {
                if (acceptedPromptModes)
                    assert(acceptedPromptModes.includes(request.mode), 'Harness session/prompt rejected unsupported delivery mode');
                calls++;
                if (loseReply)
                    throw new Error('reply lost');
                active = true;
                return { accepted: true };
            } },
        sessionQuery: { async observeSession() {
                if (!created)
                    throw Object.assign(new Error('missing'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' });
                return { header: { id: binding.sessionId, cwd: workspaceRoot }, events, projections: { asOfSeq: seq, values: { title: 'task' } }, [Symbol.dispose]() { } };
            } }, async waterfall() { return active ? ['running'] : []; },
    };
    await new HarnessChatManager(host, policy).call({ kind: 'prepare', binding });
    const directory = path.join(workspaceRoot, 'command-a');
    mkdirSync(directory);
    writeFileSync(path.join(directory, 'SPEC.md'), 'owned requirement');
    const input = { kind: 'start', binding, directory, commandId: 'command-a', prompt: 'owned task', inputs: [fingerprint(directory, 'SPEC.md')] };
    const manager = new ManagedSession(host, policy);
    return { manager, input, directory, count: () => calls, lose: () => { loseReply = true; },
        end() {
            active = false;
            events.push({ seq: ++seq, type: 'user/message', data: { source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'excluded runtime context' }] } });
            events.push({ seq: ++seq, type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'user continuation' }] } });
            events.push({ seq: ++seq, type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text: 'done' }] } } });
            events.push({ seq: ++seq, type: 'turn/end', data: { reason: { kind: 'completed' } } });
        } };
}
test('managed prompt enters the registered chat only once and latest user continuation remains inspectable', async (t) => {
    const f = await setup(t);
    const a = await f.manager.call(f.input);
    assert.equal(a.phase, 'accepted');
    assert(a.acceptedAt);
    await f.manager.call(f.input);
    assert.equal(f.count(), 1);
    f.end();
    const end = await f.manager.call({ ...f.input, kind: 'inspect' });
    assert.equal(end.chat.active, false);
    assert.equal(end.turnReason, 'completed');
    assert.deepEqual(end.messages.map(m => m.text), ['user continuation', 'done']);
    assert(!JSON.stringify(end).includes('private'));
});
test('managed handoff uses the public Harness queue delivery mode', async (t) => {
    // Installed Harness 0.2.1-rc.3 SessionPromptRequest accepts queue or steer.
    // A handoff must queue normally, including when the user starts work concurrently.
    const f = await setup(t, ['queue']);
    const accepted = await f.manager.call(f.input);
    assert.equal(accepted.phase, 'accepted');
    await f.manager.call(f.input);
    assert.equal(f.count(), 1);
});
test('lost prompt acknowledgement is unknown and cannot cause automatic replay', async (t) => {
    const f = await setup(t);
    f.lose();
    await assert.rejects(f.manager.call(f.input));
    assert.equal((await f.manager.call(f.input)).phase, 'unknown');
    assert.equal(f.count(), 1);
});
test('host checks the actual transferred bytes and rejects directory escape or plan mutation', async (t) => {
    const f = await setup(t);
    writeFileSync(path.join(f.directory, 'SPEC.md'), 'changed');
    await assert.rejects(f.manager.call(f.input), errorCode('RESOURCE_CHANGED'));
    assert.equal(f.count(), 0);
    await assert.rejects(f.manager.call({ ...f.input, directory: path.dirname(f.directory) }), errorCode('RUN_DIRECTORY_MISMATCH'));
});
//# sourceMappingURL=managed-session.test.js.map