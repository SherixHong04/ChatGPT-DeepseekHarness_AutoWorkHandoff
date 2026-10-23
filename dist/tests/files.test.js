import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { FileEngine } from '../src/files.js';
import { createPacket, fingerprint } from '../src/packet.js';
import { errorCode, fixture, receipt } from './helpers.js';
function setup(t, two = false, checkpoint) {
    const f = fixture(t), engine = new FileEngine(f.ledger, f.workRoot, checkpoint);
    f.onCleanup(() => engine.close());
    f.ledger.publishPacket(createPacket({ ...f.input(), files: two ? ['input.txt', 'second.txt'] : ['input.txt'] }, f.packet().createdAt), null);
    const baseline = engine.createBaseline('task-a');
    const command = f.ledger.claim(f.enqueue().id, 'file-test-worker').command;
    engine.prepareExecution(command.id, baseline.id);
    const directory = f.ledger.executionDirectory(command.id);
    const success = (files) => {
        f.ledger.receive(receipt(command, 'received', 1));
        f.ledger.receive(receipt(command, 'running', 2));
        return f.ledger.receive(receipt(command, 'succeeded', 3, { output: { summary: 'Local file edit', acceptanceNotes: ['fixture'], files: files.map(name => fingerprint(directory, name)) } }));
    };
    const prepared = (files = ['input.txt'], deletions = []) => {
        const snapshot = engine.createSnapshot(command.id, files, deletions);
        success(files);
        return engine.prepareCommit(snapshot.id, f.ledger.getTask('task-a').revision);
    };
    return { ...f, engine, baseline, command, directory, success, prepared };
}
const fileModule = new URL('../src/files.js', import.meta.url).href;
const ledgerModule = new URL('../src/ledger.js', import.meta.url).href;
const workerScript = `
  import { FileEngine } from ${JSON.stringify(fileModule)};
  import { Ledger } from ${JSON.stringify(ledgerModule)};
  const [database, root, commit, point, operation = 'apply'] = process.argv.slice(1);
  const ledger = new Ledger(database);
  const engine = new FileEngine(ledger, root, where => { if (where === point) process.exit(29); });
  try { const result = operation === 'rollback' ? engine.rollbackCommit(commit) : engine.applyCommit(commit); console.log(result.phase); }
  finally { engine.close(); ledger.close(); }
`;
function crash(f, commitId, point, operation = 'apply') {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', workerScript, f.db, f.workRoot, commitId, point, operation], { encoding: 'utf8' });
    assert.equal(result.status, 29, result.stderr);
}
function concurrentWorker(f, commitId) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--input-type=module', '-e', workerScript, f.db, f.workRoot, commitId, 'none']);
        let stdout = '', stderr = '';
        child.stdout.on('data', data => { stdout += String(data); });
        child.stderr.on('data', data => { stderr += String(data); });
        child.on('error', reject);
        child.on('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr)));
    });
}
test('baseline copies only designated files; each execution is independent and baseline is reusable', t => {
    const f = setup(t);
    assert.equal(existsSync(path.join(f.directory, 'second.txt')), false);
    writeFileSync(path.join(f.directory, 'input.txt'), 'worker edits');
    assert.equal(readFileSync(path.join(f.resources, 'input.txt'), 'utf8'), 'only designated task content\n');
    assert.equal(readFileSync(path.join(f.engine.baselineDirectory(f.baseline.id), 'input.txt'), 'utf8'), 'only designated task content\n');
    assert.equal(f.engine.createBaseline('task-a').id, f.baseline.id);
    const second = f.ledger.claim(f.enqueue('task-a', 'work').id, 'other-worker').command;
    f.engine.prepareExecution(second.id, f.baseline.id);
    assert.equal(readFileSync(path.join(f.ledger.executionDirectory(second.id), 'input.txt'), 'utf8'), 'only designated task content\n');
    assert.equal(f.engine.prepareExecution(f.command.id, f.baseline.id).status, 'ready');
    assert.equal(readFileSync(path.join(f.directory, 'input.txt'), 'utf8'), 'worker edits');
});
test('binary, Unicode, empty and nested attachments survive baseline, copy, snapshot and writeback', t => {
    const f = fixture(t), engine = new FileEngine(f.ledger, f.workRoot);
    f.onCleanup(() => engine.close());
    mkdirSync(path.join(f.resources, '附件'));
    const binary = Buffer.from([0, 255, 128, 1, 13, 10]);
    writeFileSync(path.join(f.resources, '附件', '数据.bin'), binary);
    writeFileSync(path.join(f.resources, '空文件.txt'), '');
    f.ledger.publishPacket(createPacket({ ...f.input(), files: ['附件/数据.bin', '空文件.txt'] }, f.packet().createdAt), null);
    const baseline = engine.createBaseline('task-a'), command = f.ledger.claim(f.enqueue().id, 'binary-worker').command;
    engine.prepareExecution(command.id, baseline.id);
    const root = f.ledger.executionDirectory(command.id);
    assert.deepEqual(readFileSync(path.join(root, '附件', '数据.bin')), binary);
    writeFileSync(path.join(root, '空文件.txt'), '新增内容');
    const snapshot = engine.createSnapshot(command.id, ['附件/数据.bin', '空文件.txt']);
    f.ledger.receive(receipt(command, 'received', 1));
    f.ledger.receive(receipt(command, 'running', 2));
    f.ledger.receive(receipt(command, 'succeeded', 3, { output: { summary: 'binary', acceptanceNotes: [], files: snapshot.files } }));
    const commit = engine.prepareCommit(snapshot.id, f.ledger.getTask('task-a').revision);
    engine.applyCommit(commit.id);
    assert.deepEqual(readFileSync(path.join(f.resources, '附件', '数据.bin')), binary);
    assert.equal(readFileSync(path.join(f.resources, '空文件.txt'), 'utf8'), '新增内容');
});
test('a new execution inherits the selected immutable snapshot including additions/deletions while retaining the original conflict baseline', t => {
    const f = setup(t, true);
    writeFileSync(path.join(f.directory, 'input.txt'), 'stage result');
    writeFileSync(path.join(f.directory, 'new.txt'), 'new result');
    unlinkSync(path.join(f.directory, 'second.txt'));
    const seed = f.engine.createSnapshot(f.command.id, ['input.txt', 'new.txt'], ['second.txt']);
    const next = f.ledger.claim(f.enqueue('task-a', 'work').id, 'next-worker').command;
    f.engine.prepareExecution(next.id, f.baseline.id, seed.id);
    const root = f.ledger.executionDirectory(next.id);
    assert.equal(readFileSync(path.join(root, 'input.txt'), 'utf8'), 'stage result');
    assert.equal(readFileSync(path.join(root, 'new.txt'), 'utf8'), 'new result');
    assert.equal(existsSync(path.join(root, 'second.txt')), false);
    assert.equal(readFileSync(path.join(f.resources, 'input.txt'), 'utf8'), 'only designated task content\n');
    assert.equal(readFileSync(path.join(f.engine.baselineDirectory(f.baseline.id), 'input.txt'), 'utf8'), 'only designated task content\n');
    assert.throws(() => f.engine.prepareExecution(next.id, f.baseline.id), errorCode('SNAPSHOT_SEED_MISMATCH'));
    f.publish('task-b');
    const otherBaseline = f.engine.createBaseline('task-b');
    const other = f.ledger.claim(f.enqueue('task-b').id, 'other-worker').command;
    assert.throws(() => f.engine.prepareExecution(other.id, otherBaseline.id, seed.id), errorCode('SNAPSHOT_SEED_MISMATCH'));
});
test('stage snapshots remain stable while the worker continues; incomplete results cannot write back', t => {
    const f = setup(t);
    writeFileSync(path.join(f.directory, 'input.txt'), 'stage one');
    const first = f.engine.createSnapshot(f.command.id, ['input.txt']);
    writeFileSync(path.join(f.directory, 'input.txt'), 'stage two');
    const second = f.engine.createSnapshot(f.command.id, ['input.txt']);
    assert.notEqual(first.id, second.id);
    assert.equal(readFileSync(path.join(f.engine.snapshotDirectory(first.id), 'input.txt'), 'utf8'), 'stage one');
    assert.throws(() => f.engine.prepareCommit(first.id, f.ledger.getTask('task-a').revision), errorCode('RESULT_NOT_READY'));
    f.success(['input.txt']);
    assert.throws(() => f.engine.prepareCommit(first.id, f.ledger.getTask('task-a').revision), errorCode('SNAPSHOT_RESULT_MISMATCH'));
});
test('writeback backs up original bytes before replacing and repeated apply never rewrites a later user edit', t => {
    const f = setup(t);
    writeFileSync(path.join(f.directory, 'input.txt'), 'finished');
    const commit = f.prepared();
    assert.equal(readFileSync(path.join(f.engine.backupDirectory(commit.id), 'input.txt'), 'utf8'), 'only designated task content\n');
    assert.equal(readFileSync(path.join(f.resources, 'input.txt'), 'utf8'), 'only designated task content\n');
    assert.equal(f.engine.applyCommit(commit.id).phase, 'committed');
    assert.equal(f.ledger.inspectCommit(commit.id)?.active, false);
    writeFileSync(path.join(f.resources, 'input.txt'), 'later user edit');
    assert.equal(f.engine.applyCommit(commit.id).phase, 'committed');
    assert.equal(readFileSync(path.join(f.resources, 'input.txt'), 'utf8'), 'later user edit');
});
test('one conflict in a multi-file plan prevents any writes and can be aborted without overwriting the conflict', t => {
    const f = setup(t, true);
    writeFileSync(path.join(f.directory, 'input.txt'), 'change one');
    writeFileSync(path.join(f.directory, 'second.txt'), 'change two');
    const snapshot = f.engine.createSnapshot(f.command.id, ['input.txt', 'second.txt']);
    f.success(['input.txt', 'second.txt']);
    writeFileSync(path.join(f.resources, 'second.txt'), 'external edit');
    assert.throws(() => f.engine.prepareCommit(snapshot.id, f.ledger.getTask('task-a').revision), errorCode('FILE_CONFLICT'));
    assert.equal(readFileSync(path.join(f.resources, 'input.txt'), 'utf8'), 'only designated task content\n');
    const commit = f.engine.listCommits()[0];
    assert(commit.lastError);
    assert.equal(f.engine.rollbackCommit(commit.id).phase, 'rolled_back');
    assert.equal(readFileSync(path.join(f.resources, 'second.txt'), 'utf8'), 'external edit');
    assert.equal(f.ledger.inspectCommit(commit.id)?.active, false);
});
test('original changes after preparation are detected before any write', t => {
    const f = setup(t);
    writeFileSync(path.join(f.directory, 'input.txt'), 'worker');
    const commit = f.prepared();
    writeFileSync(path.join(f.resources, 'input.txt'), 'user');
    assert.throws(() => f.engine.applyCommit(commit.id), errorCode('FILE_CONFLICT'));
    assert.equal(readFileSync(path.join(f.resources, 'input.txt'), 'utf8'), 'user');
});
test('new files require absent targets; unlisted existing files cannot be overwritten', t => {
    const f = setup(t);
    writeFileSync(path.join(f.directory, 'second.txt'), 'attempted replacement');
    const snapshot = f.engine.createSnapshot(f.command.id, ['second.txt']);
    f.success(['second.txt']);
    assert.throws(() => f.engine.prepareCommit(snapshot.id, f.ledger.getTask('task-a').revision), errorCode('FILE_CONFLICT'));
    assert.equal(readFileSync(path.join(f.resources, 'second.txt'), 'utf8'), 'another independent file\n');
});
test('explicit additions and deletions commit and restore through a new backed-up transaction', t => {
    const f = setup(t, true);
    unlinkSync(path.join(f.directory, 'second.txt'));
    mkdirSync(path.join(f.directory, 'output'));
    writeFileSync(path.join(f.directory, 'output', 'new.txt'), 'new file');
    const commit = f.prepared(['output/new.txt'], ['second.txt']);
    f.engine.applyCommit(commit.id);
    assert.equal(existsSync(path.join(f.resources, 'second.txt')), false);
    assert.equal(readFileSync(path.join(f.resources, 'output', 'new.txt'), 'utf8'), 'new file');
    assert.equal(readFileSync(path.join(f.resources, 'input.txt'), 'utf8'), 'only designated task content\n');
    const restore = f.engine.prepareRestore(commit.id, f.ledger.getTask('task-a').revision);
    assert.notEqual(restore.id, commit.id);
    assert.equal(restore.restoreOf, commit.id);
    f.engine.applyCommit(restore.id);
    assert.equal(readFileSync(path.join(f.resources, 'second.txt'), 'utf8'), 'another independent file\n');
    assert.equal(existsSync(path.join(f.resources, 'output', 'new.txt')), false);
});
test('deletion is explicit, limited to baseline files and requires removal from working copy', t => {
    const f = setup(t);
    assert.throws(() => f.engine.createSnapshot(f.command.id, [], ['second.txt']), errorCode('UNAUTHORIZED_DELETE'));
    assert.throws(() => f.engine.createSnapshot(f.command.id, [], ['input.txt']), errorCode('FILE_CONFLICT'));
    assert.throws(() => f.engine.createSnapshot(f.command.id, ['input.txt'], ['input.txt']), errorCode('DUPLICATE_RESOURCE'));
});
test('snapshot and backup corruption are detected; originals are preserved', t => {
    const f = setup(t);
    writeFileSync(path.join(f.directory, 'input.txt'), 'finished');
    const commit = f.prepared();
    writeFileSync(path.join(f.engine.snapshotDirectory(commit.snapshotId), 'input.txt'), 'corrupt snapshot');
    assert.throws(() => f.engine.applyCommit(commit.id), errorCode('RESOURCE_CHANGED'));
    assert.equal(readFileSync(path.join(f.resources, 'input.txt'), 'utf8'), 'only designated task content\n');
    writeFileSync(path.join(f.engine.backupDirectory(commit.id), 'input.txt'), 'corrupt backup');
    assert.throws(() => f.engine.rollbackCommit(commit.id), errorCode('RESOURCE_CHANGED'));
});
test('stale packet or paused task blocks applying but permits rollback', t => {
    const f = setup(t);
    writeFileSync(path.join(f.directory, 'input.txt'), 'finished');
    const commit = f.prepared();
    f.ledger.requestControl('task-a', f.ledger.getTask('task-a').revision, 'pause');
    assert.throws(() => f.engine.applyCommit(commit.id), errorCode('TASK_NOT_OPEN'));
    assert.equal(f.engine.rollbackCommit(commit.id).phase, 'rolled_back');
    f.ledger.resume('task-a', f.ledger.getTask('task-a').revision);
    const second = f.engine.prepareCommit(commit.snapshotId, f.ledger.getTask('task-a').revision);
    f.ledger.publishPacket(f.packet('task-a', 2), f.ledger.getTask('task-a').revision);
    assert.throws(() => f.engine.applyCommit(second.id), errorCode('STALE_SNAPSHOT'));
    assert.equal(f.engine.rollbackCommit(second.id).phase, 'rolled_back');
});
test('crash after a file replacement is reconciled from durable intent and resumed exactly once', t => {
    const f = setup(t, true);
    writeFileSync(path.join(f.directory, 'input.txt'), 'one');
    writeFileSync(path.join(f.directory, 'second.txt'), 'two');
    const commit = f.prepared(['input.txt', 'second.txt']);
    crash(f, commit.id, 'after-apply:0');
    assert.equal(f.engine.getCommit(commit.id).changes[0].intent, 'apply');
    assert.equal(readFileSync(path.join(f.resources, 'input.txt'), 'utf8'), 'one');
    assert.equal(readFileSync(path.join(f.resources, 'second.txt'), 'utf8'), 'another independent file\n');
    const reopened = new FileEngine(f.ledger, f.workRoot);
    f.onCleanup(() => reopened.close());
    assert.equal(reopened.applyCommit(commit.id).phase, 'committed');
    assert.equal(readFileSync(path.join(f.resources, 'second.txt'), 'utf8'), 'two');
    assert.equal(f.ledger.inspectCommit(commit.id)?.active, false);
});
test('crash after a deletion can be rolled back from backup without continuing writes', t => {
    const f = setup(t, true);
    unlinkSync(path.join(f.directory, 'second.txt'));
    const commit = f.prepared([], ['second.txt']);
    crash(f, commit.id, 'after-apply:0');
    assert.equal(existsSync(path.join(f.resources, 'second.txt')), false);
    f.ledger.requestControl('task-a', f.ledger.getTask('task-a').revision, 'cancel');
    assert.equal(f.engine.rollbackCommit(commit.id).phase, 'rolled_back');
    assert.equal(readFileSync(path.join(f.resources, 'second.txt'), 'utf8'), 'another independent file\n');
});
test('interrupted rollback resumes and does not repeat the forward write', t => {
    const f = setup(t, true);
    writeFileSync(path.join(f.directory, 'input.txt'), 'one');
    writeFileSync(path.join(f.directory, 'second.txt'), 'two');
    const commit = f.prepared(['input.txt', 'second.txt']);
    crash(f, commit.id, 'after-apply:1');
    crash(f, commit.id, 'after-rollback:1', 'rollback');
    assert.equal(f.engine.getCommit(commit.id).phase, 'rolling_back');
    assert.throws(() => f.engine.applyCommit(commit.id), errorCode('COMMIT_ROLLED_BACK'));
    assert.equal(f.engine.rollbackCommit(commit.id).phase, 'rolled_back');
    assert.equal(readFileSync(path.join(f.resources, 'input.txt'), 'utf8'), 'only designated task content\n');
    assert.equal(readFileSync(path.join(f.resources, 'second.txt'), 'utf8'), 'another independent file\n');
});
test('external edits after crash block both resume and rollback and retain the reservation', t => {
    const f = setup(t);
    writeFileSync(path.join(f.directory, 'input.txt'), 'worker');
    const commit = f.prepared();
    crash(f, commit.id, 'after-apply:0');
    writeFileSync(path.join(f.resources, 'input.txt'), 'manual edit after crash');
    assert.throws(() => f.engine.applyCommit(commit.id), errorCode('FILE_CONFLICT'));
    assert.throws(() => f.engine.rollbackCommit(commit.id), errorCode('FILE_CONFLICT'));
    assert.equal(f.ledger.inspectCommit(commit.id)?.active, true);
    assert.equal(readFileSync(path.join(f.resources, 'input.txt'), 'utf8'), 'manual edit after crash');
});
test('crash after recording completion releases the reservation when reopened', t => {
    const f = setup(t);
    writeFileSync(path.join(f.directory, 'input.txt'), 'worker');
    const commit = f.prepared();
    crash(f, commit.id, 'committed');
    assert.equal(f.ledger.inspectCommit(commit.id)?.active, true);
    assert.equal(f.engine.applyCommit(commit.id).phase, 'committed');
    assert.equal(f.ledger.inspectCommit(commit.id)?.active, false);
});
test('crash with a complete sibling temp file resumes or rolls back without leaving that temp file', t => {
    for (const operation of ['apply', 'rollback']) {
        const f = setup(t);
        writeFileSync(path.join(f.directory, 'input.txt'), 'worker');
        const commit = f.prepared();
        crash(f, commit.id, 'staged:0');
        const temporary = path.join(f.resources, `.wh-${commit.id}-0-a.tmp`);
        assert.equal(existsSync(temporary), true);
        if (operation === 'apply')
            f.engine.applyCommit(commit.id);
        else
            f.engine.rollbackCommit(commit.id);
        assert.equal(existsSync(temporary), false);
        assert.equal(readFileSync(path.join(f.resources, 'input.txt'), 'utf8'), operation === 'apply' ? 'worker' : 'only designated task content\n');
    }
});
test('two actual processes applying the same journal serialize safely and both see completion', async (t) => {
    const f = setup(t);
    writeFileSync(path.join(f.directory, 'input.txt'), 'worker');
    const commit = f.prepared();
    const phases = await Promise.all([concurrentWorker(f, commit.id), concurrentWorker(f, commit.id)]);
    assert.deepEqual(phases, ['committed', 'committed']);
    assert.equal(readFileSync(path.join(f.resources, 'input.txt'), 'utf8'), 'worker');
    assert.equal(f.engine.getCommit(commit.id).changes.filter(item => item.applied).length, 1);
});
test('overlapping reservations conflict, while unrelated task paths remain available', t => {
    const f = setup(t);
    writeFileSync(path.join(f.directory, 'input.txt'), 'worker');
    const commit = f.prepared();
    f.publish('task-b');
    assert.throws(() => f.ledger.reserveCommit('task-b', f.ledger.getTask('task-b').revision, ['input.txt']), errorCode('RESOURCE_BUSY'));
    const independent = f.ledger.reserveCommit('task-b', f.ledger.getTask('task-b').revision, ['second.txt']);
    f.engine.applyCommit(commit.id);
    assert.equal(f.ledger.inspectCommit(independent.id)?.active, true);
    f.ledger.releaseCommit('task-b', independent.id);
});
test('two independent task journals can physically commit in separate processes', async (t) => {
    const f = setup(t);
    writeFileSync(path.join(f.directory, 'input.txt'), 'task A');
    const first = f.prepared();
    f.ledger.publishPacket(createPacket({ ...f.input('task-b'), files: ['second.txt'] }, f.packet().createdAt), null);
    const baseline = f.engine.createBaseline('task-b'), command = f.ledger.claim(f.enqueue('task-b', 'work').id, 'worker-b').command;
    f.engine.prepareExecution(command.id, baseline.id);
    const copy = f.ledger.executionDirectory(command.id);
    writeFileSync(path.join(copy, 'second.txt'), 'task B');
    const snapshot = f.engine.createSnapshot(command.id, ['second.txt']);
    f.ledger.receive(receipt(command, 'received', 1));
    f.ledger.receive(receipt(command, 'running', 2));
    f.ledger.receive(receipt(command, 'succeeded', 3, { output: { summary: 'B done', acceptanceNotes: [], files: snapshot.files } }));
    const second = f.engine.prepareCommit(snapshot.id, f.ledger.getTask('task-b').revision);
    assert.deepEqual(await Promise.all([concurrentWorker(f, first.id), concurrentWorker(f, second.id)]), ['committed', 'committed']);
    assert.equal(readFileSync(path.join(f.resources, 'input.txt'), 'utf8'), 'task A');
    assert.equal(readFileSync(path.join(f.resources, 'second.txt'), 'utf8'), 'task B');
});
test('paths, junctions and pre-existing execution folders cannot redirect copies or writeback', t => {
    const f = setup(t);
    assert.throws(() => f.engine.createSnapshot(f.command.id, ['../second.txt']), errorCode('INVALID_PATH'));
    const outside = path.join(f.root, 'outside');
    mkdirSync(outside);
    writeFileSync(path.join(outside, 'file.txt'), 'preserved');
    symlinkSync(outside, path.join(f.directory, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => f.engine.createSnapshot(f.command.id, ['link/file.txt']), errorCode('LINKED_RESOURCE'));
    const second = f.ledger.claim(f.enqueue('task-a', 'work').id, 'second-worker').command;
    mkdirSync(f.ledger.executionDirectory(second.id));
    assert.throws(() => f.engine.prepareExecution(second.id, f.baseline.id), errorCode('WORKSPACE_EXISTS'));
    assert.equal(readFileSync(path.join(outside, 'file.txt'), 'utf8'), 'preserved');
});
test('baseline corruption and new-file target junctions stop writeback without modifying linked content', t => {
    const f = setup(t);
    writeFileSync(path.join(f.engine.baselineDirectory(f.baseline.id), 'input.txt'), 'corrupt');
    assert.throws(() => f.engine.createBaseline('task-a'), errorCode('RESOURCE_CHANGED'));
    mkdirSync(path.join(f.directory, 'fresh'));
    writeFileSync(path.join(f.directory, 'fresh', 'file.txt'), 'worker');
    const snapshot = f.engine.createSnapshot(f.command.id, ['fresh/file.txt']);
    f.success(['fresh/file.txt']);
    const outside = path.join(f.root, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, path.join(f.resources, 'fresh'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => f.engine.prepareCommit(snapshot.id, f.ledger.getTask('task-a').revision), errorCode('LINKED_RESOURCE'));
    assert.equal(existsSync(path.join(outside, 'file.txt')), false);
});
test('backup restore refuses to overwrite subsequent edits; completed task requires a separate recovery task', t => {
    const f = setup(t);
    writeFileSync(path.join(f.directory, 'input.txt'), 'worker');
    const commit = f.prepared();
    f.engine.applyCommit(commit.id);
    writeFileSync(path.join(f.resources, 'input.txt'), 'later edit');
    assert.throws(() => f.engine.prepareRestore(commit.id, f.ledger.getTask('task-a').revision), errorCode('FILE_CONFLICT'));
    assert.equal(readFileSync(path.join(f.resources, 'input.txt'), 'utf8'), 'later edit');
    const failedRestore = f.engine.listCommits().find(item => item.restoreOf === commit.id);
    f.engine.rollbackCommit(failedRestore.id);
    const result = f.ledger.getCommand(f.command.id).resultId;
    f.ledger.complete('task-a', f.ledger.getTask('task-a').revision, result);
    assert.throws(() => f.engine.prepareRestore(commit.id, f.ledger.getTask('task-a').revision), errorCode('TASK_NOT_OPEN'));
});
test('unknown executions can preserve snapshots but cannot write; rework still requires GPT finalization', t => {
    const f = setup(t);
    writeFileSync(path.join(f.directory, 'input.txt'), 'worker');
    f.ledger.markWorkerLost(f.command.workerId, 'fixture disconnect');
    const snapshot = f.engine.createSnapshot(f.command.id, ['input.txt']);
    assert.throws(() => f.engine.prepareCommit(snapshot.id, f.ledger.getTask('task-a').revision), errorCode('RESULT_NOT_READY'));
    const g = setup(t);
    writeFileSync(path.join(g.directory, 'input.txt'), 'first result');
    const first = g.engine.createSnapshot(g.command.id, ['input.txt']);
    const done = g.success(['input.txt']);
    g.ledger.requestRework('task-a', g.ledger.getTask('task-a').revision, done.resultId, 'one permitted revision');
    assert.throws(() => g.engine.prepareCommit(first.id, g.ledger.getTask('task-a').revision), errorCode('WORK_FINISH_REQUIRED'));
});
test('foreign file catalog is rejected without altering its rows or identity', t => {
    const f = fixture(t), storage = path.join(f.workRoot, '.handoff-files');
    mkdirSync(storage);
    const database = path.join(storage, 'catalog.sqlite'), db = new DatabaseSync(database);
    db.exec("CREATE TABLE private_data(value TEXT); INSERT INTO private_data VALUES('preserve'); PRAGMA application_id=1234; PRAGMA user_version=7;");
    db.close();
    assert.throws(() => new FileEngine(f.ledger, f.workRoot), errorCode('UNSUPPORTED_FILE_DATABASE'));
    assert.equal(existsSync(path.join(storage, 'baselines')), false);
    const verify = new DatabaseSync(database);
    try {
        assert.equal(verify.prepare('SELECT value FROM private_data').get()?.value, 'preserve');
        assert.equal(verify.prepare('PRAGMA application_id').get()?.application_id, 1234);
    }
    finally {
        verify.close();
    }
});
//# sourceMappingURL=files.test.js.map