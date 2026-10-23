import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { Ledger } from '../src/ledger.js';
import { fingerprint } from '../src/packet.js';
import { baseTime, errorCode, fixture, output, receipt, succeed } from './helpers.js';
const ledgerModule = new URL('../src/ledger.js', import.meta.url).href;
async function child(script) {
    const process = spawn(globalThis.process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    process.stdout.on('data', chunk => { stdout += String(chunk); });
    process.stderr.on('data', chunk => { stderr += String(chunk); });
    return new Promise((resolve, reject) => {
        process.once('error', reject);
        process.once('close', code => {
            if (code !== 0 && code !== 23)
                reject(new Error(`Owned fixture process failed (${code}): ${stderr}`));
            else
                resolve({ code, stdout });
        });
    });
}
test('two real Node processes racing to claim the same command get exactly one new claim', async (t) => {
    const f = fixture(t);
    f.publish();
    const command = f.enqueue();
    const code = (worker) => `import {Ledger} from ${JSON.stringify(ledgerModule)};
    const db=new Ledger(${JSON.stringify(f.db)},()=>${baseTime});
    try{console.log(JSON.stringify(db.claim(${JSON.stringify(command.id)},${JSON.stringify(worker)})))}finally{db.close()}`;
    const results = await Promise.all([child(code('one')), child(code('two'))]);
    assert.equal(results.filter(result => JSON.parse(result.stdout).claimed).length, 1);
    const attempts = f.ledger.listAttempts('task-a');
    assert.equal(attempts.length, 1);
    assert(attempts[0]?.executionId);
});
test('two processes replaying one idempotency key create one durable command despite stale revision', async (t) => {
    const f = fixture(t), task = f.publish();
    const request = { idempotencyKey: 'same-intent', packetVersion: 1, side: 'harness', kind: 'execute', instructions: 'one task' };
    const script = `import {Ledger} from ${JSON.stringify(ledgerModule)};
    const db=new Ledger(${JSON.stringify(f.db)},()=>${baseTime});
    try{console.log(JSON.stringify(db.enqueue('task-a',${task.revision},${JSON.stringify(request)})))}finally{db.close()}`;
    const results = await Promise.all([child(script), child(script)]);
    assert.equal(JSON.parse(results[0].stdout).id, JSON.parse(results[1].stdout).id);
    assert.equal(f.ledger.listCommands('task-a').length, 1);
});
test('abrupt owned-process exit after claim never changes the command back to queued on reopen', async (t) => {
    const f = fixture(t);
    f.publish();
    const queued = f.enqueue();
    const script = `import {Ledger} from ${JSON.stringify(ledgerModule)};
    const db=new Ledger(${JSON.stringify(f.db)},()=>${baseTime});
    console.log(JSON.stringify(db.claim(${JSON.stringify(queued.id)},'crashed-worker')));process.exit(23);`;
    const crashed = await child(script);
    assert.equal(crashed.code, 23);
    const reopened = new Ledger(f.db, () => baseTime);
    try {
        assert.equal(reopened.getCommand(queued.id).status, 'dispatching');
        assert.equal(reopened.claim(queued.id, 'replacement').claimed, false);
        reopened.markWorkerLost('crashed-worker', 'Fixture process exited after preparing dispatch');
        const command = reopened.getCommand(queued.id);
        assert.equal(command.status, 'unknown');
        const cancelled = reopened.reconcile(receipt(command, 'cancelled', 1, { reason: 'Fixture had no actual executor' }), 'Confirmed fixture did not dispatch any external request');
        assert.equal(cancelled.status, 'cancelled');
        assert.equal(cancelled.executionId, JSON.parse(crashed.stdout).command.executionId);
    }
    finally {
        reopened.close();
    }
});
test('opening another connection does not declare other workers lost or impose exclusive ownership', t => {
    const f = fixture(t);
    f.publish();
    const c = f.ledger.claim(f.enqueue().id, 'live-worker').command;
    const second = new Ledger(f.db, () => baseTime);
    try {
        assert.equal(second.getCommand(c.id).status, 'dispatching');
        assert.equal(f.ledger.getCommand(c.id).status, 'dispatching');
    }
    finally {
        second.close();
    }
});
test('commit reservations block only conflicting paths; multi-path failure leaves no partial reservation', t => {
    const f = fixture(t);
    f.publish();
    f.publish('task-b');
    const a = f.ledger.reserveCommit('task-a', f.ledger.getTask('task-a').revision, ['input.txt'], 'commit-a');
    assert.throws(() => f.ledger.reserveCommit('task-b', f.ledger.getTask('task-b').revision, ['input.txt', 'second.txt'], 'conflict'), errorCode('RESOURCE_BUSY'));
    const b = f.ledger.reserveCommit('task-b', f.ledger.getTask('task-b').revision, ['second.txt'], 'commit-b');
    assert.equal(f.ledger.checkCommit('task-b', b.id).id, b.id);
    assert(f.ledger.claim(f.enqueue('task-b', 'work').id, 'independent-reader').claimed);
    assert.equal(f.ledger.checkCommit('task-a', a.id).id, a.id);
});
test('reservations survive reopening and stale release cannot clear a new holder', t => {
    const f = fixture(t);
    f.publish();
    f.publish('task-b');
    const first = f.ledger.reserveCommit('task-a', f.ledger.getTask('task-a').revision, ['input.txt'], 'first');
    const reopened = new Ledger(f.db, () => baseTime);
    try {
        assert.equal(reopened.checkCommit('task-a', first.id).id, first.id);
        assert.throws(() => reopened.releaseCommit('task-b', first.id), errorCode('WRONG_RESERVATION'));
        reopened.releaseCommit('task-a', first.id);
        const next = reopened.reserveCommit('task-b', reopened.getTask('task-b').revision, ['input.txt'], 'next');
        reopened.releaseCommit('task-a', first.id);
        assert.equal(reopened.checkCommit('task-b', next.id).id, next.id);
    }
    finally {
        reopened.close();
    }
});
test('packet update invalidates old commit reservation without silently stealing or releasing it', t => {
    const f = fixture(t);
    f.publish();
    f.publish('task-b');
    const held = f.ledger.reserveCommit('task-a', f.ledger.getTask('task-a').revision, ['input.txt'], 'old-version');
    f.ledger.publishPacket(f.packet('task-a', 2), f.ledger.getTask('task-a').revision);
    assert.throws(() => f.ledger.checkCommit('task-a', held.id), errorCode('STALE_RESERVATION'));
    assert.throws(() => f.ledger.reserveCommit('task-b', f.ledger.getTask('task-b').revision, ['input.txt']), errorCode('RESOURCE_BUSY'));
    f.ledger.releaseCommit('task-a', held.id);
    assert(f.ledger.reserveCommit('task-b', f.ledger.getTask('task-b').revision, ['input.txt']).id);
});
test('task cannot be completed with queued work or a held commit, but unrelated active tasks do not block it', t => {
    const f = fixture(t);
    f.publish();
    f.publish('task-b');
    const done = succeed(f.ledger, f.enqueue());
    f.enqueue();
    assert.throws(() => f.ledger.complete('task-a', f.ledger.getTask('task-a').revision, done.resultId), errorCode('TASK_UNSETTLED'));
    f.ledger.requestControl('task-a', f.ledger.getTask('task-a').revision, 'pause');
    f.ledger.resume('task-a', f.ledger.getTask('task-a').revision);
    const held = f.ledger.reserveCommit('task-a', f.ledger.getTask('task-a').revision, ['input.txt']);
    assert.throws(() => f.ledger.complete('task-a', f.ledger.getTask('task-a').revision, done.resultId), errorCode('COMMIT_UNSETTLED'));
    f.ledger.releaseCommit('task-a', held.id);
    f.ledger.claim(f.enqueue('task-b').id, 'still-working');
    assert.equal(f.ledger.complete('task-a', f.ledger.getTask('task-a').revision, done.resultId).stage, 'completed');
});
test('old or foreign database is rejected rather than migrated or overwritten', t => {
    const f = fixture(t), foreignFile = path.join(f.root, 'foreign.sqlite');
    const foreign = new DatabaseSync(foreignFile);
    foreign.exec("CREATE TABLE user_data(value TEXT);INSERT INTO user_data VALUES('keep');");
    foreign.close();
    assert.throws(() => new Ledger(foreignFile), errorCode('UNSUPPORTED_DATABASE'));
    const check = new DatabaseSync(foreignFile);
    try {
        assert.equal(check.prepare('SELECT value FROM user_data').get()?.value, 'keep');
        assert.equal(check.prepare('PRAGMA user_version').get()?.user_version, 0);
    }
    finally {
        check.close();
    }
});
test('failure during packet commit rolls back task version and superseded commands together', t => {
    const f = fixture(t);
    const original = f.publish();
    const queued = f.enqueue();
    const before = f.ledger.getTask(original.id), injector = new DatabaseSync(f.db);
    try {
        injector.exec("CREATE TRIGGER fail_packet BEFORE INSERT ON packets WHEN NEW.version=2 BEGIN SELECT RAISE(ABORT,'fixture commit failure'); END;");
        assert.throws(() => f.ledger.publishPacket(f.packet('task-a', 2), before.revision), /fixture commit failure/);
        assert.deepEqual(f.ledger.getTask('task-a'), before);
        assert.equal(f.ledger.getCommand(queued.id).status, 'queued');
        assert.throws(() => f.ledger.getPacket('task-a', 2), errorCode('PACKET_NOT_FOUND'));
    }
    finally {
        injector.close();
    }
});
test('output metadata is durable; later output changes prevent selecting a false final result', t => {
    const f = fixture(t);
    f.publish();
    const command = f.ledger.claim(f.enqueue().id, 'worker').command;
    f.ledger.receive(receipt(command, 'received', 1));
    f.ledger.receive(receipt(command, 'running', 2));
    const work = f.ledger.executionDirectory(command.id);
    mkdirSync(work);
    writeFileSync(path.join(work, 'result.txt'), 'stable output');
    const done = f.ledger.receive(receipt(command, 'succeeded', 3, { output: { ...output(), files: [fingerprint(work, 'result.txt')] } }));
    const second = new Ledger(f.db, () => baseTime);
    try {
        assert.deepEqual(second.getResult(done.resultId), f.ledger.getResult(done.resultId));
    }
    finally {
        second.close();
    }
    writeFileSync(path.join(work, 'result.txt'), 'changed after completion receipt');
    assert.throws(() => f.ledger.complete('task-a', f.ledger.getTask('task-a').revision, done.resultId), errorCode('RESOURCE_CHANGED'));
});
//# sourceMappingURL=concurrency.test.js.map