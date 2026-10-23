import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { canonical, requireCondition, terminal } from './contracts.js';
import { checkedRoot, digest, fingerprint, pathKey, relativePath, resourcePath, resources, verifyResources } from './packet.js';
import { Ledger } from './ledger.js';
const FILE_APP = 0x57484632;
export const FILE_ENGINE_FORMAT = 1;
const same = (a, b) => a === null || b === null ? a === b : a.bytes === b.bytes && a.sha256 === b.sha256;
function uuid(value) {
    requireCondition(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value), 'INVALID_ARTIFACT_ID', '文件记录编号不正确。');
    return value;
}
function names(value, allowEmpty = true) {
    requireCondition(Array.isArray(value) && value.length <= 256 && (allowEmpty || value.length > 0), 'INVALID_FILE_LIST', '必须明确列出文件，最多256项。');
    const result = value.map(relativePath);
    requireCondition(new Set(result.map(pathKey)).size === result.length, 'DUPLICATE_RESOURCE', '文件路径重复。');
    for (const a of result)
        for (const b of result)
            if (a !== b)
                requireCondition(!pathKey(a).startsWith(pathKey(b) + '/'), 'PATH_COLLISION', '文件路径不能互为父目录。');
    return result;
}
function ensureDirectory(root, name) {
    checkedRoot(root);
    relativePath(name);
    let directory = root;
    for (const part of name.split('/')) {
        directory = path.join(directory, part);
        try {
            mkdirSync(directory);
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
        }
        requireCondition(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), 'LINKED_RESOURCE', '工作目录不能经过链接或联接。');
    }
    return checkedRoot(directory);
}
function current(root, name) {
    try {
        return fingerprint(root, name);
    }
    catch (error) {
        if (error.code === 'ENOENT')
            return null;
        throw error;
    }
}
function expectFile(root, name, expected) {
    requireCondition(same(current(root, name), expected), 'FILE_CONFLICT', `文件已被其他操作改变，保留现场：${name}。`);
}
function parents(root, name) {
    const parent = path.posix.dirname(relativePath(name));
    if (parent !== '.')
        ensureDirectory(root, parent);
}
// Copies bytes into a new file; never hard-links, enumerates a directory, or replaces an existing file.
function copyNew(source, target, file, targetName = file.path) {
    verifyResources(source, [file]);
    parents(target, targetName);
    const from = openSync(resourcePath(checkedRoot(source), file.path), 'r');
    let to;
    try {
        to = openSync(resourcePath(checkedRoot(target), targetName, false), 'wx');
        const buffer = Buffer.alloc(64 * 1024);
        let position = 0, count;
        while ((count = readSync(from, buffer, 0, buffer.length, position)) > 0) {
            let written = 0;
            while (written < count)
                written += writeSync(to, buffer, written, count - written);
            position += count;
        }
        fsyncSync(to);
    }
    finally {
        if (to !== undefined)
            closeSync(to);
        closeSync(from);
    }
    const actual = fingerprint(target, targetName);
    requireCondition(same(actual, file), 'COPY_CHANGED', '文件在复制期间改变，副本不予发布。');
    verifyResources(source, [file]);
}
function openDatabase(filename) {
    checkedRoot(path.dirname(filename));
    if (existsSync(filename))
        requireCondition(lstatSync(filename).isFile() && !lstatSync(filename).isSymbolicLink(), 'LINKED_DATABASE', '文件记录数据库不能是链接。');
    const db = new DatabaseSync(filename, { allowExtension: false });
    try {
        db.exec('PRAGMA busy_timeout=5000');
        const application = Number(db.prepare('PRAGMA application_id').get()?.application_id);
        const version = Number(db.prepare('PRAGMA user_version').get()?.user_version);
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        requireCondition((application === 0 && version === 0 && tables.length === 0) || (application === FILE_APP && version === 1), 'UNSUPPORTED_FILE_DATABASE', '文件记录数据库不属于本版本，拒绝修改。');
        db.exec(`PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA application_id=${FILE_APP}; PRAGMA user_version=1;
      CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL, name TEXT NOT NULL, signature TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind,name));`);
        return db;
    }
    catch (error) {
        db.close();
        throw error;
    }
}
/** Explicit file copies and recoverable, per-file writeback. No network or host/security control. */
export class FileEngine {
    ledger;
    checkpoint;
    storageRoot;
    workRoot;
    db;
    constructor(ledger, workRoot, checkpoint) {
        this.ledger = ledger;
        this.checkpoint = checkpoint;
        this.workRoot = checkedRoot(workRoot);
        this.storageRoot = ensureDirectory(this.workRoot, '.handoff-files');
        this.db = openDatabase(resourcePath(this.storageRoot, 'catalog.sqlite', false));
        try {
            for (const directory of ['baselines', 'snapshots', 'commits', 'copies', 'locks'])
                ensureDirectory(this.storageRoot, directory);
        }
        catch (error) {
            this.db.close();
            throw error;
        }
    }
    close() { this.db.close(); }
    get(kind, name) {
        const row = this.db.prepare('SELECT signature,payload FROM records WHERE kind=? AND name=?').get(kind, name);
        requireCondition(row, 'FILE_RECORD_NOT_FOUND', '文件记录尚未发布。');
        const payload = JSON.parse(String(row.payload));
        requireCondition(digest(payload) === row.signature, 'FILE_RECORD_CORRUPT', '文件记录指纹不匹配。');
        return payload;
    }
    has(kind, name) { return !!this.db.prepare('SELECT name FROM records WHERE kind=? AND name=?').get(kind, name); }
    save(kind, name, value, replace = false) {
        this.db.prepare(replace ? 'INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(kind,name) DO UPDATE SET signature=excluded.signature,payload=excluded.payload'
            : 'INSERT INTO records VALUES(?,?,?,?)').run(kind, name, digest(value), canonical(value));
    }
    locked(key, body) {
        // SQLite owns this process lock. A crashed process cannot leave a stale lock flag.
        const lock = openDatabase(resourcePath(this.storageRoot, `locks/${digest(key)}.sqlite`, false));
        try {
            lock.exec('BEGIN IMMEDIATE');
            try {
                return body();
            }
            finally {
                lock.exec('ROLLBACK');
            }
        }
        finally {
            lock.close();
        }
    }
    packet(taskId, version) {
        const committed = this.ledger.getPacket(taskId, version);
        requireCondition(pathKey(committed.packet.workRoot) === pathKey(this.workRoot), 'WRONG_WORK_ROOT', '任务不属于此工作目录。');
        return committed;
    }
    artifact(kind, artifactId, suffix = 'files') {
        return resourcePath(checkedRoot(this.storageRoot), `${kind}/${uuid(artifactId)}/${suffix}`);
    }
    createArtifact(kind, artifactId, suffix = 'files') {
        return ensureDirectory(this.storageRoot, `${kind}/${uuid(artifactId)}/${suffix}`);
    }
    getBaseline(baselineId) { return this.get('baseline', uuid(baselineId)); }
    baselineDirectory(baselineId) { this.getBaseline(baselineId); return this.artifact('baselines', baselineId); }
    createBaseline(taskId, version) {
        const committed = this.packet(taskId, version), packet = committed.packet;
        const key = digest([taskId, packet.version]);
        return this.locked(`baseline:${key}`, () => {
            if (this.has('baseline-key', key)) {
                const existing = this.getBaseline(this.get('baseline-key', key));
                requireCondition(existing.packetSha256 === committed.sha256, 'BASELINE_MISMATCH', '基准不匹配任务包。');
                verifyResources(this.baselineDirectory(existing.id), existing.files);
                return existing;
            }
            const baseline = { id: randomUUID(), taskId, packetVersion: packet.version, createdAt: Date.now(), packetSha256: committed.sha256, files: packet.resources };
            const directory = this.createArtifact('baselines', baseline.id);
            for (const file of baseline.files)
                copyNew(packet.resourceRoot, directory, file);
            verifyResources(packet.resourceRoot, baseline.files);
            verifyResources(directory, baseline.files);
            this.db.exec('BEGIN IMMEDIATE');
            try {
                this.save('baseline', baseline.id, baseline);
                this.save('baseline-key', key, baseline.id);
                this.db.exec('COMMIT');
            }
            catch (error) {
                this.db.exec('ROLLBACK');
                throw error;
            }
            return baseline;
        });
    }
    prepareExecution(commandId, baselineId, seedSnapshotId = null) {
        return this.locked(`copy:${commandId}`, () => {
            const command = this.ledger.getCommand(commandId), baseline = this.getBaseline(baselineId);
            this.packet(command.taskId, command.packetVersion);
            requireCondition(command.executionId && !terminal(command.status) && command.status !== 'unknown', 'EXECUTION_NOT_ACTIVE', '只为已登记且状态明确的执行准备工作副本。');
            requireCondition(baseline.taskId === command.taskId && baseline.packetVersion === command.packetVersion, 'BASELINE_MISMATCH', '工作副本基准不匹配。');
            const seed = seedSnapshotId ? this.verifySnapshot(seedSnapshotId) : null;
            if (seed)
                requireCondition(seed.taskId === command.taskId && seed.packetVersion === command.packetVersion && seed.baselineId === baselineId, 'SNAPSHOT_SEED_MISMATCH', '继承成果必须属于同一任务、任务包及原件基准。');
            const expected = seed ? [...baseline.files.filter(file => ![...seed.files.map(item => item.path), ...seed.deletions]
                    .some(name => pathKey(name) === pathKey(file.path))), ...seed.files] : baseline.files;
            const root = this.ledger.executionDirectory(commandId);
            let copy;
            if (this.has('copy', commandId)) {
                copy = this.get('copy', commandId);
                requireCondition(copy.baselineId === baselineId, 'BASELINE_MISMATCH', '执行不能更换基准。');
                requireCondition((copy.seedSnapshotId ?? null) === seedSnapshotId, 'SNAPSHOT_SEED_MISMATCH', '执行不能更换已选定成果快照。');
                if (copy.status === 'ready') {
                    checkedRoot(root);
                    return copy;
                }
            }
            else {
                requireCondition(!existsSync(root), 'WORKSPACE_EXISTS', '已有执行目录，拒绝覆盖或接管。');
                copy = { commandId, baselineId, status: 'preparing', seedSnapshotId };
                this.save('copy', commandId, copy);
            }
            const source = this.baselineDirectory(baselineId);
            verifyResources(source, baseline.files);
            if (existsSync(root)) {
                // The complete staging directory may have been renamed just before a process crash.
                for (const file of expected)
                    verifyResources(root, [file]);
                if (seed)
                    for (const name of seed.deletions)
                        expectFile(root, name, null);
            }
            else {
                const staging = ensureDirectory(this.storageRoot, `copies/${randomUUID()}/files`);
                for (const file of baseline.files)
                    copyNew(source, staging, file);
                if (seed) {
                    for (const file of seed.files) {
                        if (current(staging, file.path))
                            unlinkSync(resourcePath(staging, file.path));
                        copyNew(this.snapshotDirectory(seed.id), staging, file);
                    }
                    for (const name of seed.deletions)
                        if (current(staging, name))
                            unlinkSync(resourcePath(staging, name));
                }
                for (const file of expected)
                    verifyResources(staging, [file]);
                requireCondition(!existsSync(root), 'WORKSPACE_EXISTS', '执行目录在准备期间已出现，拒绝覆盖。');
                renameSync(staging, resourcePath(checkedRoot(this.workRoot), command.executionId, false));
            }
            copy.status = 'ready';
            this.save('copy', commandId, copy, true);
            return copy;
        });
    }
    getSnapshot(snapshotId) { return this.get('snapshot', uuid(snapshotId)); }
    snapshotDirectory(snapshotId) { this.getSnapshot(snapshotId); return this.artifact('snapshots', snapshotId); }
    verifySnapshot(snapshotId) {
        const snapshot = this.getSnapshot(snapshotId);
        verifyResources(this.snapshotDirectory(snapshotId), snapshot.files);
        return snapshot;
    }
    createSnapshot(commandId, files, deletions = []) {
        const copy = this.get('copy', commandId), command = this.ledger.getCommand(commandId);
        requireCondition(copy.status === 'ready', 'WORKSPACE_NOT_READY', '工作副本尚未准备完成。');
        const baseline = this.getBaseline(copy.baselineId), directory = this.ledger.executionDirectory(commandId);
        this.packet(command.taskId, command.packetVersion);
        names([...files, ...deletions]);
        for (const name of deletions) {
            requireCondition(baseline.files.some(file => pathKey(file.path) === pathKey(name)), 'UNAUTHORIZED_DELETE', '只能明确删除本任务基准中已有的文件。');
            expectFile(directory, name, null);
        }
        const snapshot = { id: randomUUID(), taskId: command.taskId, packetVersion: command.packetVersion,
            createdAt: Date.now(), commandId, baselineId: baseline.id, files: files.map(name => fingerprint(directory, name)), deletions };
        const destination = this.createArtifact('snapshots', snapshot.id);
        for (const file of snapshot.files)
            copyNew(directory, destination, file);
        verifyResources(directory, snapshot.files);
        verifyResources(destination, snapshot.files);
        for (const name of deletions)
            expectFile(directory, name, null);
        this.save('snapshot', snapshot.id, snapshot);
        return snapshot;
    }
    getCommit(commitId) { return this.get('commit', uuid(commitId)); }
    listCommits() { return this.db.prepare("SELECT name FROM records WHERE kind='commit' ORDER BY rowid").all().map(row => this.getCommit(String(row.name))); }
    backupDirectory(commitId) { this.getCommit(commitId); return this.artifact('commits', commitId, 'backup'); }
    source(commit) {
        return commit.sourceKind === 'snapshot' ? this.snapshotDirectory(commit.sourceId) : this.backupDirectory(commit.sourceId);
    }
    allowed(snapshot) {
        const task = this.ledger.getTask(snapshot.taskId), command = this.ledger.getCommand(snapshot.commandId);
        requireCondition(task.packetVersion === snapshot.packetVersion, 'STALE_SNAPSHOT', '旧任务包快照不能写回。');
        requireCondition(task.control === 'open' && task.stage !== 'completed', 'TASK_NOT_OPEN', '任务暂停、取消或完成后不能继续写回。');
        requireCondition(command.status === 'succeeded' && command.resultId && command.kind !== 'review', 'RESULT_NOT_READY', '必须先收到当前执行的成功成果回执。');
        const result = this.ledger.getResult(command.resultId);
        requireCondition(canonical(resources(result.output.files).sort((a, b) => a.path.localeCompare(b.path))) === canonical([...snapshot.files].sort((a, b) => a.path.localeCompare(b.path))), 'SNAPSHOT_RESULT_MISMATCH', '快照与成功回执中的文件清单不一致。');
        requireCondition(!task.mustFinishWithWork || (command.side === 'work' && command.kind === 'finish'), 'WORK_FINISH_REQUIRED', '一次返工后必须由GPT收尾。');
        requireCondition(this.ledger.listCommands(task.id).every(item => item.kind === 'review' || terminal(item.status)), 'TASK_UNSETTLED', '本任务仍有修改指令未结算，先保存快照再决定写回。');
        return command;
    }
    createCommit(snapshot, expectedRevision, changes, sourceKind, sourceId, restoreOf) {
        names(changes.map(item => item.path), false);
        const task = this.ledger.getTask(snapshot.taskId);
        requireCondition(task.revision === expectedRevision, 'STALE_REVISION', '任务已变化，请重新读取。');
        const commit = { id: randomUUID(), taskId: snapshot.taskId, packetVersion: snapshot.packetVersion, createdAt: Date.now(),
            snapshotId: snapshot.id, expectedRevision, sourceKind, sourceId, restoreOf, phase: 'preparing', changes, lastError: null };
        this.save('commit', commit.id, commit);
        return this.locked(`commit:${commit.id}`, () => {
            try {
                return this.prepare(commit);
            }
            catch (error) {
                commit.lastError = error instanceof Error ? error.message : 'Local file error';
                this.saveCommit(commit);
                throw error;
            }
        });
    }
    prepareCommit(snapshotId, expectedRevision) {
        const snapshot = this.verifySnapshot(snapshotId);
        this.allowed(snapshot);
        const baseline = this.getBaseline(snapshot.baselineId);
        const before = (name) => baseline.files.find(file => pathKey(file.path) === pathKey(name)) ?? null;
        const changes = snapshot.files.map(after => ({ path: after.path, before: before(after.path), after, applied: false, intent: 'none' }));
        for (const name of snapshot.deletions)
            changes.push({ path: name, before: before(name), after: null, applied: false, intent: 'none' });
        return this.createCommit(snapshot, expectedRevision, changes.filter(item => !same(item.before, item.after)), 'snapshot', snapshotId, null);
    }
    prepareRestore(commitId, expectedRevision) {
        const original = this.getCommit(commitId);
        requireCondition(original.phase === 'committed', 'COMMIT_NOT_FINISHED', '完整提交后才可创建新的备份恢复提交。');
        const snapshot = this.getSnapshot(original.snapshotId);
        this.allowed(snapshot);
        verifyResources(this.backupDirectory(commitId), original.changes.flatMap(item => item.before ? [item.before] : []));
        return this.createCommit(snapshot, expectedRevision, original.changes.map(item => ({ path: item.path, before: item.after, after: item.before, applied: false, intent: 'none' })), 'backup', commitId, commitId);
    }
    saveCommit(commit) { this.save('commit', commit.id, commit, true); }
    mark(commit, point) { this.checkpoint?.(point, structuredClone(commit)); }
    prepare(commit) {
        const snapshot = this.getSnapshot(commit.snapshotId);
        this.allowed(snapshot);
        const packet = this.packet(commit.taskId, commit.packetVersion).packet;
        this.ledger.reserveCommit(commit.taskId, commit.expectedRevision, commit.changes.map(item => item.path), commit.id);
        const backup = this.createArtifact('commits', commit.id, 'backup');
        for (const item of commit.changes) {
            expectFile(packet.resourceRoot, item.path, item.before);
            if (item.before) {
                if (current(backup, item.path))
                    expectFile(backup, item.path, item.before);
                else
                    copyNew(packet.resourceRoot, backup, item.before);
            }
        }
        for (const item of commit.changes)
            expectFile(packet.resourceRoot, item.path, item.before);
        verifyResources(this.source(commit), commit.changes.flatMap(item => item.after ? [item.after] : []));
        this.ledger.checkCommit(commit.taskId, commit.id);
        commit.phase = 'prepared';
        this.saveCommit(commit);
        this.mark(commit, 'prepared');
        return commit;
    }
    release(commit) {
        const held = this.ledger.inspectCommit(commit.id);
        if (held?.active)
            this.ledger.releaseCommit(commit.taskId, commit.id);
    }
    preflight(commit, rollback) {
        const root = this.packet(commit.taskId, commit.packetVersion).packet.resourceRoot;
        for (const item of commit.changes) {
            const actual = current(root, item.path);
            const uncertain = item.intent !== 'none';
            requireCondition(uncertain ? same(actual, item.before) || same(actual, item.after) : same(actual, item.applied ? item.after : item.before), 'FILE_CONFLICT', `文件状态与提交日记不符，保留现场：${item.path}。`);
        }
        verifyResources(this.backupDirectory(commit.id), commit.changes.flatMap(item => item.before ? [item.before] : []));
        if (!rollback)
            verifyResources(this.source(commit), commit.changes.flatMap(item => item.after ? [item.after] : []));
    }
    replace(commit, item, index, rollback) {
        const root = this.packet(commit.taskId, commit.packetVersion).packet.resourceRoot;
        const wanted = rollback ? item.before : item.after, previous = rollback ? item.after : item.before;
        const actual = current(root, item.path);
        if (same(actual, wanted))
            return; // Intent was persisted before any mutation; restart acknowledges the observed bytes.
        requireCondition(same(actual, previous), 'FILE_CONFLICT', `文件在写回期间改变：${item.path}。`);
        if (wanted) {
            const temp = this.tempName(commit, item, index, rollback);
            requireCondition(!commit.changes.some(change => pathKey(change.path) === pathKey(temp)), 'PATH_COLLISION', '暂存文件与目标重名。');
            const source = rollback ? this.backupDirectory(commit.id) : this.source(commit);
            if (current(root, temp))
                expectFile(root, temp, wanted);
            else
                copyNew(source, root, wanted, temp);
            this.mark(commit, `${rollback ? 'rollback-' : ''}staged:${index}`);
            expectFile(root, item.path, previous);
            if (!rollback) {
                this.allowed(this.getSnapshot(commit.snapshotId));
                this.ledger.checkCommit(commit.taskId, commit.id);
            }
            renameSync(resourcePath(checkedRoot(root), temp), resourcePath(checkedRoot(root), item.path, false));
        }
        else {
            expectFile(root, item.path, previous);
            if (!rollback) {
                this.allowed(this.getSnapshot(commit.snapshotId));
                this.ledger.checkCommit(commit.taskId, commit.id);
            }
            unlinkSync(resourcePath(checkedRoot(root), item.path));
        }
    }
    tempName(commit, item, index, rollback) {
        return path.posix.join(path.posix.dirname(item.path), `.wh-${commit.id}-${index}-${rollback ? 'r' : 'a'}.tmp`);
    }
    cleanupTemps(commit) {
        const root = this.packet(commit.taskId, commit.packetVersion).packet.resourceRoot;
        const pending = [];
        for (const [index, item] of commit.changes.entries())
            for (const rollback of [false, true]) {
                const temp = this.tempName(commit, item, index, rollback), actual = current(root, temp);
                if (actual) {
                    const wanted = rollback ? item.before : item.after;
                    requireCondition(wanted && same(actual, wanted), 'TEMP_FILE_CONFLICT', `暂存文件未完整写入或已改变，保留并等待核实：${temp}。`);
                    pending.push(temp);
                }
            }
        for (const temp of pending)
            unlinkSync(resourcePath(checkedRoot(root), temp));
    }
    applyCommit(commitId) {
        return this.locked(`commit:${uuid(commitId)}`, () => {
            let commit = this.getCommit(commitId);
            try {
                if (commit.phase === 'committed') {
                    this.release(commit);
                    return commit;
                }
                requireCondition(commit.phase !== 'rolled_back' && commit.phase !== 'rolling_back', 'COMMIT_ROLLED_BACK', '已开始回滚的提交不能继续写回。');
                if (commit.phase === 'preparing')
                    commit = this.prepare(commit);
                this.allowed(this.getSnapshot(commit.snapshotId));
                this.ledger.checkCommit(commit.taskId, commit.id);
                this.preflight(commit, false);
                commit.phase = 'applying';
                commit.lastError = null;
                this.saveCommit(commit);
                for (const [index, item] of commit.changes.entries()) {
                    if (item.applied)
                        continue;
                    this.allowed(this.getSnapshot(commit.snapshotId));
                    this.ledger.checkCommit(commit.taskId, commit.id);
                    item.intent = 'apply';
                    this.saveCommit(commit);
                    this.mark(commit, `before-apply:${index}`);
                    this.replace(commit, item, index, false);
                    this.mark(commit, `after-apply:${index}`);
                    item.applied = true;
                    item.intent = 'none';
                    this.saveCommit(commit);
                }
                this.preflight(commit, false);
                this.cleanupTemps(commit);
                commit.phase = 'committed';
                this.saveCommit(commit);
                this.mark(commit, 'committed');
                this.release(commit);
                return commit;
            }
            catch (error) {
                commit.lastError = error instanceof Error ? error.message : 'Local file error';
                this.saveCommit(commit);
                throw error;
            }
        });
    }
    rollbackCommit(commitId) {
        return this.locked(`commit:${uuid(commitId)}`, () => {
            const commit = this.getCommit(commitId);
            try {
                requireCondition(commit.phase !== 'committed', 'RESTORE_REQUIRED', '已完成提交的恢复需要新的提交许可及冲突检查。');
                if (commit.phase === 'rolled_back') {
                    this.release(commit);
                    return commit;
                }
                const held = this.ledger.inspectCommit(commit.id);
                // Before preparation finishes there has been no target mutation, and a partial backup need not be usable.
                if (commit.phase !== 'preparing') {
                    requireCondition(held?.active && held.reservation.taskId === commit.taskId, 'RESERVATION_INACTIVE', '提交许可丢失，不能自动恢复。');
                    this.preflight(commit, true);
                    commit.phase = 'rolling_back';
                    commit.lastError = null;
                    this.saveCommit(commit);
                    for (const [index, item] of [...commit.changes.entries()].reverse()) {
                        if (!item.applied && item.intent === 'none')
                            continue;
                        item.intent = 'rollback';
                        this.saveCommit(commit);
                        this.mark(commit, `before-rollback:${index}`);
                        this.replace(commit, item, index, true);
                        this.mark(commit, `after-rollback:${index}`);
                        item.applied = false;
                        item.intent = 'none';
                        this.saveCommit(commit);
                    }
                    this.preflight(commit, true);
                    this.cleanupTemps(commit);
                }
                commit.phase = 'rolled_back';
                this.saveCommit(commit);
                this.release(commit);
                return commit;
            }
            catch (error) {
                commit.lastError = error instanceof Error ? error.message : 'Local file error';
                this.saveCommit(commit);
                throw error;
            }
        });
    }
}
//# sourceMappingURL=files.js.map