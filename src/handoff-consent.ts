import { randomUUID } from 'node:crypto';
import { id, text, requireCondition } from './contracts.js';
import { digest } from './packet.js';
import type { QuotaDecision } from './quota.js';
import type { ToolStore } from './tool-store.js';

export const HANDOFF_QUESTION_MS = 30_000;
export interface HandoffConsentRecord {
  taskId: string; conversationId: string; requestId: string; title: string; recoveryAt: number;
  createdAt: number; deadlineAt: number; settledAt: number | null;
  phase: 'waiting' | 'approved' | 'declined' | 'unavailable' | 'interrupted';
  reason: string;
  confirmationVersion?: 2;
  displayedAt?: number; visibleMs?: number; transport?: 'windows-desktop';
}
export type HandoffAnswer = 'handoff' | 'decline' | 'timeout' | 'cancelled' | 'unavailable';
export type HandoffPromptResult = HandoffAnswer | { answer: HandoffAnswer; displayedAt: number; visibleMs: number; transport: 'windows-desktop' };
export type HandoffPrompt = (offer: HandoffConsentRecord, signal?: AbortSignal) => Promise<HandoffPromptResult>;
export class HandoffConsent {
  constructor(private readonly store: ToolStore, private readonly quota: () => QuotaDecision, private readonly now = Date.now) {}
  private key(taskId: string, conversationId: string): string { return digest({ taskId, conversationId }); }
  current(taskId: string, conversationId: string): HandoffConsentRecord | null {
    const record = this.store.get<HandoffConsentRecord>('handoff-consent', this.key(taskId, conversationId));
    const recovery = this.store.get<{ at: number }>('consent-recovery', 'codex')?.at ?? 0;
    return record && record.recoveryAt === recovery ? record : null;
  }
  status(taskId: string, conversationId: string) {
    const quota = this.quota(), record = this.current(taskId, conversationId);
    const required = quota.state === 'ready' && !quota.allowWork && quota.allowHandoff;
    const allowed = quota.state === 'ready' && quota.allowHandoff && (quota.allowWork || record?.phase === 'approved');
    return { required, allowed, record, nextAction: quota.state !== 'ready' ? 'refresh-native-quota'
      : allowed ? 'continue-authorized-handoff' : record?.phase === 'declined' ? 'handoff-declined'
        : record?.phase === 'waiting' ? 'await-existing-question' : required ? 'ask-handoff-confirmation' : 'preserve-progress-and-wait' };
  }
  assertAllowed(taskId: string, conversationId: string): void {
    const status = this.status(taskId, conversationId);
    // Unknown quota never turns a prior refusal or unresolved question into permission.
    if (status.required || status.record) requireCondition(status.allowed, 'HANDOFF_CONFIRMATION_REQUIRED',
      '先调用handoff_confirm；用户拒绝、问题待答或询问故障时不能打包、创建聊天或派发。');
  }
  async confirm(task: { taskId: string; conversationId: string; title: string; reconsider?: boolean }, prompt?: HandoffPrompt, signal?: AbortSignal) {
    const taskId = id(task.taskId), conversationId = id(task.conversationId), title = text(task.title, '转交任务标题', 200);
    const before = this.status(taskId, conversationId);
    if (!before.required) return before;
    const proposed: HandoffConsentRecord = { taskId, conversationId, title, requestId: randomUUID(),
      recoveryAt: this.store.get<{ at: number }>('consent-recovery', 'codex')?.at ?? 0,
      createdAt: this.now(), deadlineAt: this.now() + HANDOFF_QUESTION_MS, settledAt: null, phase: 'waiting', reason: 'question-pending', confirmationVersion: 2 };
    const key = this.key(taskId, conversationId);
    const owned = this.store.updateConsent(key, previous => previous && !(previous.confirmationVersion === undefined && previous.reason === 'user-declined-or-cancelled') && previous.recoveryAt === proposed.recoveryAt
      && (!task.reconsider || previous.phase === 'waiting' || previous.phase === 'approved') ? previous : proposed);
    if (owned.requestId !== proposed.requestId) return this.status(taskId, conversationId);
    let result: HandoffPromptResult;
    try { result = signal?.aborted ? 'cancelled' : prompt ? await prompt(owned, signal) : 'unavailable'; }
    catch { result = 'unavailable'; }
    const answer = typeof result === 'string' ? result : result.answer;
    this.store.updateConsent(key, previous => {
      if (!previous || previous.requestId !== owned.requestId || previous.phase !== 'waiting') return previous ?? owned;
      const interrupted = signal?.aborted;
      const automatic = answer === 'timeout' && this.now() >= owned.deadlineAt;
      const phase = interrupted ? 'interrupted' : answer === 'handoff' || automatic ? 'approved'
        : answer === 'decline' || answer === 'cancelled' ? 'declined' : 'unavailable';
      return { ...previous, ...(typeof result === 'string' ? {} : {displayedAt:result.displayedAt,visibleMs:result.visibleMs,transport:result.transport}), phase, settledAt: this.now(), reason: interrupted ? 'origin-interrupted'
        : automatic ? 'unanswered-30s-default-handoff' : answer === 'handoff' ? 'user-selected-handoff'
          : phase === 'declined' ? 'user-declined-or-cancelled' : 'question-unavailable-no-default' };
    });
    return this.status(taskId, conversationId);
  }
}
