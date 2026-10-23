import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.js';
import { baseTime, errorCode, fixture, receipt } from './helpers.js';
test('pause/cancel have durable unique request IDs and idempotency keys, not only a task flag', t => {
    const f = fixture(t);
    f.publish();
    const worker = f.ledger.claim(f.enqueue().id, 'worker').command;
    const revision = f.ledger.getTask('task-a').revision;
    const paused = f.ledger.requestControl('task-a', revision, 'pause', 'pause-once');
    assert(paused.lastControlRequestId);
    const request = f.ledger.getControlRequest(paused.lastControlRequestId);
    assert.equal(request.status, 'requested');
    assert.deepEqual(request.executionIds, [worker.executionId]);
    assert.equal(f.ledger.requestControl('task-a', revision, 'pause', 'pause-once').revision, paused.revision);
    assert.throws(() => f.ledger.requestControl('task-a', revision, 'cancel', 'pause-once'), errorCode('IDEMPOTENCY_CONFLICT'));
    const reopened = new Ledger(f.db, () => baseTime);
    try {
        assert.deepEqual(reopened.getControlRequest(request.id), request);
        reopened.receive(receipt(worker, 'cancelled', 1, { controlRequestId: request.id, reason: 'owned attempt settled' }));
        assert.equal(reopened.getControlRequest(request.id).status, 'settled');
        assert.equal(reopened.getTask('task-a').control, 'paused');
        assert.equal(reopened.requestControl('task-a', revision, 'pause', 'pause-once').lastControlRequestId, request.id);
    }
    finally {
        reopened.close();
    }
});
test('control requests cover only their own task; one worker receipt cannot acknowledge another execution', t => {
    const f = fixture(t);
    f.publish();
    f.publish('task-b');
    const a = f.ledger.claim(f.enqueue('task-a').id, 'worker-a').command;
    const b = f.ledger.claim(f.enqueue('task-b').id, 'worker-b').command;
    const paused = f.ledger.requestControl('task-a', f.ledger.getTask('task-a').revision, 'pause', 'pause-a');
    assert.throws(() => f.ledger.receive(receipt(b, 'cancelled', 1, { reason: 'wrong task', controlRequestId: paused.lastControlRequestId })), errorCode('WRONG_CONTROL_REQUEST'));
    assert.equal(f.ledger.getCommand(b.id).status, 'dispatching');
    f.ledger.receive(receipt(a, 'cancelled', 1, { reason: 'settled', controlRequestId: paused.lastControlRequestId }));
    assert.equal(f.ledger.getTask('task-a').control, 'paused');
    assert.equal(f.ledger.getTask('task-b').control, 'open');
});
test('multi-attempt pause is not settled after only one receipt, and unknown work is not assumed stopped', t => {
    const f = fixture(t);
    f.publish();
    const a = f.ledger.claim(f.enqueue('task-a', 'work').id, 'work').command;
    const b = f.ledger.claim(f.enqueue('task-a', 'harness').id, 'harness').command;
    const paused = f.ledger.requestControl('task-a', f.ledger.getTask('task-a').revision, 'pause');
    f.ledger.receive(receipt(a, 'cancelled', 1, { reason: 'first settled' }));
    assert.equal(f.ledger.getControlRequest(paused.lastControlRequestId).status, 'requested');
    f.ledger.markWorkerLost('harness', 'lost during pause');
    assert.equal(f.ledger.getTask('task-a').control, 'pause_requested');
    f.ledger.reconcile(receipt(b, 'cancelled', 1, { reason: 'confirmed stopped' }), 'Adapter confirmed same execution has stopped');
    assert.equal(f.ledger.getControlRequest(paused.lastControlRequestId).status, 'settled');
    assert.equal(f.ledger.getTask('task-a').control, 'paused');
});
test('cancelling a never-dispatched task settles immediately and preserves the numbered request', t => {
    const f = fixture(t);
    f.publish();
    const queued = f.enqueue();
    const cancelled = f.ledger.requestControl('task-a', f.ledger.getTask('task-a').revision, 'cancel', 'cancel-once');
    assert.equal(cancelled.control, 'cancelled');
    assert.equal(f.ledger.getCommand(queued.id).status, 'cancelled');
    assert.equal(f.ledger.getControlRequest(cancelled.lastControlRequestId).status, 'settled');
    assert.equal(f.ledger.getCommand(queued.id).executionId, null);
});
//# sourceMappingURL=control.test.js.map