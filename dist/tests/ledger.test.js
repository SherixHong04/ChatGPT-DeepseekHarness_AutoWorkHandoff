import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Ledger, taskPhase } from '../src/ledger.js';
import { fingerprint } from '../src/packet.js';
import { errorCode, fixture, output, receipt, succeed } from './helpers.js';
test('packet commits are atomic, immutable and versioned; repeat commit returns existing record', t => {
    const f = fixture(t), packet = f.packet();
    f.ledger.publishPacket(packet, null);
    const original = f.ledger.getTask('task-a');
    assert.deepEqual(f.ledger.publishPacket(packet, null), original);
    assert.throws(() => f.ledger.publishPacket({ ...packet, summary: 'different' }, original.revision), errorCode('PACKET_VERSION_CONFLICT'));
    const bad = f.packet('task-a', 2);
    bad.resources[0].sha256 = '0'.repeat(64);
    assert.throws(() => f.ledger.publishPacket(bad, original.revision), errorCode('RESOURCE_CHANGED'));
    assert.deepEqual(f.ledger.getTask('task-a'), original);
    assert.throws(() => f.ledger.getPacket('task-a', 2), errorCode('PACKET_NOT_FOUND'));
    f.ledger.publishPacket(f.packet('task-a', 2), original.revision);
    assert.equal(f.ledger.getPacket('task-a', 1).packet.summary, packet.summary);
    assert.equal(f.ledger.getPacket('task-a').packet.version, 2);
});
test('task revision rejects stale decisions without overwriting newer state', t => {
    const f = fixture(t), before = f.publish();
    f.enqueue();
    assert.throws(() => f.ledger.publishPacket(f.packet('task-a', 2), before.revision), errorCode('STALE_REVISION'));
    assert.equal(f.ledger.getTask('task-a').packetVersion, 1);
});
test('two tasks and both sides can run concurrently with no global owner', t => {
    const f = fixture(t);
    f.publish('task-a');
    f.publish('task-b');
    const a = f.ledger.claim(f.enqueue('task-a', 'harness').id, 'harness-a');
    const b = f.ledger.claim(f.enqueue('task-b', 'work').id, 'work-b');
    const same = f.ledger.claim(f.enqueue('task-a', 'work', 'review').id, 'work-review');
    assert(a.claimed && b.claimed && same.claimed);
    assert.equal(f.ledger.listAttempts('task-a').length, 2);
    assert.equal(taskPhase(f.ledger.getTask('task-b')), 'active');
});
test('idempotency key returns same command after revision advances, but cannot change payload', t => {
    const f = fixture(t);
    const initial = f.publish(), first = f.enqueue('task-a', 'harness', 'execute', 'stable-key');
    assert.equal(f.ledger.enqueue('task-a', initial.revision, { idempotencyKey: 'stable-key', packetVersion: 1,
        side: 'harness', kind: 'execute', instructions: first.instructions }).id, first.id);
    assert.throws(() => f.ledger.enqueue('task-a', initial.revision, { idempotencyKey: 'stable-key', packetVersion: 1,
        side: 'harness', kind: 'execute', instructions: 'different' }), errorCode('IDEMPOTENCY_CONFLICT'));
    assert.equal(f.ledger.listCommands('task-a').length, 1);
});
test('one command can only be claimed once; dispatch is not receipt or completion', t => {
    const f = fixture(t);
    f.publish();
    const queued = f.enqueue();
    const first = f.ledger.claim(queued.id, 'worker-one');
    assert(first.claimed);
    assert.equal(first.command.status, 'dispatching');
    assert.equal(f.ledger.claim(queued.id, 'worker-two').claimed, false);
    assert.equal(f.ledger.getCommand(queued.id).workerId, 'worker-one');
    f.ledger.markSent(queued.id, first.command.executionId);
    assert.equal(f.ledger.getCommand(queued.id).status, 'sent');
    assert.throws(() => f.ledger.receive(receipt(first.command, 'succeeded', 1, { output: output() })), errorCode('RECEIPT_ORDER'));
});
test('wrong worker, execution identity, missing sequence and regressing receipt are rejected', t => {
    const f = fixture(t);
    f.publish();
    const c = f.ledger.claim(f.enqueue().id, 'worker').command;
    assert.throws(() => f.ledger.receive(receipt(c, 'received', 1, { workerId: 'intruder' })), errorCode('WRONG_EXECUTION'));
    assert.throws(() => f.ledger.receive(receipt(c, 'received', 1, { executionId: 'wrong' })), errorCode('WRONG_EXECUTION'));
    assert.throws(() => f.ledger.receive(receipt(c, 'received', 2)), errorCode('RECEIPT_ORDER'));
    f.ledger.receive(receipt(c, 'received', 1));
    f.ledger.receive(receipt(c, 'running', 2));
    assert.throws(() => f.ledger.receive(receipt(c, 'received', 3)), errorCode('RECEIPT_ORDER'));
    assert.equal(f.ledger.getCommand(c.id).receiptSequence, 2);
});
test('duplicate receipts do not create duplicate results or audit events', t => {
    const f = fixture(t);
    f.publish();
    const c = f.ledger.claim(f.enqueue().id, 'worker').command;
    f.ledger.receive(receipt(c, 'received', 1));
    f.ledger.receive(receipt(c, 'running', 2));
    const event = receipt(c, 'succeeded', 3, { output: output() }), done = f.ledger.receive(event);
    const revision = f.ledger.getTask('task-a').revision, events = f.ledger.listEvents('task-a').length;
    assert.equal(f.ledger.receive(event).resultId, done.resultId);
    assert.equal(f.ledger.getTask('task-a').revision, revision);
    assert.equal(f.ledger.listEvents('task-a').length, events);
    assert.throws(() => f.ledger.receive({ ...event, output: { ...output(), summary: 'changed' } }), errorCode('RECEIPT_CONFLICT'));
    assert.throws(() => f.ledger.receive(receipt(c, 'failed', 4, { reason: 'late' })), errorCode('TERMINAL_COMMAND'));
});
test('changed output file cannot be certified by an incorrect success receipt', t => {
    const f = fixture(t);
    f.publish();
    const c = f.ledger.claim(f.enqueue().id, 'worker').command;
    f.ledger.receive(receipt(c, 'received', 1));
    f.ledger.receive(receipt(c, 'running', 2));
    const work = f.ledger.executionDirectory(c.id);
    mkdirSync(work);
    writeFileSync(path.join(work, 'input.txt'), 'output');
    const file = fingerprint(work, 'input.txt');
    writeFileSync(path.join(work, 'input.txt'), 'new output');
    assert.throws(() => f.ledger.receive(receipt(c, 'succeeded', 3, { output: { ...output(), files: [file] } })), errorCode('RESOURCE_CHANGED'));
    assert.equal(f.ledger.getCommand(c.id).status, 'running');
    assert.equal(f.ledger.getCommand(c.id).resultId, null);
});
test('worker loss remains unknown across reopen; exact reconciliation settles original attempt', t => {
    const f = fixture(t);
    f.publish();
    const c = f.ledger.claim(f.enqueue().id, 'lost-worker').command;
    f.ledger.receive(receipt(c, 'received', 1));
    f.ledger.receive(receipt(c, 'running', 2));
    f.ledger.markWorkerLost('lost-worker', 'lost connection');
    const reopened = new Ledger(f.db, () => c.createdAt);
    try {
        assert.equal(reopened.getCommand(c.id).status, 'unknown');
        assert.equal(reopened.claim(c.id, 'replacement').claimed, false);
        assert.throws(() => reopened.receive(receipt(c, 'succeeded', 3, { output: output() })), errorCode('RECONCILIATION_REQUIRED'));
        assert.throws(() => f.enqueue(), errorCode('UNRESOLVED_EXECUTION'));
        const event = receipt(c, 'succeeded', 3, { output: output() });
        const done = reopened.reconcile(event, 'Adapter queried the same remote execution and confirmed output');
        assert.equal(done.executionId, c.executionId);
        assert.equal(done.status, 'succeeded');
        assert.equal(f.ledger.getCommand(c.id).status, 'succeeded');
    }
    finally {
        reopened.close();
    }
});
test('unknown execution blocks prequeued retry on that task/side, not another task or read-only review', t => {
    const f = fixture(t);
    f.publish();
    f.publish('task-b');
    const a = f.ledger.claim(f.enqueue().id, 'lost').command, pending = f.enqueue();
    f.ledger.markWorkerLost('lost', 'restart');
    assert.throws(() => f.ledger.claim(pending.id, 'replacement'), errorCode('UNRESOLVED_EXECUTION'));
    assert(f.ledger.claim(f.enqueue('task-a', 'work', 'review').id, 'reviewer').claimed);
    assert(f.ledger.claim(f.enqueue('task-b').id, 'independent').claimed);
    assert.equal(f.ledger.getCommand(a.id).status, 'unknown');
});
test('pause and cancel remain requested until actual in-flight work is settled', t => {
    const f = fixture(t);
    f.publish();
    f.publish('task-b');
    const active = f.ledger.claim(f.enqueue().id, 'worker').command, queued = f.enqueue();
    const paused = f.ledger.requestControl('task-a', f.ledger.getTask('task-a').revision, 'pause');
    assert.equal(paused.control, 'pause_requested');
    assert.equal(f.ledger.getCommand(queued.id).status, 'cancelled');
    assert.throws(() => f.ledger.resume('task-a', paused.revision), errorCode('NOT_PAUSED'));
    assert(f.ledger.claim(f.enqueue('task-b').id, 'other-worker').claimed);
    f.ledger.receive(receipt(active, 'cancelled', 1, { reason: 'worker acknowledged pause and settled' }));
    assert.equal(f.ledger.getTask('task-a').control, 'paused');
    f.ledger.resume('task-a', f.ledger.getTask('task-a').revision);
    const second = f.ledger.claim(f.enqueue().id, 'worker').command;
    f.ledger.requestControl('task-a', f.ledger.getTask('task-a').revision, 'cancel');
    assert.equal(f.ledger.getTask('task-a').control, 'cancel_requested');
    f.ledger.receive(receipt(second, 'cancelled', 1, { reason: 'stopped owned task' }));
    assert.equal(f.ledger.getTask('task-a').control, 'cancelled');
    assert.throws(() => f.enqueue(), errorCode('TASK_NOT_OPEN'));
});
test('new packet supersedes only never-dispatched commands and preserves running old attempts', t => {
    const f = fixture(t);
    const original = f.packet();
    f.ledger.publishPacket(original, null);
    const active = f.ledger.claim(f.enqueue().id, 'old-worker').command, queued = f.enqueue();
    f.ledger.publishPacket(f.packet('task-a', 2), f.ledger.getTask('task-a').revision);
    assert.equal(f.ledger.getCommand(queued.id).status, 'superseded');
    assert.equal(f.ledger.getCommand(active.id).status, 'dispatching');
    f.ledger.receive(receipt(active, 'received', 1));
    f.ledger.receive(receipt(active, 'running', 2));
    const done = f.ledger.receive(receipt(active, 'succeeded', 3, { output: output() }));
    assert.equal(f.ledger.getTask('task-a').stage, 'ready');
    assert.equal(f.ledger.getResult(done.resultId).packetVersion, 1);
    assert.throws(() => f.ledger.complete('task-a', f.ledger.getTask('task-a').revision, done.resultId), errorCode('WRONG_RESULT'));
});
test('recipient scope, task identity, stale resources and deadline are checked before dispatch', t => {
    const f = fixture(t), packet = f.packet();
    packet.recipients = ['work'];
    f.ledger.publishPacket(packet, null);
    assert.throws(() => f.enqueue(), errorCode('RECIPIENT_NOT_ALLOWED'));
    assert.throws(() => f.ledger.publishPacket({ ...f.packet('task-a', 2), conversationId: 'other-chat' }, f.ledger.getTask('task-a').revision), errorCode('TASK_IDENTITY_CHANGED'));
    const queued = f.enqueue('task-a', 'work');
    writeFileSync(path.join(f.resources, 'input.txt'), 'changed');
    assert.throws(() => f.ledger.claim(queued.id, 'worker'), errorCode('RESOURCE_CHANGED'));
    assert.equal(f.ledger.getCommand(queued.id).status, 'queued');
    f.advance(3_600_001);
    assert.throws(() => f.ledger.claim(queued.id, 'worker'), errorCode('DEADLINE_REACHED'));
});
test('one Harness rework is followed by mandatory GPT finish; another task remains running', t => {
    const f = fixture(t);
    f.publish();
    f.publish('task-b');
    const other = f.ledger.claim(f.enqueue('task-b').id, 'other').command;
    const first = succeed(f.ledger, f.enqueue());
    f.ledger.requestRework('task-a', f.ledger.getTask('task-a').revision, first.resultId, 'one correction');
    const rework = f.enqueue('task-a', 'harness', 'rework');
    assert.throws(() => f.enqueue('task-a', 'harness', 'rework'), errorCode('REWORK_LIMIT'));
    const revised = succeed(f.ledger, rework);
    assert.equal(f.ledger.getTask('task-a').stage, 'work_finishing');
    assert.throws(() => f.ledger.requestRework('task-a', f.ledger.getTask('task-a').revision, revised.resultId, 'again'), errorCode('REWORK_LIMIT'));
    assert.throws(() => f.enqueue(), errorCode('WORK_FINISH_REQUIRED'));
    assert.throws(() => f.ledger.complete('task-a', f.ledger.getTask('task-a').revision, revised.resultId), errorCode('WORK_FINISH_REQUIRED'));
    const finished = succeed(f.ledger, f.enqueue('task-a', 'work', 'finish'));
    const done = f.ledger.complete('task-a', f.ledger.getTask('task-a').revision, finished.resultId);
    assert.equal(done.stage, 'completed');
    assert.equal(f.ledger.getCommand(other.id).status, 'dispatching');
});
test('failed rework also hands the remaining work to GPT instead of authorizing another attempt', t => {
    const f = fixture(t);
    f.publish();
    const first = succeed(f.ledger, f.enqueue());
    f.ledger.requestRework('task-a', f.ledger.getTask('task-a').revision, first.resultId, 'fix');
    const rework = f.ledger.claim(f.enqueue('task-a', 'harness', 'rework').id, 'worker').command;
    f.ledger.receive(receipt(rework, 'failed', 1, { reason: 'worker failed' }));
    assert.equal(f.ledger.getTask('task-a').stage, 'work_finishing');
    assert.throws(() => f.enqueue('task-a', 'harness', 'rework'), errorCode('REWORK_NOT_READY'));
});
test('future and expired packet imports cannot extend the task window; committed retry remains an acknowledgement', t => {
    const f = fixture(t), packet = f.packet();
    assert.throws(() => f.ledger.publishPacket({ ...packet, createdAt: packet.createdAt + 100, deadlineAt: packet.deadlineAt + 100 }, null), errorCode('FUTURE_PACKET'));
    f.ledger.publishPacket(packet, null);
    f.advance(3_600_001);
    assert.equal(f.ledger.publishPacket(packet, null).packetVersion, 1);
    const expired = { ...packet, taskId: 'expired' };
    assert.throws(() => f.ledger.publishPacket(expired, null), errorCode('DEADLINE_REACHED'));
});
//# sourceMappingURL=ledger.test.js.map