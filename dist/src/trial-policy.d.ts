import type { QuotaObservation, QuotaPolicy } from './quota.js';
/** Task-local test settings. These never replace production admission reserves. */
export interface TrialPolicy {
    triggerRemainingPercent: number;
    reviewDelayMs: number;
}
export declare function trialPolicy(value: unknown): TrialPolicy;
export declare function evaluateTrial(policy: TrialPolicy, observation: QuotaObservation | null, executorReady: boolean, production?: QuotaPolicy, now?: number): {
    phase: string;
    thresholdReached: boolean;
    dispatchAllowed: boolean;
    decision: import("./quota.js").QuotaDecision;
};
export declare function isProjectToolTrigger(check: {
    event: string;
    evidence?: string;
    createdAt: number;
    phase: string;
}, projectStartedAt: number): boolean;
export declare function trialReviewDue(policy: TrialPolicy, acceptedAt: number | null): number | null;
