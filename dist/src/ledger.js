import { DatabaseSync } from 'node:sqlite';
import { lstatSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, id, inFlight, positive, record, requireCondition, side, terminal, text } from './contracts.js';
import { checkedRoot, digest, pathKey, relativePath, resourcePath, validateOutput, validatePacket, verifyResources } from './packet.js';
const APP_ID = 0x57485032;
const statuses = ['received', 'running', 'succeeded', 'failed', 'cancelled'];
const mutating = (kind) => kind !== 'review';
export const taskPhase = (task) => task.control === 'open' ? task.stage : task.control;
/** Local state only. No process control, network requests or plugin installation. */
export class Ledger {
    clock;
    db;
    constructor(filename, clock = Date.now) {
        this.clock = clock;
        requireCondition(filename === ':memory:' || path.isAbsolute(filename), 'ABSOLUTE_DB_REQUIRED', '账本路径必须明确。');
        if (filename !== ':memory:') {
            mkdirSync(path.dirname(filename), { recursive: true });
            checkedRoot(path.dirname(filename));
            try {
                const info = lstatSync(filename);
                requireCondition(info.isFile() && !info.isSymbolicLink(), 'LINKED_DATABASE', '账本不能指向链接或特殊文件。');
            }
            catch (error) {
                if (error.code !== 'ENOENT')
                    throw error;
            }
        }
        this.db = new DatabaseSync(filename, { enableForeignKeyConstraints: true, allowExtension: false });
        try {
            this.db.exec('PRAGMA busy_timeout=5000');
            const application = Number(this.db.prepare('PRAGMA application_id').get()?.application_id);
            const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
            const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
            requireCondition((application === 0 && version === 0 && tables.length === 0) || (application === APP_ID && version === 1), 'UNSUPPORTED_DATABASE', '账本不属于新版或版本不支持，拒绝修改旧数据。');
            this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
            this.db.exec('BEGIN IMMEDIATE');
            try {
                this.db.exec(`
        CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS packets(task_id TEXT NOT NULL REFERENCES tasks(id), version INTEGER NOT NULL,
          sha256 TEXT NOT NULL, committed_at INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(task_id,version));
        CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
          idempotency_key TEXT NOT NULL, signature TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL,
          UNIQUE(task_id,idempotency_key));
        CREATE TABLE IF NOT EXISTS receipts(event_id TEXT PRIMARY KEY, command_id TEXT NOT NULL REFERENCES commands(id),
          sequence INTEGER NOT NULL, signature TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(command_id,sequence));
        CREATE TABLE IF NOT EXISTS results(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS control_requests(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
          idempotency_key TEXT NOT NULL, payload TEXT NOT NULL, UNIQUE(task_id,idempotency_key));
        CREATE TABLE IF NOT EXISTS reservations(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id),
          active INTEGER NOT NULL, payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS reserved_paths(resource_key TEXT PRIMARY KEY, reservation_id TEXT NOT NULL REFERENCES reservations(id));
        CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL REFERENCES tasks(id),
          at INTEGER NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL);
        PRAGMA application_id=${APP_ID}; PRAGMA user_version=1;
      `);
                this.db.exec('COMMIT');
            }
            catch (error) {
                this.db.exec('ROLLBACK');
                throw error;
            }
        }
        catch (error) {
            this.db.close();
            throw error;
        }
    }
    close() { this.db.close(); }
    transaction(body) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = body();
            this.db.exec('COMMIT');
            return result;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    now() { return positive(this.clock(), '本地时间'); }
    one(table, key) {
        const row = this.db.prepare(`SELECT payload FROM ${table} WHERE id=?`).get(key);
        requireCondition(row, 'NOT_FOUND', `${table}记录不存在。`);
        return JSON.parse(String(row.payload));
    }
    getTask(taskId) { return this.one('tasks', id(taskId)); }
    listTasks() { return this.db.prepare('SELECT payload FROM tasks ORDER BY rowid').all().map(row => JSON.parse(String(row.payload))); }
    getCommand(commandId) { return this.one('commands', id(commandId)); }
    listCommands(taskId) {
        this.getTask(taskId);
        return this.db.prepare('SELECT payload FROM commands WHERE task_id=? ORDER BY rowid').all(taskId).map(row => JSON.parse(String(row.payload)));
    }
    listAttempts(taskId) { return this.listCommands(taskId).filter(command => command.executionId !== null); }
    getControlRequest(requestId) {
        const row = this.db.prepare('SELECT payload FROM control_requests WHERE id=?').get(id(requestId));
        requireCondition(row, 'CONTROL_NOT_FOUND', '暂停/取消请求不存在。');
        return JSON.parse(String(row.payload));
    }
    executionDirectory(commandId) {
        const command = this.getCommand(commandId);
        requireCondition(command.executionId !== null, 'EXECUTION_NOT_PREPARED', '执行尚未登记。');
        const packet = this.getPacket(command.taskId, command.packetVersion).packet;
        return resourcePath(checkedRoot(packet.workRoot), command.executionId, false);
    }
    getPacket(taskId, version) {
        const selected = version ?? this.getTask(taskId).packetVersion;
        const row = this.db.prepare('SELECT * FROM packets WHERE task_id=? AND version=?').get(id(taskId), positive(selected, '包版本'));
        requireCondition(row, 'PACKET_NOT_FOUND', '尚未提交该任务包版本。');
        const packet = validatePacket(JSON.parse(String(row.payload)));
        requireCondition(digest(packet) === row.sha256, 'PACKET_CORRUPT', '任务包指纹不匹配。');
        return { packet, sha256: String(row.sha256), committedAt: Number(row.committed_at) };
    }
    getResult(resultId) {
        const result = this.one('results', id(resultId)), { sha256, ...body } = result;
        requireCondition(digest(body) === sha256, 'RESULT_CORRUPT', '成果记录指纹不匹配。');
        return result;
    }
    verifyResult(resultId) {
        const result = this.getResult(resultId);
        if (result.output.files.length > 0)
            verifyResources(result.resourceRoot, result.output.files);
        return result;
    }
    listEvents(taskId) {
        this.getTask(taskId);
        return this.db.prepare('SELECT * FROM events WHERE task_id=? ORDER BY seq').all(taskId)
            .map(row => ({ seq: Number(row.seq), at: Number(row.at), kind: String(row.kind), data: JSON.parse(String(row.data)) }));
    }
    audit(taskId, kind, data) {
        this.db.prepare('INSERT INTO events(task_id,at,kind,data) VALUES(?,?,?,?)').run(taskId, this.now(), kind, canonical(data));
    }
    revision(task, expected) {
        requireCondition(task.revision === expected, 'STALE_REVISION', '任务已变化，请读取新版本再作决定。');
    }
    saveTask(task) {
        task.revision++;
        task.updatedAt = this.now();
        this.db.prepare('UPDATE tasks SET revision=?,payload=? WHERE id=?').run(task.revision, canonical(task), task.id);
        return task;
    }
    saveCommand(command) {
        command.updatedAt = this.now();
        this.db.prepare('UPDATE commands SET status=?,payload=? WHERE id=?').run(command.status, canonical(command), command.id);
        return command;
    }
    open(task) {
        requireCondition(task.control === 'open' && task.stage !== 'completed', 'TASK_NOT_OPEN', '任务当前不接收新执行。');
    }
    publishPacket(value, expectedRevision) {
        const packet = validatePacket(value);
        const sha = digest(packet);
        const committed = this.db.prepare('SELECT sha256 FROM packets WHERE task_id=? AND version=?').get(packet.taskId, packet.version);
        if (committed) {
            requireCondition(committed.sha256 === sha, 'PACKET_VERSION_CONFLICT', '已提交的包版本不能覆盖。');
            return this.getTask(packet.taskId);
        }
        requireCondition(packet.createdAt <= this.now(), 'FUTURE_PACKET', '任务包创建时间不能在未来。');
        requireCondition(packet.deadlineAt === null || this.now() < packet.deadlineAt, 'DEADLINE_REACHED', '过期任务包不能作为新执行提交。');
        // Hashing can be slow. Never hold the SQLite write transaction during file reads.
        verifyResources(packet.resourceRoot, packet.resources);
        checkedRoot(packet.workRoot);
        return this.transaction(() => {
            const existing = this.db.prepare('SELECT sha256 FROM packets WHERE task_id=? AND version=?').get(packet.taskId, packet.version);
            if (existing) {
                requireCondition(existing.sha256 === sha, 'PACKET_VERSION_CONFLICT', '已提交的包版本不能覆盖。');
                return this.getTask(packet.taskId);
            }
            requireCondition(packet.deadlineAt === null || this.now() < packet.deadlineAt, 'DEADLINE_REACHED', '任务包在提交前已到期。');
            const old = this.db.prepare('SELECT payload FROM tasks WHERE id=?').get(packet.taskId);
            let task;
            if (old) {
                task = JSON.parse(String(old.payload));
                this.open(task);
                requireCondition(expectedRevision !== null, 'REVISION_REQUIRED', '更新任务包需要任务版本。');
                this.revision(task, expectedRevision);
                const previous = this.getPacket(task.id).packet;
                requireCondition(packet.version === task.packetVersion + 1 && packet.requirementsVersion >= previous.requirementsVersion, 'INVALID_PACKET_VERSION', '新任务包版本必须递增，要求版本不能回退。');
                requireCondition(pathKey(packet.resourceRoot) === pathKey(previous.resourceRoot) && pathKey(packet.workRoot) === pathKey(previous.workRoot)
                    && packet.conversationId === previous.conversationId, 'TASK_IDENTITY_CHANGED', '更新同一任务不能暗中更换资料根目录或原会话。');
                task.packetVersion = packet.version;
                task.stage = task.mustFinishWithWork ? 'work_finishing' : 'ready';
                // Never-dispatched old commands are safe to supersede. In-flight ones remain tracked.
                for (const command of this.listCommands(task.id))
                    if (command.status === 'queued') {
                        command.status = 'superseded';
                        command.reason = 'Task packet updated before dispatch';
                        this.saveCommand(command);
                    }
                this.saveTask(task);
            }
            else {
                requireCondition(expectedRevision === null && packet.version === 1, 'INVALID_INITIAL_PACKET', '新任务必须从包版本1开始。');
                const now = this.now();
                task = { id: packet.taskId, revision: 1, packetVersion: 1, stage: 'ready', control: 'open', reworkCount: 0,
                    mustFinishWithWork: false, completedResultId: null, lastControlRequestId: null, createdAt: now, updatedAt: now };
                this.db.prepare('INSERT INTO tasks VALUES(?,?,?)').run(task.id, task.revision, canonical(task));
            }
            this.db.prepare('INSERT INTO packets VALUES(?,?,?,?,?)').run(task.id, packet.version, sha, this.now(), canonical(packet));
            this.audit(task.id, 'packet_committed', { version: packet.version, sha256: sha });
            return task;
        });
    }
    enqueue(taskId, expectedRevision, value) {
        const raw = record(value, ['idempotencyKey', 'packetVersion', 'side', 'kind', 'instructions'], '指令');
        const kind = raw.kind;
        requireCondition(kind === 'execute' || kind === 'review' || kind === 'rework' || kind === 'finish', 'INVALID_COMMAND', '指令类型不支持。');
        const request = { idempotencyKey: id(raw.idempotencyKey), packetVersion: positive(raw.packetVersion, '包版本'),
            side: side(raw.side), kind, instructions: text(raw.instructions, '指令内容') };
        const signature = digest(request);
        return this.transaction(() => {
            const previous = this.db.prepare('SELECT signature,payload FROM commands WHERE task_id=? AND idempotency_key=?').get(taskId, request.idempotencyKey);
            if (previous) {
                requireCondition(previous.signature === signature, 'IDEMPOTENCY_CONFLICT', '相同指令编号对应了不同内容。');
                return JSON.parse(String(previous.payload));
            }
            const task = this.getTask(taskId);
            this.revision(task, expectedRevision);
            this.open(task);
            requireCondition(request.packetVersion === task.packetVersion, 'STALE_PACKET', '指令引用了过期任务包。');
            const packet = this.getPacket(task.id).packet;
            requireCondition(packet.recipients.includes(request.side), 'RECIPIENT_NOT_ALLOWED', '任务包未授权该资料接收端。');
            requireCondition(packet.deadlineAt === null || this.now() < packet.deadlineAt, 'DEADLINE_REACHED', '本次任务窗口已到期。');
            requireCondition(kind !== 'review' || request.side === 'work', 'WORK_REVIEW_REQUIRED', '验收由原GPT侧执行。');
            requireCondition(kind !== 'finish' || request.side === 'work', 'WORK_FINISH_REQUIRED', '收尾由GPT执行。');
            if (kind === 'rework') {
                requireCondition(request.side === 'harness' && task.stage === 'rework_ready' && task.reworkCount === 1, 'REWORK_NOT_READY', '尚未批准这一次Harness返工。');
                requireCondition(!this.listCommands(task.id).some(command => command.kind === 'rework'
                    && (command.executionId !== null || !terminal(command.status))), 'REWORK_LIMIT', '这一次返工已有指令，不能重复派发。');
            }
            if (task.mustFinishWithWork && mutating(kind))
                requireCondition((kind === 'rework' && task.stage === 'rework_ready')
                    || (kind === 'finish' && request.side === 'work' && task.stage === 'work_finishing'), 'WORK_FINISH_REQUIRED', '返工后只能由GPT收尾。');
            requireCondition(!this.listCommands(task.id).some(command => command.side === request.side && command.status === 'unknown' && mutating(command.kind))
                || !mutating(kind), 'UNRESOLVED_EXECUTION', '该执行方有待核实执行，先对账再派发新写任务。');
            const now = this.now(), command = { ...request, id: randomUUID(), taskId, status: 'queued', executionId: null,
                workerId: null, receiptSequence: 0, resultId: null, reason: null, createdAt: now, updatedAt: now };
            this.db.prepare('INSERT INTO commands VALUES(?,?,?,?,?,?)').run(command.id, taskId, command.idempotencyKey, signature, command.status, canonical(command));
            this.saveTask(task);
            this.audit(taskId, 'command_queued', { commandId: command.id, kind, side: command.side });
            return command;
        });
    }
    claim(commandId, workerId) {
        id(workerId, '工人编号');
        const candidate = this.getCommand(commandId);
        if (candidate.status !== 'queued')
            return { command: candidate, claimed: false };
        const candidateTask = this.getTask(candidate.taskId);
        this.open(candidateTask);
        requireCondition(candidate.packetVersion === candidateTask.packetVersion, 'STALE_PACKET', '旧包指令不能开始。');
        const candidatePacket = this.getPacket(candidate.taskId, candidate.packetVersion).packet;
        requireCondition(candidatePacket.deadlineAt === null || this.now() < candidatePacket.deadlineAt, 'DEADLINE_REACHED', '本次任务窗口已到期。');
        verifyResources(candidatePacket.resourceRoot, candidatePacket.resources);
        checkedRoot(candidatePacket.workRoot);
        return this.transaction(() => {
            const command = this.getCommand(commandId);
            if (command.status !== 'queued')
                return { command, claimed: false };
            const task = this.getTask(command.taskId);
            this.open(task);
            requireCondition(command.packetVersion === task.packetVersion, 'STALE_PACKET', '旧包指令不能开始执行。');
            if (task.mustFinishWithWork && mutating(command.kind))
                requireCondition((command.kind === 'rework' && task.stage === 'rework_ready')
                    || (command.kind === 'finish' && command.side === 'work' && task.stage === 'work_finishing'), 'WORK_FINISH_REQUIRED', '任务决策已变化，该指令不能再开始。');
            requireCondition(!mutating(command.kind) || !this.listCommands(task.id).some(other => other.id !== command.id
                && other.side === command.side && other.status === 'unknown' && mutating(other.kind)), 'UNRESOLVED_EXECUTION', '同执行方有未知任务执行，先对账。');
            const packet = this.getPacket(task.id).packet;
            requireCondition(packet.deadlineAt === null || this.now() < packet.deadlineAt, 'DEADLINE_REACHED', '本次任务窗口已到期。');
            command.workerId = workerId;
            command.executionId = randomUUID();
            command.status = 'dispatching';
            this.saveCommand(command);
            if (task.stage === 'ready')
                task.stage = 'active';
            this.saveTask(task);
            this.audit(task.id, 'dispatch_prepared', { commandId, executionId: command.executionId, workerId });
            return { command, claimed: true };
        });
    }
    markSent(commandId, executionId) {
        return this.transaction(() => {
            const command = this.getCommand(commandId);
            requireCondition(command.executionId === executionId && command.executionId !== null, 'WRONG_EXECUTION', '执行编号不匹配。');
            requireCondition(command.status !== 'unknown', 'RECONCILIATION_REQUIRED', '发送结果未知，不能用已发送标记代替对账。');
            if (command.status === 'dispatching') {
                command.status = 'sent';
                this.saveCommand(command);
                this.saveTask(this.getTask(command.taskId));
                this.audit(command.taskId, 'command_sent', { commandId, executionId });
            }
            return command;
        });
    }
    receive(value) { return this.applyReceipt(value); }
    reconcile(value, evidence) { return this.applyReceipt(value, text(evidence, '对账依据')); }
    applyReceipt(value, reconciliation) {
        const row = record(value, ['eventId', 'commandId', 'executionId', 'workerId', 'sequence', 'status', 'output', 'reason', 'controlRequestId'], '回执');
        const eventId = id(row.eventId), commandId = id(row.commandId), executionId = id(row.executionId), workerId = id(row.workerId);
        const sequence = positive(row.sequence, '回执序号');
        requireCondition(statuses.includes(row.status), 'INVALID_RECEIPT', '回执状态不支持。');
        const status = row.status, signature = digest(row);
        const recorded = this.db.prepare('SELECT signature FROM receipts WHERE event_id=?').get(eventId);
        if (recorded) {
            requireCondition(recorded.signature === signature, 'RECEIPT_CONFLICT', '同一回执编号内容改变。');
            return this.getCommand(commandId);
        }
        const candidate = this.getCommand(commandId);
        requireCondition(candidate.executionId === executionId && candidate.workerId === workerId, 'WRONG_EXECUTION', '回执执行身份不匹配。');
        requireCondition(!terminal(candidate.status), 'TERMINAL_COMMAND', '指令已结算。');
        requireCondition(candidate.status !== 'unknown' || reconciliation !== undefined, 'RECONCILIATION_REQUIRED', '未知结果须明确对账。');
        requireCondition(sequence === candidate.receiptSequence + 1, 'RECEIPT_ORDER', '回执乱序或缺失。');
        const preparedOutput = status === 'succeeded' ? validateOutput(row.output, this.executionDirectory(commandId)) : undefined;
        return this.transaction(() => {
            const previous = this.db.prepare('SELECT signature FROM receipts WHERE event_id=?').get(eventId);
            if (previous) {
                requireCondition(previous.signature === signature, 'RECEIPT_CONFLICT', '同一回执编号内容改变。');
                return this.getCommand(commandId);
            }
            const command = this.getCommand(commandId);
            requireCondition(command.executionId === executionId && command.workerId === workerId, 'WRONG_EXECUTION', '回执不属于已登记的工人和执行。');
            if (row.controlRequestId !== undefined) {
                const control = this.getControlRequest(id(row.controlRequestId));
                requireCondition(control.taskId === command.taskId && control.executionIds.includes(executionId)
                    && (status === 'cancelled' || status === 'failed' || status === 'succeeded'), 'WRONG_CONTROL_REQUEST', '控制回执不属于该任务执行或尚未结算。');
            }
            requireCondition(!terminal(command.status), 'TERMINAL_COMMAND', '指令已结算，不能追加新的状态。');
            requireCondition(command.status !== 'unknown' || reconciliation !== undefined, 'RECONCILIATION_REQUIRED', '未知结果须明确对账，不能自动放行。');
            requireCondition(sequence === command.receiptSequence + 1, 'RECEIPT_ORDER', '回执缺失、重复序号或乱序，先补齐记录。');
            if (command.status !== 'unknown') {
                if (status === 'received')
                    requireCondition(command.status === 'dispatching' || command.status === 'sent', 'RECEIPT_ORDER', '不能回退到已接收。');
                if (status === 'running')
                    requireCondition(command.status === 'received', 'RECEIPT_ORDER', '开始工作前须有接收回执。');
                if (status === 'succeeded')
                    requireCondition(command.status === 'running', 'RECEIPT_ORDER', '不能把已发出或已接收当成完成。');
            }
            let output;
            if (status === 'succeeded')
                output = preparedOutput;
            else
                requireCondition(row.output === undefined, 'INVALID_RECEIPT', '只有成功回执可以提交成果。');
            if (status === 'failed' || status === 'cancelled')
                text(row.reason, '结算原因');
            else if (row.reason !== undefined)
                text(row.reason, '说明');
            const task = this.getTask(command.taskId);
            if (output) {
                const body = { id: randomUUID(), taskId: command.taskId, packetVersion: command.packetVersion, commandId,
                    side: command.side, kind: command.kind, resourceRoot: this.executionDirectory(commandId), output, createdAt: this.now() };
                const result = { ...body, sha256: digest(body) };
                command.resultId = result.id;
                this.db.prepare('INSERT INTO results VALUES(?,?,?)').run(result.id, task.id, canonical(result));
                if (task.packetVersion === command.packetVersion && task.stage !== 'completed' && mutating(command.kind)) {
                    if (!task.mustFinishWithWork || command.kind === 'finish')
                        task.stage = 'awaiting_review';
                    if (command.kind === 'rework')
                        task.stage = 'work_finishing';
                }
            }
            if ((status === 'failed' || status === 'cancelled') && command.kind === 'rework'
                && command.packetVersion === task.packetVersion)
                task.stage = 'work_finishing';
            command.status = status;
            command.receiptSequence = sequence;
            command.reason = row.reason === undefined ? null : String(row.reason);
            this.saveCommand(command);
            this.db.prepare('INSERT INTO receipts VALUES(?,?,?,?,?)').run(eventId, commandId, sequence, signature, canonical(row));
            this.settleControl(task);
            this.saveTask(task);
            this.audit(task.id, reconciliation ? 'execution_reconciled' : 'receipt_recorded', { commandId, eventId, sequence, status, evidence: reconciliation ?? null });
            return command;
        });
    }
    refreshObservedResult(commandId, value, evidence) {
        text(evidence, '真实续聊版本证据');
        const output = validateOutput(value, this.executionDirectory(commandId));
        return this.transaction(() => {
            const command = this.getCommand(commandId), task = this.getTask(command.taskId);
            this.open(task);
            requireCondition(command.side === 'harness' && command.status === 'succeeded' && command.packetVersion === task.packetVersion
                && (task.stage === 'awaiting_review' && !task.mustFinishWithWork || task.stage === 'work_finishing' && command.kind === 'rework'), 'CONTINUATION_NOT_ALLOWED', '只能在尚未完成的当前Harness执行或返工成果上登记真实续聊；不恢复已关闭任务。');
            requireCondition(!this.db.prepare('SELECT id FROM reservations WHERE task_id=? AND active=1').get(task.id), 'CONTINUATION_COMMIT_HELD', '先撤销未应用的旧提交准备，再取回新版本。');
            requireCondition(!this.listCommands(task.id).some(c => c.id !== command.id && (inFlight(c.status) || c.status === 'queued') && mutating(c.kind)), 'TASK_UNSETTLED', '任务有其他待执行指令，不能用续聊覆盖。');
            const body = { id: randomUUID(), taskId: command.taskId, packetVersion: command.packetVersion, commandId,
                side: command.side, kind: command.kind, resourceRoot: this.executionDirectory(commandId), output, createdAt: this.now() };
            const result = { ...body, sha256: digest(body) };
            this.db.prepare('INSERT INTO results VALUES(?,?,?)').run(result.id, task.id, canonical(result));
            command.resultId = result.id;
            this.saveCommand(command);
            this.saveTask(task);
            this.audit(task.id, 'user_continuation_observed', { commandId, resultId: result.id, evidence });
            return command;
        });
    }
    markWorkerLost(workerId, reason) {
        id(workerId);
        text(reason, '失联原因');
        return this.transaction(() => {
            const commands = this.db.prepare('SELECT payload FROM commands').all().map(row => JSON.parse(String(row.payload)))
                .filter(command => command.workerId === workerId && inFlight(command.status) && command.status !== 'unknown');
            for (const command of commands) {
                command.status = 'unknown';
                command.reason = reason;
                this.saveCommand(command);
                this.saveTask(this.getTask(command.taskId));
                this.audit(command.taskId, 'worker_lost', { commandId: command.id, workerId, reason });
            }
            return commands;
        });
    }
    settleControl(task) {
        const commands = this.listCommands(task.id);
        if (!commands.some(command => inFlight(command.status))) {
            if (task.control === 'pause_requested')
                task.control = 'paused';
            if (task.control === 'cancel_requested')
                task.control = 'cancelled';
        }
        const pending = this.db.prepare('SELECT payload FROM control_requests WHERE task_id=?').all(task.id)
            .map(row => JSON.parse(String(row.payload))).filter(request => request.status === 'requested');
        for (const request of pending)
            if (request.executionIds.every(executionId => commands.some(command => command.executionId === executionId && terminal(command.status)))) {
                request.status = 'settled';
                request.settledAt = this.now();
                this.db.prepare('UPDATE control_requests SET payload=? WHERE id=?').run(canonical(request), request.id);
            }
    }
    requestControl(taskId, expectedRevision, operation, idempotencyKey = randomUUID()) {
        requireCondition(operation === 'pause' || operation === 'cancel', 'INVALID_CONTROL', '只支持任务暂停或取消。');
        id(idempotencyKey);
        return this.transaction(() => {
            const old = this.db.prepare('SELECT payload FROM control_requests WHERE task_id=? AND idempotency_key=?').get(taskId, idempotencyKey);
            if (old) {
                requireCondition(JSON.parse(String(old.payload)).operation === operation, 'IDEMPOTENCY_CONFLICT', '同一个控制编号不能同时代表暂停和取消。');
                return this.getTask(taskId);
            }
            const task = this.getTask(taskId);
            this.revision(task, expectedRevision);
            requireCondition(task.stage !== 'completed' && task.control !== 'cancelled', 'TASK_TERMINAL', '任务已经结束。');
            requireCondition(task.control !== 'cancel_requested' && !(operation === 'pause' && task.control === 'pause_requested'), 'CONTROL_IN_PROGRESS', '相同控制仍在等待结算；请重用原请求编号或查询状态。');
            task.control = operation === 'pause' ? 'pause_requested' : 'cancel_requested';
            for (const command of this.listCommands(task.id))
                if (command.status === 'queued') {
                    command.status = 'cancelled';
                    command.reason = `Task ${operation} before dispatch`;
                    this.saveCommand(command);
                }
            const request = { id: randomUUID(), taskId, idempotencyKey, operation, status: 'requested',
                executionIds: this.listCommands(taskId).filter(command => inFlight(command.status)).map(command => command.executionId),
                createdAt: this.now(), settledAt: null };
            task.lastControlRequestId = request.id;
            this.db.prepare('INSERT INTO control_requests VALUES(?,?,?,?)').run(request.id, taskId, idempotencyKey, canonical(request));
            this.settleControl(task);
            this.saveTask(task);
            this.audit(task.id, operation + '_requested', { controlRequestId: request.id });
            return task;
        });
    }
    resume(taskId, expectedRevision) {
        return this.transaction(() => {
            const task = this.getTask(taskId);
            this.revision(task, expectedRevision);
            requireCondition(task.control === 'paused', 'NOT_PAUSED', '工人尚未结算或任务不是暂停状态。');
            task.control = 'open';
            this.saveTask(task);
            this.audit(task.id, 'task_resumed', {});
            return task;
        });
    }
    requestRework(taskId, expectedRevision, resultId, reason) {
        text(reason, '返工原因');
        this.verifyResult(resultId);
        return this.transaction(() => {
            const task = this.getTask(taskId);
            this.revision(task, expectedRevision);
            this.open(task);
            const result = this.getResult(resultId);
            requireCondition(result.taskId === taskId && result.packetVersion === task.packetVersion && result.kind !== 'review', 'WRONG_RESULT', '返工成果不匹配当前任务包。');
            requireCondition(task.reworkCount === 0 && task.stage === 'awaiting_review', 'REWORK_LIMIT', '只允许一次返工，之后GPT收尾。');
            requireCondition(!this.listCommands(taskId).some(command => inFlight(command.status) && mutating(command.kind)), 'TASK_UNSETTLED', '先结算本任务的执行，再决定返工；其他任务及普通聊天不受影响。');
            for (const command of this.listCommands(taskId))
                if (command.status === 'queued' && mutating(command.kind)) {
                    command.status = 'superseded';
                    command.reason = 'Rework decision replaced queued execution';
                    this.saveCommand(command);
                }
            task.reworkCount = 1;
            task.mustFinishWithWork = true;
            task.stage = 'rework_ready';
            this.saveTask(task);
            this.audit(task.id, 'rework_requested', { resultId, reason });
            return task;
        });
    }
    reserveCommit(taskId, expectedRevision, paths, reservationId = randomUUID()) {
        id(reservationId);
        requireCondition(paths.length > 0 && paths.length <= 256, 'INVALID_RESERVATION', '提交路径必须明确。');
        const names = paths.map(relativePath).sort();
        requireCondition(new Set(names.map(pathKey)).size === names.length, 'DUPLICATE_RESOURCE', '提交路径重复。');
        return this.transaction(() => {
            const old = this.db.prepare('SELECT active,payload FROM reservations WHERE id=?').get(reservationId);
            if (old) {
                const reservation = JSON.parse(String(old.payload));
                requireCondition(old.active === 1 && reservation.taskId === taskId && canonical(reservation.paths) === canonical(names), 'RESERVATION_CONFLICT', '提交许可已经释放或内容改变。');
                return this.checkCommit(taskId, reservationId);
            }
            const task = this.getTask(taskId);
            this.revision(task, expectedRevision);
            this.open(task);
            const packet = this.getPacket(taskId).packet;
            checkedRoot(packet.resourceRoot);
            const keys = names.map(name => pathKey(resourcePath(packet.resourceRoot, name, false)));
            requireCondition(keys.every(a => keys.every(b => a === b || !a.startsWith(b + path.sep))), 'PATH_COLLISION', '提交文件路径不能互为父目录。');
            const heldKeys = this.db.prepare('SELECT resource_key FROM reserved_paths').all().map(row => String(row.resource_key));
            requireCondition(keys.every(key => heldKeys.every(held => key !== held && !key.startsWith(held + path.sep) && !held.startsWith(key + path.sep))), 'RESOURCE_BUSY', '相关文件已有提交，其他文件及模型活动不受影响。');
            const reservation = { id: reservationId, taskId, packetVersion: task.packetVersion, paths: names };
            this.db.prepare('INSERT INTO reservations VALUES(?,?,1,?)').run(reservationId, taskId, canonical(reservation));
            for (const key of keys)
                this.db.prepare('INSERT INTO reserved_paths VALUES(?,?)').run(key, reservationId);
            this.saveTask(task);
            this.audit(task.id, 'commit_reserved', { reservationId, paths: names });
            return reservation;
        });
    }
    checkCommit(taskId, reservationId) {
        const row = this.db.prepare('SELECT active,payload FROM reservations WHERE id=?').get(id(reservationId));
        requireCondition(row && row.active === 1, 'RESERVATION_INACTIVE', '提交许可已释放或不存在。');
        const reservation = JSON.parse(String(row.payload));
        requireCondition(reservation.taskId === taskId, 'WRONG_RESERVATION', '提交许可属于其他任务。');
        const task = this.getTask(taskId);
        this.open(task);
        requireCondition(reservation.packetVersion === task.packetVersion, 'STALE_RESERVATION', '提交许可属于旧任务包，不能写回。');
        const packet = this.getPacket(taskId).packet;
        checkedRoot(packet.resourceRoot);
        for (const name of reservation.paths) {
            const key = pathKey(resourcePath(packet.resourceRoot, name, false));
            const held = this.db.prepare('SELECT reservation_id FROM reserved_paths WHERE resource_key=?').get(key);
            requireCondition(held?.reservation_id === reservation.id, 'RESERVATION_INACTIVE', '提交路径许可已改变。');
        }
        return reservation;
    }
    inspectCommit(reservationId) {
        const row = this.db.prepare('SELECT active,payload FROM reservations WHERE id=?').get(id(reservationId));
        return row ? { reservation: JSON.parse(String(row.payload)), active: row.active === 1 } : null;
    }
    releaseCommit(taskId, reservationId) {
        this.transaction(() => {
            const row = this.db.prepare('SELECT * FROM reservations WHERE id=?').get(id(reservationId));
            requireCondition(row && row.task_id === taskId, 'WRONG_RESERVATION', '不能释放其他任务的提交许可。');
            if (row.active === 0)
                return;
            this.db.prepare('DELETE FROM reserved_paths WHERE reservation_id=?').run(reservationId);
            this.db.prepare('UPDATE reservations SET active=0 WHERE id=?').run(reservationId);
            this.saveTask(this.getTask(taskId));
            this.audit(taskId, 'commit_released', { reservationId });
        });
    }
    complete(taskId, expectedRevision, resultId) {
        const candidate = this.verifyResult(resultId);
        requireCondition(candidate.taskId === taskId, 'WRONG_RESULT', '成果不属于该任务。');
        return this.transaction(() => {
            const task = this.getTask(taskId);
            this.revision(task, expectedRevision);
            this.open(task);
            const result = this.getResult(resultId);
            requireCondition(result.taskId === taskId && result.packetVersion === task.packetVersion && result.kind !== 'review', 'WRONG_RESULT', '完成成果不属于当前任务版本。');
            requireCondition(!task.mustFinishWithWork || (result.side === 'work' && result.kind === 'finish'), 'WORK_FINISH_REQUIRED', '返工后必须选择GPT收尾成果。');
            requireCondition(this.listCommands(taskId).every(command => terminal(command.status)), 'TASK_UNSETTLED', '本任务仍有排队或未结算指令，不能宣称全部完成。');
            requireCondition(!this.db.prepare('SELECT id FROM reservations WHERE task_id=? AND active=1').get(taskId), 'COMMIT_UNSETTLED', '本任务提交尚未结算。');
            task.stage = 'completed';
            task.completedResultId = resultId;
            this.saveTask(task);
            this.audit(taskId, 'task_completed', { resultId });
            return task;
        });
    }
}
//# sourceMappingURL=ledger.js.map