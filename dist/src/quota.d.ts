export interface QuotaWindow {
    usedPercent: number;
    windowDurationMins: number;
    resetsAt: number;
}
export interface QuotaObservation {
    schemaVersion: 1;
    source: 'codex-app-get-usage-limits' | 'codex-app-server-read';
    observedAt: number;
    ordinaryUsageAllowed: boolean | null;
    spendControlReached: boolean | null;
    short: QuotaWindow | null;
    long: QuotaWindow | null;
}
export interface QuotaPolicy {
    staleAfterMs: number;
    workPercent: number;
    handoffPercent: number;
    reviewPercent: number;
    resumePercent: number;
}
export declare const defaultQuotaPolicy: QuotaPolicy;
export declare function quotaPolicy(value: unknown): QuotaPolicy;
/** Normalize only native plan windows. Account IDs, credits, reset coupons and API limits are never retained. */
export declare function observeQuota(value: unknown, observedAt: number, now?: number): QuotaObservation;
export interface QuotaDecision {
    state: 'unknown' | 'stale' | 'blocked' | 'ready';
    reason: string;
    allowWork: boolean;
    allowHandoff: boolean;
    allowReview: boolean;
    allowResume: boolean;
    remaining: {
        short: number;
        long: number;
    } | null;
    recheckAt: number;
}
export declare function assessQuota(observation: QuotaObservation | null, policy?: QuotaPolicy, now?: number): QuotaDecision;
