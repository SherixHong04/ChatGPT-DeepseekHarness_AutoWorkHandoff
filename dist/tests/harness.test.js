import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { FileEngine } from '../src/files.js';
import { HarnessWorker, executionDeadline, executionPlan, parseWorkerResult } from '../src/harness-worker.js';
import { HarnessSdk, SessionEvidence, validateEndpoint } from '../src/harness-sdk.js';
import { baseTime, errorCode, fixture } from './helpers.js';
const peer = fileURLToPath(new URL('./fixtures/harness-peer.js', import.meta.url));
function setup(t, mode = 'success') {
    const f = fixture(t);
    f.publish();
    const files = new FileEngine(f.ledger, f.workRoot);
    f.onCleanup(() => files.close());
    const endpoint = { launcher: path.join(f.root, 'dsh.cmd'), profile: 'work-handoff-fixture', provider: 'deepseek-account',
        model: 'deepseek-flash', maxTokens: 4096 };
    const worker = new HarnessWorker(f.ledger, files, endpoint, { clock: () => baseTime,
        launch: (_endpoint, cwd) => ({ executable: process.execPath, args: [peer, mode], cwd }) });
    f.onCleanup(() => worker.close());
    return { ...f, files, worker, endpoint };
}
async function waitFor(predicate) {
    const limit = Date.now() + 10_000;
    while (!predicate()) {
        assert(Date.now() < limit, 'fixture timed out');
        await new Promise(resolve => setTimeout(resolve, 25));
    }
}
test('omitted execution duration has no synthetic deadline; explicit user limits remain effective', () => {
    const plan = executionPlan({ outputs: ['input.txt'], deletions: [] });
    assert.equal(Object.hasOwn(plan, 'timeoutMs'), false);
    assert.equal(executionDeadline(plan, null, 1000, 2000), null);
    assert.equal(executionDeadline(plan, 3000, 1000, 2000), 4000);
    assert.equal(executionDeadline({ ...plan, timeoutMs: 700 }, 3000, 1000, 2000), 2700);
    assert.equal(executionDeadline({ ...plan, timeoutMs: 18_000_001 }, null, 1000, 2000), 18_002_001);
    assert.throws(() => executionPlan({ ...plan, timeoutMs: 0 }), errorCode('INVALID_EXECUTION_PLAN'));
});
test('unbounded SDK wait still settles safely when the owned transport closes', async (t) => {
    const f = fixture(t), sdk = new HarnessSdk({ executable: process.execPath, args: [peer, 'success'], cwd: f.workRoot });
    const endpoint = validateEndpoint({ launcher: path.join(f.root, 'dsh.cmd'), profile: 'work-handoff-fixture', provider: 'deepseek-account', model: 'deepseek-flash' });
    try {
        await sdk.initialize(endpoint, f.workRoot);
        const pending = assert.rejects(sdk.request('fixture/pending', {}, null), errorCode('SDK_TRANSPORT_CLOSED'));
        assert.equal((await sdk.close()).exited, true);
        await pending;
    }
    finally {
        await sdk.close();
    }
});
test('no-limit worker remains controllable after a long logical task age without a default timeout', async (t) => {
    const f = setup(t, 'hold');
    f.ledger.publishPacket({ ...f.packet('task-a', 2), deadlineAt: null }, f.ledger.getTask('task-a').revision);
    const command = f.enqueue(), running = f.worker.dispatch(command.id);
    try {
        await waitFor(() => f.ledger.getCommand(command.id).status === 'running');
        assert.equal(f.worker.getAttempt(command.id)?.plan.timeoutMs, undefined);
        f.advance(6 * 60 * 60 * 1000);
        assert.equal(f.ledger.getCommand(command.id).status, 'running');
    }
    finally {
        f.ledger.requestControl('task-a', f.ledger.getTask('task-a').revision, 'cancel');
    }
    assert.equal((await running).command.status, 'cancelled');
});
test('an explicitly given task deadline still settles a worker without an execution timer', async (t) => {
    const f = setup(t, 'hold');
    f.ledger.publishPacket({ ...f.packet('task-a', 2), deadlineAt: baseTime + 300 }, f.ledger.getTask('task-a').revision);
    const result = await f.worker.dispatch(f.enqueue().id);
    assert.equal(result.command.status, 'failed');
    assert.equal(result.attempt?.errorCode, 'EXECUTION_TIMEOUT');
    assert.equal(result.attempt?.close?.exited, true);
});
test('SDK initialization omits an unset generation override, retaining native provider defaults', async (t) => {
    const f = fixture(t);
    const endpoint = validateEndpoint({ launcher: path.join(f.root, 'dsh.cmd'), profile: 'work-handoff-fixture', provider: 'deepseek-account', model: 'deepseek-flash' });
    assert.equal(Object.hasOwn(endpoint, 'maxTokens'), false);
    assert.throws(() => validateEndpoint({ ...endpoint, maxTokens: 0 }));
    const sdk = new HarnessSdk({ executable: process.execPath, args: [peer, 'no-token-override'], cwd: f.workRoot });
    try {
        await sdk.initialize(endpoint, f.workRoot);
    }
    finally {
        assert.equal((await sdk.close()).exited, true);
    }
});
test('SDK worker completes real local file operations and seals a snapshot without changing originals', async (t) => {
    const f = setup(t), queued = f.enqueue();
    const result = await f.worker.dispatch(queued.id);
    assert.equal(result.command.status, 'succeeded');
    assert.equal(result.started, true);
    assert.equal(result.command.receiptSequence, 3);
    assert.equal(result.attempt?.turnReason, 'completed');
    assert.deepEqual(result.attempt?.close, { shutdownAcknowledged: true, exited: true, code: 0 });
    assert.equal(readFileSync(path.join(f.resources, 'input.txt'), 'utf8'), 'only designated task content\n');
    assert.equal(readFileSync(path.join(f.files.snapshotDirectory(result.attempt.snapshotId), 'input.txt'), 'utf8'), 'edited by local fixture\n');
});
test('repeated dispatch, including while active, never sends the same model prompt twice', async (t) => {
    const f = setup(t, 'hold'), queued = f.enqueue(), first = f.worker.dispatch(queued.id);
    await waitFor(() => f.ledger.getCommand(queued.id).status === 'running');
    const second = await f.worker.dispatch(queued.id);
    assert.equal(second.started, false);
    f.ledger.requestControl('task-a', f.ledger.getTask('task-a').revision, 'cancel');
    await first;
    const third = await f.worker.dispatch(queued.id);
    assert.equal(third.started, false);
    const root = f.ledger.executionDirectory(queued.id);
    assert.equal(readFileSync(path.join(root, '.fixture-prompt-count'), 'utf8'), '1\n');
});
test('pause waits for native shutdown evidence, preserves progress, and settles the exact control request', async (t) => {
    const f = setup(t, 'hold'), queued = f.enqueue(), running = f.worker.dispatch(queued.id);
    await waitFor(() => f.ledger.getCommand(queued.id).status === 'running');
    const task = f.ledger.requestControl('task-a', f.ledger.getTask('task-a').revision, 'pause');
    assert.equal(task.control, 'pause_requested');
    const result = await running;
    assert.equal(result.command.status, 'cancelled');
    assert.equal(f.ledger.getTask('task-a').control, 'paused');
    assert.equal(f.ledger.getControlRequest(task.lastControlRequestId).status, 'settled');
    assert(result.attempt?.snapshotId);
    f.ledger.resume('task-a', f.ledger.getTask('task-a').revision);
    const continuation = new HarnessWorker(f.ledger, f.files, f.endpoint, { clock: () => baseTime,
        launch: (_endpoint, cwd) => ({ executable: process.execPath, args: [peer, 'resume-seed'], cwd }) });
    f.onCleanup(() => continuation.close());
    const resumed = await continuation.dispatch(f.enqueue().id, { outputs: ['input.txt'], deletions: [], timeoutMs: 5000, seedSnapshotId: result.attempt.snapshotId });
    assert.equal(resumed.command.status, 'succeeded');
    assert.equal(readFileSync(path.join(f.files.snapshotDirectory(resumed.attempt.snapshotId), 'input.txt'), 'utf8'), 'resumed saved progress\n');
});
test('execution timeout cancels only the owned runtime and never certifies incomplete output', async (t) => {
    const f = setup(t, 'hold'), result = await f.worker.dispatch(f.enqueue().id, { outputs: ['input.txt'], deletions: [], timeoutMs: 1000 });
    assert.equal(result.command.status, 'failed');
    assert.equal(result.attempt?.errorCode, 'EXECUTION_TIMEOUT');
    assert.equal(result.attempt?.close?.shutdownAcknowledged, true);
    assert.equal(result.attempt?.close?.exited, true);
});
test('runtime loss remains unknown across reopen and cannot be re-dispatched automatically', async (t) => {
    const f = setup(t, 'crash'), queued = f.enqueue();
    const result = await f.worker.dispatch(queued.id);
    assert.equal(result.command.status, 'unknown');
    assert.equal(result.attempt?.phase, 'unknown');
    const another = new HarnessWorker(f.ledger, f.files, f.endpoint);
    f.onCleanup(() => another.close());
    assert.equal(another.getAttempt(queued.id)?.sessionId, result.attempt?.sessionId);
    assert.equal((await another.dispatch(queued.id)).started, false);
    assert.throws(() => another.recoverReceipt(queued.id), errorCode('NO_RECOVERABLE_RECEIPT'));
});
for (const mode of ['bad-json', 'undeclared', 'max-tokens', 'blocked', 'missing']) {
    test(`SDK outcome ${mode} cannot become a successful file result`, async (t) => {
        const f = setup(t, mode), queued = f.enqueue();
        const result = await f.worker.dispatch(queued.id, { outputs: ['input.txt', 'missing.txt'], deletions: [], timeoutMs: 5000 });
        assert.equal(result.command.status, 'failed');
        assert.equal(result.command.resultId, null);
        assert.equal(result.attempt?.close?.exited, true);
        assert.equal(readFileSync(path.join(f.resources, 'input.txt'), 'utf8'), 'only designated task content\n');
    });
}
test('events arriving before the prompt response are correlated by message identity', async (t) => {
    const f = setup(t, 'early-events'), result = await f.worker.dispatch(f.enqueue().id);
    assert.equal(result.command.status, 'succeeded');
    assert.equal(result.command.receiptSequence, 3);
});
test('wrong SDK identity, working directory or missing wait capability prevents any prompt', async (t) => {
    for (const mode of ['wrong-identity', 'wrong-cwd', 'missing-wait']) {
        const f = setup(t, mode), result = await f.worker.dispatch(f.enqueue().id);
        assert.equal(result.command.status, 'failed');
        assert.equal(result.attempt?.messageId, null);
        assert.equal(result.attempt?.errorCode, mode === 'wrong-identity' ? 'SDK_IDENTITY_MISMATCH' : mode === 'wrong-cwd' ? 'SDK_WORKSPACE_MISMATCH' : 'SDK_REQUEST_REJECTED');
    }
});
test('only the known bounded account startup diagnostic is accepted; other stdout fails', async (t) => {
    const f = fixture(t);
    for (const mode of ['startup-log', 'stdout-noise']) {
        const sdk = new HarnessSdk({ executable: process.execPath, args: [peer, mode], cwd: f.workRoot });
        const endpoint = { launcher: path.join(f.root, 'dsh.cmd'), profile: 'work-handoff-fixture', provider: 'deepseek-account', model: 'deepseek-flash', maxTokens: 4096 };
        try {
            if (mode === 'startup-log') {
                await sdk.initialize(endpoint, f.workRoot);
                assert.equal(sdk.ignoredStartupDiagnostics, 1);
            }
            else {
                await assert.rejects(sdk.initialize(endpoint, f.workRoot), errorCode('SDK_PROTOCOL_ERROR'));
                assert.equal(sdk.diagnostic?.includes('unexpected'), false);
            }
        }
        finally {
            assert.equal((await sdk.close()).exited, true);
        }
    }
});
test('independent task executions can overlap; cancelling one does not cancel another', async (t) => {
    const f = setup(t, 'hold');
    f.publish('task-b');
    const other = new HarnessWorker(f.ledger, f.files, f.endpoint, { clock: () => baseTime,
        launch: (_endpoint, cwd) => ({ executable: process.execPath, args: [peer, 'success'], cwd }) });
    f.onCleanup(() => other.close());
    const a = f.enqueue(), b = f.enqueue('task-b');
    const first = f.worker.dispatch(a.id);
    await waitFor(() => f.ledger.getCommand(a.id).status === 'running');
    const second = await other.dispatch(b.id);
    assert.equal(second.command.status, 'succeeded');
    assert.equal(f.ledger.getCommand(a.id).status, 'running');
    f.ledger.requestControl('task-a', f.ledger.getTask('task-a').revision, 'cancel');
    assert.equal((await first).command.status, 'cancelled');
    assert.equal(f.ledger.getCommand(b.id).status, 'succeeded');
});
test('stage snapshots and packet changes are scoped to the original execution', async (t) => {
    const f = setup(t, 'hold'), queued = f.enqueue(), running = f.worker.dispatch(queued.id);
    await waitFor(() => f.ledger.getCommand(queued.id).status === 'running');
    const stage = f.worker.saveStage(queued.id, ['input.txt']);
    assert.equal(stage.packetVersion, 1);
    assert.throws(() => f.worker.saveStage(queued.id, ['second.txt']), errorCode('UNDECLARED_OUTPUT'));
    f.ledger.publishPacket(f.packet('task-a', 2), f.ledger.getTask('task-a').revision);
    const result = await running;
    assert.equal(result.command.status, 'cancelled');
    assert.equal(f.ledger.getTask('task-a').packetVersion, 2);
});
test('formal rework starts from the selected previous result and still requires GPT to finish', async (t) => {
    const f = setup(t), first = await f.worker.dispatch(f.enqueue().id, { outputs: ['input.txt'], deletions: [], timeoutMs: 5000 });
    assert.equal(first.command.status, 'succeeded');
    f.ledger.requestRework('task-a', f.ledger.getTask('task-a').revision, first.command.resultId, 'refine the previous edit');
    const reviser = new HarnessWorker(f.ledger, f.files, f.endpoint, { clock: () => baseTime,
        launch: (_endpoint, cwd) => ({ executable: process.execPath, args: [peer, 'verify-seed'], cwd }) });
    f.onCleanup(() => reviser.close());
    const result = await reviser.dispatch(f.enqueue('task-a', 'harness', 'rework').id);
    assert.equal(result.command.status, 'succeeded');
    assert.equal(result.attempt?.seedSnapshotId, first.attempt?.snapshotId);
    assert.equal(result.attempt?.plan.timeoutMs, undefined, 'rework must not inherit a previous stage test duration');
    assert.equal(readFileSync(path.join(f.files.snapshotDirectory(result.attempt.snapshotId), 'input.txt'), 'utf8'), 'refined previous result\n');
    assert.equal(readFileSync(path.join(f.files.snapshotDirectory(first.attempt.snapshotId), 'input.txt'), 'utf8'), 'edited by local fixture\n');
    assert.equal(f.ledger.getTask('task-a').stage, 'work_finishing');
    assert.throws(() => f.files.prepareCommit(result.attempt.snapshotId, f.ledger.getTask('task-a').revision), errorCode('WORK_FINISH_REQUIRED'));
});
test('a real controller crash after native shutdown recovers the exact durable final receipt without another prompt', t => {
    const f = setup(t), command = f.enqueue();
    const script = `
    import { Ledger, FileEngine, HarnessWorker } from ${JSON.stringify(new URL('../src/index.js', import.meta.url).href)};
    const ledger = new Ledger(${JSON.stringify(f.db)}, () => ${baseTime});
    const files = new FileEngine(ledger, ${JSON.stringify(f.workRoot)});
    const worker = new HarnessWorker(ledger, files, ${JSON.stringify(f.endpoint)}, {
      clock: () => ${baseTime}, launch: (_endpoint, cwd) => ({ executable: process.execPath, args: [${JSON.stringify(peer)}, 'success'], cwd }),
      checkpoint: point => { if (point === 'before-receipt:succeeded') process.exit(31); }
    });
    await worker.dispatch(${JSON.stringify(command.id)});
  `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', windowsHide: true });
    assert.equal(child.status, 31, child.stderr);
    const live = f.ledger.getCommand(command.id);
    assert.equal(live.status, 'running');
    f.ledger.markWorkerLost(live.workerId, 'Fixture controller exit was observed');
    const recovered = f.worker.recoverReceipt(command.id);
    assert.equal(recovered.status, 'succeeded');
    assert.equal(recovered.receiptSequence, 3);
    assert.equal(f.worker.recoverReceipt(command.id).resultId, recovered.resultId);
    assert.equal(readFileSync(path.join(f.ledger.executionDirectory(command.id), '.fixture-prompt-count'), 'utf8'), '1\n');
});
test('session event correlation rejects missing sequence, regression and malformed output; unrelated sessions are ignored', () => {
    const state = new SessionEvidence('own');
    state.observe({ method: 'session.event', params: { sessionId: 'other', event: 'untrusted' } });
    assert.equal(state.eventCount, 0);
    state.observe({ method: 'session.event', params: { sessionId: 'own', event: { seq: 3, type: 'step/start', data: {} } } });
    assert.throws(() => state.observe({ method: 'session.event', params: { sessionId: 'own', event: { seq: 5, type: 'turn/end', data: {} } } }), errorCode('SDK_EVENT_ORDER'));
});
test('endpoint, plan and model result inputs cannot inject launcher commands, change providers or escape file scope', () => {
    const endpoint = { launcher: 'C:\\Harness\\dsh.cmd', profile: 'work-handoff-executor', provider: 'deepseek-account', model: 'deepseek-flash', maxTokens: 4096 };
    assert.throws(() => validateEndpoint({ ...endpoint, launcher: 'C:\\%OTHER%\\dsh.cmd' }), errorCode('INVALID_LAUNCHER'));
    assert.throws(() => validateEndpoint({ ...endpoint, provider: 'another-api' }), errorCode('PROVIDER_NOT_ALLOWED'));
    assert.throws(() => validateEndpoint({ ...endpoint, profile: 'desktop' }), errorCode('INVALID_HARNESS_PROFILE'));
    assert.throws(() => executionPlan({ outputs: ['../secret'], deletions: [], timeoutMs: 1000 }), errorCode('INVALID_PATH'));
    const plan = executionPlan({ outputs: ['input.txt'], deletions: [], timeoutMs: 1000 });
    assert.throws(() => parseWorkerResult(JSON.stringify({ summary: 'done', acceptanceNotes: [], files: ['second.txt'], deletions: [] }), plan), errorCode('UNDECLARED_OUTPUT'));
});
//# sourceMappingURL=harness.test.js.map