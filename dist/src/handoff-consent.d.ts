import type { QuotaDecision } from './quota.js';
import type { ToolStore } from './tool-store.js';
export declare const HANDOFF_QUESTION_MS = 30000;
export interface HandoffConsentRecord {
    taskId: string;
    conversationId: string;
    requestId: string;
    title: string;
    recoveryAt: number;
    createdAt: number;
    deadlineAt: number;
    settledAt: number | null;
    phase: 'waiting' | 'approved' | 'declined' | 'unavailable' | 'interrupted';
    reason: string;
    confirmationVersion?: 2;
    displayedAt?: number;
    visibleMs?: number;
    transport?: 'windows-desktop';
}
export type HandoffAnswer = 'handoff' | 'decline' | 'timeout' | 'cancelled' | 'unavailable';
export type HandoffPromptResult = HandoffAnswer | {
    answer: HandoffAnswer;
    displayedAt: number;
    visibleMs: number;
    transport: 'windows-desktop';
};
export type HandoffPrompt = (offer: HandoffConsentRecord, signal?: AbortSignal) => Promise<HandoffPromptResult>;
export declare class HandoffConsent {
    private readonly store;
    private readonly quota;
    private readonly now;
    constructor(store: ToolStore, quota: () => QuotaDecision, now?: () => number);
    private key;
    current(taskId: string, conversationId: string): HandoffConsentRecord | null;
    status(taskId: string, conversationId: string): {
        required: boolean;
        allowed: boolean;
        record: HandoffConsentRecord | null;
        nextAction: string;
    };
    assertAllowed(taskId: string, conversationId: string): void;
    confirm(task: {
        taskId: string;
        conversationId: string;
        title: string;
        reconsider?: boolean;
    }, prompt?: HandoffPrompt, signal?: AbortSignal): Promise<{
        required: boolean;
        allowed: boolean;
        record: HandoffConsentRecord | null;
        nextAction: string;
    }>;
}
