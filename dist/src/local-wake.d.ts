import type { QuotaPolicy } from './quota.js';
import type { ControlPort } from './native-control.js';
export type WakePhase = 'pending' | 'quota-wait' | 'busy' | 'host-unavailable' | 'dispatching' | 'queued' | 'started' | 'completed' | 'failed' | 'unknown' | 'cancelled';
export interface WakeJob {
    schemaVersion: 1;
    id: string;
    conversationId: string;
    taskId: string;
    requestId: string;
    message: string;
    createdAt: number;
    dueAt: number;
    nextCheckAt: number;
    phase: WakePhase;
    checks: number;
    lastCheckedAt: number | null;
    reason: string;
    submissionId: string | null;
    turnId: string | null;
    baselineTurnId: string | null;
    policy: QuotaPolicy;
    evidence: Record<string, unknown> | null;
    queueProbe?: boolean;
    queuedAt?: number;
    scheduleKey?: string;
}
export declare function safeWakePath(filename: string): string;
export declare class WakeStore {
    readonly directory: string;
    private readonly db;
    constructor(directory: string);
    close(): void;
    get(jobId: string): WakeJob;
    list(): WakeJob[];
    events(jobId: string): unknown[];
    private save;
    event(jobId: string, at: number, value: unknown): void;
    schedule(input: {
        conversationId: string;
        taskId: string;
        dueAt: number;
        message: string;
        policy?: QuotaPolicy;
        queueProbe?: boolean;
        scheduleKey?: string;
    }, now?: number): WakeJob;
    update(jobId: string, patch: Partial<WakeJob>, now?: number): WakeJob;
    cancel(jobId: string, now?: number): WakeJob;
    claimDispatch(job: WakeJob, patch: Partial<WakeJob>, now: number): WakeJob | null;
}
export declare function wakeMessage(job: WakeJob, stateDirectory: string): string;
export declare function wakeDue(job: WakeJob, now: number): boolean;
/** Match native user-item identity AND exact content. Quoted/manual copies are not delivery evidence. */
export declare function findWakeReceipt(port: ControlPort, job: WakeJob, directory: string): Promise<{
    turnId: string;
    messageId: string;
} | null>;
/** Wall clock, never elapsed tick counts. A delayed callback after sleep runs this same admission path. */
export declare function checkWake(store: WakeStore, jobId: string, port: ControlPort, clock?: () => number): Promise<WakeJob>;
export declare function acknowledgeWake(store: WakeStore, jobId: string, requestId: string, conversationId: string, phase: 'started' | 'completed', now?: number): WakeJob;
