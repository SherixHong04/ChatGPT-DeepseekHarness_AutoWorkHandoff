import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTrial, trialPolicy, trialReviewDue, isProjectToolTrigger } from '../src/trial-policy.js';
import { defaultQuotaPolicy } from '../src/quota.js';
import type { QuotaObservation } from '../src/quota.js';
const now = 1_790_000_000_000;
const policy = { triggerRemainingPercent: 50, reviewDelayMs: 600_000 };
const quota = (short: number, long = 80): QuotaObservation => ({ schemaVersion: 1, source: 'codex-app-get-usage-limits', observedAt: now,
  ordinaryUsageAllowed: true, spendControlReached: false,
  short: { usedPercent: 100 - short, windowDurationMins: 300, resetsAt: now + 3_600_000 },
  long: { usedPercent: 100 - long, windowDurationMins: 10080, resetsAt: now + 604_800_000 } });
test('trial watches only the five-hour window and triggers strictly below the threshold', () => {
  assert.equal(evaluateTrial(policy, quota(51), true, undefined, now).dispatchAllowed, false);
  assert.equal(evaluateTrial(policy, quota(50), true, undefined, now).dispatchAllowed, false);
  assert.equal(evaluateTrial(policy, quota(49), true, undefined, now).dispatchAllowed, true);
  assert.equal(evaluateTrial(policy, quota(75, 49), true, undefined, now).dispatchAllowed, false);
});
test('a user-message quota query is not evidence of detection during project work', () => {
  const check = { event: 'PostToolUse', evidence: 'hook-post-tool', createdAt: now + 1, phase: 'recorded' };
  assert.equal(isProjectToolTrigger(check, now), true);
  for (const change of [{ event: 'UserPromptSubmit' }, { event: 'SessionStart' }, { evidence: 'model-ack' }, { createdAt: now }, { phase: 'pending' }])
    assert.equal(isProjectToolTrigger({ ...check, ...change }, now), false);
});
test('threshold does not override unknown, stale, reset or blocked native quota', () => {
  for (const value of [null, { ...quota(46), observedAt: now - 300_001 }, { ...quota(46), ordinaryUsageAllowed: false },
    { ...quota(46), long: null }, { ...quota(46), short: { ...quota(46).short!, resetsAt: now } }])
    assert.equal(evaluateTrial(policy, value, true, undefined, now).dispatchAllowed, false);
});
test('unavailable managed executor and insufficient reserves stop dispatch without starting a timer', () => {
  assert.equal(evaluateTrial(policy, quota(46), false, undefined, now).phase, 'executor-not-ready');
  assert.equal(evaluateTrial(policy, quota(14), true, undefined, now).phase, 'insufficient-handoff-reserve');
  assert.equal(trialReviewDue(policy, null), null);
  assert.equal(trialReviewDue(policy, now), now + 600_000);
});
test('temporary trigger never changes production policy or becomes an execution/token limit', () => {
  const before = structuredClone(defaultQuotaPolicy); evaluateTrial(policy, quota(46), true, undefined, now);
  assert.deepEqual(defaultQuotaPolicy, before);
  for (const extra of [{ timeoutMs: 600_000 }, { maxTokens: 4096 }, { deadlineAt: now + 600_000 }])
    assert.throws(() => trialPolicy({ ...policy, ...extra }));
  assert.throws(() => trialReviewDue(policy, -1));
});
