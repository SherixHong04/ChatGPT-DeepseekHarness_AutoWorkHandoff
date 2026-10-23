import type { QuotaObservation, QuotaPolicy } from './quota.js';
import type { ToolStore } from './tool-store.js';
export interface QuotaHookPolicy {
    checkIntervalMs: number;
    ticketTtlMs: number;
    scope?: 'registered-projects' | 'all-conversations';
}
export declare const defaultQuotaHookPolicy: QuotaHookPolicy;
export declare function quotaHookPolicy(value: unknown): QuotaHookPolicy;
export interface QuotaCheck {
    schemaVersion: 1;
    checkId: string;
    conversationId: string;
    cwd: string;
    event: string;
    createdAt: number;
    lastPromptAt: number;
    phase: 'pending' | 'recorded' | 'expired';
    observation: QuotaObservation | null;
    receivedAt: number | null;
    nativeToolUseId: string | null;
    evidence: 'awaiting-native-tool' | 'hook-post-tool' | 'model-ack';
}
/** Hooks only request a native query in the current chat. They never fabricate balance or start a model. */
export declare class QuotaHookBridge {
    private readonly store;
    private readonly roots;
    private readonly policy;
    private readonly quotaPolicy;
    private readonly clock;
    constructor(store: ToolStore, roots: string[], policy: QuotaHookPolicy, quotaPolicy: QuotaPolicy, clock?: () => number);
    event(input: {
        conversationId: unknown;
        cwd: unknown;
        event: unknown;
        toolName?: unknown;
    }): unknown;
    record(input: {
        conversationId: unknown;
        usage: unknown;
        observedAt?: unknown;
        checkId?: unknown;
        toolName?: unknown;
        toolUseId?: unknown;
    }, automatic: boolean): unknown;
    status(conversation: unknown, checkId?: unknown): unknown;
}
