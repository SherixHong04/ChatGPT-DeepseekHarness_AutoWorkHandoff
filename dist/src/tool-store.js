import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { canonical, requireCondition } from './contracts.js';
import { checkedRoot, digest, pathKey } from './packet.js';
const APP = 0x57485434;
export class ToolStore {
    db;
    constructor(filename) {
        checkedRoot(path.dirname(filename));
        if (existsSync(filename))
            requireCondition(lstatSync(filename).isFile() && !lstatSync(filename).isSymbolicLink(), 'LINKED_DATABASE', '工具记录不能指向链接。');
        this.db = new DatabaseSync(filename, { allowExtension: false });
        try {
            this.db.exec('PRAGMA busy_timeout=5000');
            const app = Number(this.db.prepare('PRAGMA application_id').get()?.application_id);
            const version = Number(this.db.prepare('PRAGMA user_version').get()?.user_version);
            const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
            requireCondition((app === 0 && version === 0 && tables.length === 0) || (app === APP && version === 1), 'UNSUPPORTED_TOOL_DATABASE', '工具账本格式不支持，拒绝覆盖。');
            this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
        CREATE TABLE IF NOT EXISTS records(kind TEXT NOT NULL, name TEXT NOT NULL, signature TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(kind,name));
        PRAGMA application_id=${APP}; PRAGMA user_version=1;`);
        }
        catch (error) {
            this.db.close();
            throw error;
        }
    }
    close() { this.db.close(); }
    get(kind, name) {
        const row = this.db.prepare('SELECT signature,payload FROM records WHERE kind=? AND name=?').get(kind, name);
        if (!row)
            return null;
        const data = JSON.parse(String(row.payload));
        requireCondition(digest(data) === row.signature, 'TOOL_RECORD_CORRUPT', '工具记录指纹不一致。');
        return data;
    }
    save(kind, name, value) {
        this.db.prepare('INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(kind,name) DO UPDATE SET signature=excluded.signature,payload=excluded.payload')
            .run(kind, name, digest(value), canonical(value));
    }
    quota() { return this.get('quota', 'codex'); }
    noteConsentRecovery(at) {
        const previous = this.get('consent-recovery', 'codex');
        if (!previous || previous.at < at)
            this.save('consent-recovery', 'codex', { at });
    }
    updateConsent(key, update) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const next = update(this.get('handoff-consent', key));
            const previous = this.get('handoff-consent', key);
            if (previous && previous.requestId !== next.requestId)
                this.save('consent-history', previous.requestId, previous);
            this.save('handoff-consent', key, next);
            this.db.exec('COMMIT');
            return next;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    saveContext(taskId, value) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const previous = this.get('task-context', taskId);
            requireCondition(!previous || previous.conversationId === value.conversationId, 'WRONG_CONVERSATION', '该任务资料已由另一原对话登记。');
            requireCondition(!previous || pathKey(previous.resourceRoot) === pathKey(value.resourceRoot), 'CONTEXT_ROOT_CHANGED', '任务目录已登记，不能被并发请求改绑。');
            this.save('task-context', taskId, value);
            this.db.exec('COMMIT');
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    reserveManaged(value) {
        return Number(this.db.prepare('INSERT OR IGNORE INTO records VALUES(?,?,?,?)').run('managed', value.commandId, digest(value), canonical(value)).changes) === 1;
    }
    saveManaged(value) { this.save('managed', value.commandId, value); }
    approve(resultId, value) { this.save('review', resultId, value); }
    planChat(binding) {
        this.db.prepare('INSERT OR IGNORE INTO records VALUES(?,?,?,?)').run('chat', binding.taskId, digest(binding), canonical(binding));
        const actual = this.get('chat', binding.taskId);
        requireCondition(actual.sessionId === binding.sessionId && actual.conversationId === binding.conversationId
            && actual.workspaceRoot === binding.workspaceRoot, 'CHAT_IDENTITY_MISMATCH', '新聊天的原对话、任务和工作区已绑定。');
        return actual;
    }
    updateChat(binding) {
        const actual = this.get('chat', binding.taskId);
        requireCondition(actual && actual.sessionId === binding.sessionId && actual.conversationId === binding.conversationId
            && actual.workspaceRoot === binding.workspaceRoot, 'CHAT_IDENTITY_MISMATCH', '只能更新原先登记的新聊天。');
        this.save('chat', binding.taskId, binding);
    }
    updateHook(conversationId, update, observation) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const previous = this.get('quota-hook', conversationId), next = update(previous);
            requireCondition(next.conversationId === conversationId, 'WRONG_CONVERSATION', '额度检查不能改变原会话。');
            this.save('quota-hook', conversationId, next);
            this.save('quota-ticket', next.checkId, next);
            if (observation && (!this.quota() || this.quota().observedAt <= observation.observedAt))
                this.save('quota', 'codex', observation);
            this.db.exec('COMMIT');
            return next;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    saveQuota(value) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const previous = this.quota();
            requireCondition(!previous || previous.observedAt <= value.observedAt, 'STALE_QUOTA_UPDATE', '较旧观测不能覆盖新额度。');
            this.save('quota', 'codex', value);
            this.db.exec('COMMIT');
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    reserve(job) {
        const inserted = this.db.prepare('INSERT OR IGNORE INTO records VALUES(?,?,?,?)').run('job', job.commandId, digest(job), canonical(job)).changes;
        const actual = this.get('job', job.commandId);
        requireCondition(canonical(actual.plan) === canonical(job.plan), 'JOB_PLAN_CONFLICT', '已登记执行计划，不能在重复调用中更换。');
        return { created: Number(inserted) === 1, job: actual };
    }
    update(commandId, token, update) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const job = this.get('job', commandId);
            requireCondition(job && job.token === token, 'JOB_IDENTITY_MISMATCH', '后台执行归属不一致。');
            const updated = update(job);
            this.save('job', commandId, updated);
            this.db.exec('COMMIT');
            return updated;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
}
//# sourceMappingURL=tool-store.js.map