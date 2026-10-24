import type { ExecutionPlan } from './harness-worker.js';
import type { QuotaObservation } from './quota.js';
import type { ChatBinding } from './harness-chats.js';
import type { QuotaCheck } from './quota-hooks.js';
import type { ManagedAttempt } from './managed-worker.js';
import type { HandoffConsentRecord } from './handoff-consent.js';
export interface Job {
    commandId: string;
    token: string;
    configSha256: string;
    plan: ExecutionPlan | null;
    phase: 'reserved' | 'running' | 'settled' | 'unknown';
    pid: number | null;
    createdAt: number;
    updatedAt: number;
    errorCode: string | null;
}
export declare class ToolStore {
    private readonly db;
    constructor(filename: string);
    close(): void;
    get<T>(kind: 'job' | 'quota' | 'review' | 'chat' | 'quota-hook' | 'quota-ticket' | 'managed' | 'task-context' | 'handoff-consent' | 'consent-recovery', name: string): T | null;
    private save;
    quota(): QuotaObservation | null;
    noteConsentRecovery(at: number): void;
    updateConsent(key: string, update: (previous: HandoffConsentRecord | null) => HandoffConsentRecord): HandoffConsentRecord;
    saveContext(taskId: string, value: {
        conversationId: string;
        resourceRoot: string;
    }): void;
    reserveManaged(value: ManagedAttempt): boolean;
    saveManaged(value: ManagedAttempt): void;
    approve(resultId: string, value: unknown): void;
    planChat(binding: ChatBinding): ChatBinding;
    updateChat(binding: ChatBinding): void;
    updateHook(conversationId: string, update: (previous: QuotaCheck | null) => QuotaCheck, observation?: QuotaObservation): QuotaCheck;
    saveQuota(value: QuotaObservation): void;
    reserve(job: Job): {
        created: boolean;
        job: Job;
    };
    update(commandId: string, token: string, update: (job: Job) => Job): Job;
}
