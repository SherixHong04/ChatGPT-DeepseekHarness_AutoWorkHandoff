import { record, requireCondition } from './contracts.js';
import { assessQuota, defaultQuotaPolicy } from './quota.js';
import type { QuotaObservation, QuotaPolicy } from './quota.js';

/** Task-local test settings. These never replace production admission reserves. */
export interface TrialPolicy { triggerRemainingPercent: number; reviewDelayMs: number }
export function trialPolicy(value: unknown): TrialPolicy {
  const row = record(value, ['triggerRemainingPercent', 'reviewDelayMs'], '单次测试参数');
  requireCondition(typeof row.triggerRemainingPercent === 'number' && Number.isFinite(row.triggerRemainingPercent)
    && row.triggerRemainingPercent > 0 && row.triggerRemainingPercent < 100,
  'INVALID_TRIAL_THRESHOLD', '测试触发点必须为0至100之间的剩余额度百分比。');
  requireCondition(Number.isSafeInteger(row.reviewDelayMs) && Number(row.reviewDelayMs) > 0,
    'INVALID_TRIAL_DELAY', '验收延迟必须为正整数毫秒；它不是模型执行期限。');
  return { triggerRemainingPercent: row.triggerRemainingPercent, reviewDelayMs: Number(row.reviewDelayMs) };
}
export function evaluateTrial(policy: TrialPolicy, observation: QuotaObservation | null, executorReady: boolean,
  production: QuotaPolicy = defaultQuotaPolicy, now = Date.now()) {
  policy = trialPolicy(policy);
  const decision = assessQuota(observation, production, now);
  // The test trigger watches only the real 5-hour window. Long-window reserves
  // remain part of admission, not part of deciding whether this trigger fired.
  const thresholdReached = decision.remaining !== null && observation?.short?.windowDurationMins === 300
    && decision.remaining.short < policy.triggerRemainingPercent;
  const phase = decision.state !== 'ready' ? 'needs-real-quota'
    : !thresholdReached ? 'waiting-for-threshold'
    : !decision.allowHandoff ? 'insufficient-handoff-reserve'
    : !executorReady ? 'executor-not-ready' : 'ready-to-handoff';
  return { phase, thresholdReached, dispatchAllowed: phase === 'ready-to-handoff', decision };
}
export function isProjectToolTrigger(check: { event: string; evidence?: string; createdAt: number; phase: string }, projectStartedAt: number): boolean {
  return check.event === 'PostToolUse' && check.evidence === 'hook-post-tool'
    && check.phase === 'recorded' && check.createdAt > projectStartedAt;
}
export function trialReviewDue(policy: TrialPolicy, acceptedAt: number | null): number | null {
  policy = trialPolicy(policy);
  if (acceptedAt === null) return null;
  requireCondition(Number.isSafeInteger(acceptedAt) && acceptedAt > 0 && Number.isSafeInteger(acceptedAt + policy.reviewDelayMs),
    'INVALID_TRIAL_ACCEPTANCE_TIME', '只有明确交接成功时间才能开始验收计时。');
  return acceptedAt + policy.reviewDelayMs;
}
