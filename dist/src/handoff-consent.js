import { randomUUID } from 'node:crypto';
import { id, text, requireCondition } from './contracts.js';
import { digest } from './packet.js';
export const HANDOFF_QUESTION_MS = 30_000;
export class HandoffConsent {
    store;
    quota;
    now;
    constructor(store, quota, now = Date.now) {
        this.store = store;
        this.quota = quota;
        this.now = now;
    }
    key(taskId, conversationId) { return digest({ taskId, conversationId }); }
    current(taskId, conversationId) {
        const record = this.store.get('handoff-consent', this.key(taskId, conversationId));
        const recovery = this.store.get('consent-recovery', 'codex')?.at ?? 0;
        return record && record.recoveryAt === recovery ? record : null;
    }
    status(taskId, conversationId) {
        const quota = this.quota(), record = this.current(taskId, conversationId);
        const required = quota.state === 'ready' && !quota.allowWork && quota.allowHandoff;
        const allowed = quota.state === 'ready' && quota.allowHandoff && (quota.allowWork || record?.phase === 'approved');
        return { required, allowed, record, nextAction: quota.state !== 'ready' ? 'refresh-native-quota'
                : allowed ? 'continue-authorized-handoff' : record?.phase === 'declined' ? 'handoff-declined'
                    : record?.phase === 'waiting' ? 'await-existing-question' : required ? 'ask-handoff-confirmation' : 'preserve-progress-and-wait' };
    }
    assertAllowed(taskId, conversationId) {
        const status = this.status(taskId, conversationId);
        // Unknown quota never turns a prior refusal or unresolved question into permission.
        if (status.required || status.record)
            requireCondition(status.allowed, 'HANDOFF_CONFIRMATION_REQUIRED', '先调用handoff_confirm；用户拒绝、问题待答或询问故障时不能打包、创建聊天或派发。');
    }
    async confirm(task, prompt, signal) {
        const taskId = id(task.taskId), conversationId = id(task.conversationId), title = text(task.title, '转交任务标题', 200);
        const before = this.status(taskId, conversationId);
        if (!before.required)
            return before;
        const proposed = { taskId, conversationId, title, requestId: randomUUID(),
            recoveryAt: this.store.get('consent-recovery', 'codex')?.at ?? 0,
            createdAt: this.now(), deadlineAt: this.now() + HANDOFF_QUESTION_MS, settledAt: null, phase: 'waiting', reason: 'question-pending' };
        const key = this.key(taskId, conversationId);
        const owned = this.store.updateConsent(key, previous => previous && previous.recoveryAt === proposed.recoveryAt
            && (!task.reconsider || previous.phase === 'waiting' || previous.phase === 'approved') ? previous : proposed);
        if (owned.requestId !== proposed.requestId)
            return this.status(taskId, conversationId);
        let answer;
        try {
            answer = signal?.aborted ? 'cancelled' : prompt ? await prompt(owned, signal) : 'unavailable';
        }
        catch {
            answer = 'unavailable';
        }
        this.store.updateConsent(key, previous => {
            if (!previous || previous.requestId !== owned.requestId || previous.phase !== 'waiting')
                return previous ?? owned;
            const interrupted = signal?.aborted;
            const automatic = answer === 'timeout' && this.now() >= owned.deadlineAt;
            const phase = interrupted ? 'interrupted' : answer === 'handoff' || automatic ? 'approved'
                : answer === 'decline' || answer === 'cancelled' ? 'declined' : 'unavailable';
            return { ...previous, phase, settledAt: this.now(), reason: interrupted ? 'origin-interrupted'
                    : automatic ? 'unanswered-30s-default-handoff' : answer === 'handoff' ? 'user-selected-handoff'
                        : phase === 'declined' ? 'user-declined-or-cancelled' : 'question-unavailable-no-default' };
        });
        return this.status(taskId, conversationId);
    }
}
//# sourceMappingURL=handoff-consent.js.map