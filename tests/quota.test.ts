import test from 'node:test';
import assert from 'node:assert/strict';
import { assessQuota, defaultQuotaPolicy, observeQuota, quotaPolicy } from '../src/quota.js';
import { baseTime, errorCode } from './helpers.js';
const at = baseTime;
export function usage(short = 21, long = 3, now = at) {
  return { ordinaryUsageAllowed: true, accountId: 'private-never-retain', rateLimitResetCredits: { availableCount: 1 },
    rateLimitsByLimitId: { codex: { spendControlReached: false,
      primary: { usedPercent: short, windowDurationMins: 300, resetsAt: now / 1000 + 3600 },
      secondary: { usedPercent: long, windowDurationMins: 10080, resetsAt: now / 1000 + 604800 } } } };
}
test('quota uses both actual native windows, drops account data and never spends reset credits', () => {
  const observation = observeQuota(usage(), at, at), decision = assessQuota(observation, undefined, at);
  assert.equal(observation.short?.windowDurationMins, 300); assert.equal(observation.long?.windowDurationMins, 10080);
  assert.deepEqual(decision.remaining, { short: 79, long: 97 }); assert(decision.allowWork && decision.allowResume);
  assert(!JSON.stringify(observation).includes('private-never-retain')); assert(!JSON.stringify(observation).includes('Credits'));
});
test('long window constrains work and handoff independently of a healthy short window', () => {
  const decision = assessQuota(observeQuota(usage(1, 81), at, at), undefined, at);
  assert.equal(decision.allowWork, false); assert.equal(decision.allowHandoff, true); assert.equal(decision.allowReview, true);
  assert.equal(decision.allowResume, false); assert.equal(decision.recheckAt, at + 604800000);
  const low = assessQuota(observeQuota(usage(1, 96), at, at), undefined, at); assert(!low.allowReview && !low.allowHandoff);
});
test('handoff threshold is strictly below 20 percent in either native window, with reserves unchanged', () => {
  for (const shortIsLow of [true, false]) {
    for (const remaining of [20.01, 20, 19.99, 15, 14.99, 10, 9.99]) {
      const used = 100 - remaining;
      const observation = observeQuota(usage(shortIsLow ? used : 1, shortIsLow ? 1 : used), at, at);
      const decision = assessQuota(observation, undefined, at);
      assert.equal(decision.allowWork, remaining >= 20);
      assert.equal(decision.allowHandoff, remaining >= 15);
      assert.equal(decision.allowReview, remaining >= 10);
      assert.equal(decision.allowResume, false);
    }
  }
  const recovery = assessQuota(observeQuota(usage(60, 60), at, at), undefined, at);
  assert.equal(recovery.allowResume, true);
});
test('missing, malformed, duplicate and other-bucket windows remain unknown', () => {
  for (const value of [null, {}, { ...usage(), rateLimitsByLimitId: {} },
    { ...usage(), rateLimitsByLimitId: { codex: { primary: { usedPercent: 0, windowDurationMins: 300, resetsAt: at / 1000 + 10 } } } }]) {
    if (value === null) assert.throws(() => observeQuota(value, at, at), errorCode('INVALID_QUOTA'));
    else assert.equal(assessQuota(observeQuota(value, at, at), undefined, at).state, 'unknown');
  }
  const data = usage(); data.rateLimitsByLimitId.codex.secondary.windowDurationMins = 300;
  assert.equal(assessQuota(observeQuota(data, at, at), undefined, at).state, 'unknown');
});
test('expired observations and elapsed resets require a fresh native reading; never assume replenishment', () => {
  const observation = observeQuota(usage(), at, at);
  assert.equal(assessQuota(observation, undefined, at + 300001).state, 'stale');
  observation.short!.resetsAt = at + 1000;
  assert.equal(assessQuota(observation, undefined, at + 1001).allowWork, false);
  assert.throws(() => observeQuota(usage(), at + 10000, at), errorCode('FUTURE_QUOTA'));
});
test('native disallow and spend controls block admission without API or billing fallback', () => {
  for (const which of ['ordinary', 'spend']) {
    const data = usage(); if (which === 'ordinary') data.ordinaryUsageAllowed = false; else data.rateLimitsByLimitId.codex.spendControlReached = true;
    const decision = assessQuota(observeQuota(data, at, at), undefined, at); assert.equal(decision.state, 'blocked'); assert(!decision.allowWork && !decision.allowHandoff);
  }
  assert.throws(() => quotaPolicy({ ...defaultQuotaPolicy, reviewPercent: 90 }), errorCode('INVALID_QUOTA_POLICY'));
});
