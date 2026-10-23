import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { id, positive, requireCondition, text } from './contracts.js';
import { assessQuota, defaultQuotaPolicy, observeQuota, quotaPolicy } from './quota.js';
import { NativeRpcError } from './native-control.js';
const APP = 0x57485731;
const terminal = new Set(['completed', 'failed', 'unknown', 'cancelled']);
export function safeWakePath(filename) {
    const absolute = path.resolve(filename);
    let current = path.parse(absolute).root;
    for (const part of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
        current = path.join(current, part);
        if (fs.existsSync(current))
            requireCondition(!fs.lstatSync(current).isSymbolicLink(), 'LINKED_WAKE_PATH', '计时状态路径不能为链接。');
    }
    return absolute;
}
export class WakeStore {
    directory;
    db;
    constructor(directory) {
        this.directory = directory;
        safeWakePath(directory);
        fs.mkdirSync(directory, { recursive: true });
        const filename = safeWakePath(path.join(directory, 'wake.sqlite'));
        this.db = new DatabaseSync(filename, { allowExtension: false });
        const app = Number(this.db.prepare('PRAGMA application_id').get()?.application_id);
        const tables = this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
        if (!((app === 0 && tables.length === 0) || app === APP)) {
            this.db.close();
            throw new Error('UNSUPPORTED_WAKE_DATABASE');
        }
        this.db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS wake_jobs(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS wake_events(seq INTEGER PRIMARY KEY, job_id TEXT NOT NULL, at INTEGER NOT NULL, payload TEXT NOT NULL);
      PRAGMA application_id=${APP}; PRAGMA user_version=1;`);
    }
    close() { this.db.close(); }
    get(jobId) {
        const row = this.db.prepare('SELECT payload FROM wake_jobs WHERE id=?').get(id(jobId));
        requireCondition(row, 'WAKE_NOT_FOUND', '本机没有此计时任务。');
        return JSON.parse(String(row.payload));
    }
    list() { return this.db.prepare('SELECT payload FROM wake_jobs').all().map(r => JSON.parse(String(r.payload))); }
    events(jobId) { this.get(jobId); return this.db.prepare('SELECT at,payload FROM wake_events WHERE job_id=? ORDER BY seq').all(jobId).map(r => ({ at: r.at, ...JSON.parse(String(r.payload)) })); }
    save(job) { this.db.prepare('UPDATE wake_jobs SET payload=? WHERE id=?').run(JSON.stringify(job), job.id); }
    event(jobId, at, value) { this.db.prepare('INSERT INTO wake_events(job_id,at,payload) VALUES(?,?,?)').run(jobId, at, JSON.stringify(value)); }
    schedule(input, now = Date.now()) {
        positive(input.dueAt, '现实到期时间');
        const job = { schemaVersion: 1, id: randomUUID(), conversationId: id(input.conversationId), taskId: id(input.taskId), requestId: randomUUID(),
            message: text(input.message, '唤醒指令', 16_384), createdAt: now, dueAt: input.dueAt, nextCheckAt: input.dueAt, phase: 'pending', checks: 0,
            reason: 'scheduled', lastCheckedAt: null, submissionId: null, turnId: null, baselineTurnId: null, evidence: null, policy: quotaPolicy(input.policy ?? defaultQuotaPolicy),
            ...(input.queueProbe ? { queueProbe: true } : {}) };
        if (input.scheduleKey !== undefined)
            job.scheduleKey = id(input.scheduleKey, '计时幂等键');
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const previous = this.list().find(j => j.conversationId === job.conversationId && j.taskId === job.taskId
                && (job.scheduleKey ? j.scheduleKey === job.scheduleKey : !terminal.has(j.phase)));
            if (previous) {
                requireCondition(previous.message === job.message && JSON.stringify(previous.policy) === JSON.stringify(job.policy)
                    && (!job.scheduleKey || previous.dueAt === job.dueAt), 'WAKE_SCHEDULE_CONFLICT', '同一计时任务已有不同内容或到期时间，保留原任务。');
                this.db.exec('COMMIT');
                return previous;
            }
            this.db.prepare('INSERT INTO wake_jobs VALUES(?,?)').run(job.id, JSON.stringify(job));
            this.event(job.id, now, { event: 'scheduled', dueAt: job.dueAt });
            this.db.exec('COMMIT');
            return job;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    update(jobId, patch, now = Date.now()) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const previous = this.get(jobId);
            // A delayed poll/send response must never erase an acknowledgement or a terminal outcome.
            // Unknown delivery may only advance through an explicit original-chat acknowledgement.
            if (terminal.has(previous.phase) && !(previous.phase === 'unknown' && ['started', 'completed'].includes(patch.phase ?? '')
                && ['original-chat-started', 'original-chat-confirmed'].includes(patch.reason ?? ''))
                || previous.phase === 'started' && !['started', 'completed'].includes(patch.phase ?? '')) {
                this.db.exec('COMMIT');
                return previous;
            }
            const next = { ...previous, ...patch };
            this.save(next);
            this.event(jobId, now, { event: next.phase, reason: next.reason, checks: next.checks, evidence: next.evidence });
            this.db.exec('COMMIT');
            return next;
        }
        catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
    }
    cancel(jobId, now = Date.now()) {
        const old = this.get(jobId);
        requireCondition(!['dispatching', 'queued', 'started', 'unknown'].includes(old.phase), 'WAKE_ALREADY_SENT', '消息可能已发送，只能对账，不能假称已撤回。');
        return this.update(jobId, { phase: 'cancelled', reason: 'user-cancelled' }, now);
    }
    claimDispatch(job, patch, now) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const actual = this.get(job.id);
            if (!['pending', 'quota-wait', 'busy', 'host-unavailable'].includes(actual.phase) || actual.checks !== job.checks) {
                this.db.exec('COMMIT');
                return null;
            }
            const next = { ...actual, ...patch, phase: 'dispatching' };
            this.save(next);
            this.event(job.id, now, { event: 'dispatching', reason: next.reason, evidence: next.evidence });
            this.db.exec('COMMIT');
            return next;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
}
export function wakeMessage(job, stateDirectory) {
    const entry = fileURLToPath(new URL('../../scripts/wake.mjs', import.meta.url));
    return `[Work Handoff local wake ${job.requestId}]\n本地程序按现实时间到期，已重新检查真实额度与原对话状态。仅接续任务 ${job.taskId}，原对话 ${job.conversationId}。\n${job.message}\n若你在原对话实际读到此消息，请执行node的本工程回执命令，参数定位资料：${JSON.stringify({ entry, args: ['ack', '--state', stateDirectory, '--id', job.id, '--request', job.requestId, '--thread', job.conversationId, '--phase', 'completed'] })}。回执只表示此消息真实接回，不表示Harness任务验收成功；用户取消、未知状态和原有权限边界优先。`;
}
export function wakeDue(job, now) {
    return !terminal.has(job.phase) && now >= job.dueAt && now >= job.nextCheckAt;
}
/** Match native user-item identity AND exact content. Quoted/manual copies are not delivery evidence. */
export async function findWakeReceipt(port, job, directory) {
    let cursor;
    for (let page = 0; page < 3; page++) {
        // Summary includes the initiating user item and clientId without tool or reasoning bodies.
        const result = await port.request('thread/turns/list', { threadId: job.conversationId, limit: 20, itemsView: 'summary', ...(cursor ? { cursor } : {}) });
        for (const turn of result.data ?? []) {
            for (const item of turn.items ?? []) {
                if (item.type !== 'userMessage' || item.clientId !== job.requestId || !Array.isArray(item.content))
                    continue;
                if (item.content.length === 1 && item.content[0]?.type === 'text' && item.content[0].text === wakeMessage(job, directory))
                    return { turnId: turn.id, messageId: item.id };
            }
            if (turn.id === job.baselineTurnId)
                return null;
        }
        if (!result.nextCursor)
            return null;
        cursor = result.nextCursor;
    }
    return null;
}
/** Wall clock, never elapsed tick counts. A delayed callback after sleep runs this same admission path. */
export async function checkWake(store, jobId, port, clock = Date.now) {
    let job = store.get(jobId);
    if (!wakeDue(job, clock()))
        return job;
    const update = (patch) => store.update(jobId, patch, clock());
    const defer = (phase, reason, evidence = null, next = clock() + 120_000) => update({ phase, reason, evidence, checks: job.checks + 1, lastCheckedAt: clock(), nextCheckAt: next });
    try {
        if (['dispatching', 'queued', 'started'].includes(job.phase)) {
            // Never re-add an uncertain message. Inspect our durable request id only.
            const list = await port.request('thread/queue/list', { threadId: job.conversationId, limit: 100 });
            const found = list.data?.find((r) => r.clientUserMessageId === job.requestId);
            if (found)
                return defer(job.phase === 'started' ? 'started' : 'queued', 'native-queue-accepted', { submissionId: found.id });
            const receipt = await findWakeReceipt(port, job, store.directory);
            if (receipt)
                return update({ phase: 'started', reason: 'native-user-message-observed', turnId: receipt.turnId,
                    evidence: { receipt }, checks: job.checks + 1, lastCheckedAt: clock(), nextCheckAt: clock() + 120_000 });
            return defer(job.phase === 'dispatching' ? 'unknown' : job.phase, 'receipt-needs-reconciliation');
        }
        const raw = await port.request('account/rateLimits/read');
        const observedAt = clock();
        const observation = { ...observeQuota(raw, observedAt, observedAt), source: 'codex-app-server-read' };
        const decision = assessQuota(observation, job.policy, clock());
        const evidence = { source: observation.source, observedAt, short: observation.short, long: observation.long,
            ordinaryUsageAllowed: observation.ordinaryUsageAllowed, spendControlReached: observation.spendControlReached, remaining: decision.remaining };
        if (!decision.allowResume)
            return defer('quota-wait', decision.state === 'ready' ? 'resume-reserve-not-met' : decision.state, evidence, decision.recheckAt > clock() ? decision.recheckAt + 5000 : clock() + 120_000);
        const state = await port.request('thread/read', { threadId: job.conversationId });
        requireCondition(state.thread?.id === job.conversationId, 'WRONG_WAKE_THREAD', '原对话编号不匹配。');
        evidence.threadStatus = state.thread.status;
        // A different runtime may own the Desktop chat. notLoaded is never called idle:
        // persist one normal native queue entry for the owner; do not resume or start it here.
        const ownerQueue = state.thread.status?.type === 'notLoaded';
        if (ownerQueue)
            evidence.deliveryMode = 'persist-to-native-owner-queue';
        if (state.thread.status?.type === 'active')
            return defer('busy', 'origin-active', evidence);
        if (state.thread.status?.type !== 'idle' && !ownerQueue)
            return defer('host-unavailable', 'origin-status-unknown', evidence);
        const tail = await port.request('thread/turns/list', { threadId: job.conversationId, limit: 1, itemsView: 'notLoaded' });
        const last = tail.data?.[0];
        evidence.latestTurn = last ? { id: last.id, status: last.status } : null;
        if (last?.status === 'inProgress')
            return defer('busy', 'latest-turn-in-progress', evidence);
        // Last moment check. A turn that races this check is queued normally; never steer or interrupt it.
        const current = await port.request('thread/read', { threadId: job.conversationId });
        if (current.thread?.id !== job.conversationId || (current.thread.status?.type !== 'idle' && !(ownerQueue && current.thread.status?.type === 'notLoaded')))
            return defer('busy', 'origin-changed-before-send', evidence);
        if (clock() - observedAt > job.policy.staleAfterMs || [observation.short, observation.long].some(w => w && clock() >= w.resetsAt))
            return defer('quota-wait', 'quota-expired-before-send', evidence);
        const claimed = store.claimDispatch(job, { reason: 'persisted-before-native-send', baselineTurnId: last?.id ?? null, evidence, checks: job.checks + 1, lastCheckedAt: clock() }, clock());
        if (!claimed)
            return store.get(jobId);
        job = claimed;
        try {
            const sent = await port.request('thread/queue/add', { threadId: job.conversationId, input: [{ type: 'text', text: wakeMessage(job, store.directory), text_elements: [] }], clientUserMessageId: job.requestId });
            requireCondition(sent.queuedSubmission?.clientUserMessageId === job.requestId && typeof sent.queuedSubmission?.id === 'string', 'WAKE_RECEIPT_MISMATCH', '原生回执不匹配。');
            return update({ phase: 'queued', submissionId: sent.queuedSubmission.id, queuedAt: clock(), reason: 'native-queue-accepted', nextCheckAt: clock() + 120_000 });
        }
        catch (error) {
            return update({ phase: error instanceof NativeRpcError ? 'failed' : 'unknown', reason: error instanceof NativeRpcError ? 'native-queue-rejected' : 'native-send-uncertain' });
        }
    }
    catch {
        return defer(job.phase === 'dispatching' ? 'unknown'
            : ['queued', 'started'].includes(job.phase) ? job.phase : 'host-unavailable', 'native-check-unavailable');
    }
}
export function acknowledgeWake(store, jobId, requestId, conversationId, phase, now = Date.now()) {
    const job = store.get(jobId);
    if (job.requestId === requestId && job.conversationId === conversationId && (job.phase === 'completed' || job.phase === phase))
        return job;
    requireCondition(job.requestId === requestId && job.conversationId === conversationId && ['queued', 'started', 'unknown', 'dispatching'].includes(job.phase), 'WAKE_ACK_MISMATCH', '回执必须属于已发送的原对话请求。');
    return store.update(jobId, { phase, reason: phase === 'completed' ? 'original-chat-confirmed' : 'original-chat-started', nextCheckAt: now + 120_000 }, now);
}
//# sourceMappingURL=local-wake.js.map