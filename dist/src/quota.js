import { positive, record, requireCondition } from './contracts.js';
export const defaultQuotaPolicy = {
    staleAfterMs: 300_000, workPercent: 5, handoffPercent: 5, reviewPercent: 10, resumePercent: 40,
};
export function quotaPolicy(value) {
    const row = record(value, ['staleAfterMs', 'workPercent', 'handoffPercent', 'reviewPercent', 'resumePercent'], '额度策略');
    for (const key of ['workPercent', 'handoffPercent', 'reviewPercent', 'resumePercent'])
        requireCondition(typeof row[key] === 'number' && Number.isFinite(row[key]) && Number(row[key]) > 0 && Number(row[key]) <= 100, 'INVALID_QUOTA_POLICY', '预留额度必须大于0且不超过100%。');
    requireCondition(Number.isSafeInteger(row.staleAfterMs) && Number(row.staleAfterMs) >= 1000 && Number(row.staleAfterMs) <= 300_000, 'INVALID_QUOTA_POLICY', '额度观测有效期应在1秒至5分钟之间。');
    const result = row;
    requireCondition(result.workPercent + result.handoffPercent + result.reviewPercent <= result.resumePercent, 'INVALID_QUOTA_POLICY', '恢复阈值必须覆盖工作、交接及验收预留。');
    return { ...result };
}
function window(value) {
    if (value === null || value === undefined || typeof value !== 'object')
        return null;
    const row = value;
    if (typeof row.usedPercent !== 'number' || !Number.isFinite(row.usedPercent) || row.usedPercent < 0 || row.usedPercent > 100
        || !Number.isSafeInteger(row.windowDurationMins) || Number(row.windowDurationMins) <= 0
        || !Number.isSafeInteger(row.resetsAt) || Number(row.resetsAt) <= 0)
        return null;
    return { usedPercent: row.usedPercent, windowDurationMins: Number(row.windowDurationMins), resetsAt: Number(row.resetsAt) * 1000 };
}
/** Normalize only native plan windows. Account IDs, credits, reset coupons and API limits are never retained. */
export function observeQuota(value, observedAt, now = Date.now()) {
    positive(observedAt, '额度观测时间');
    requireCondition(observedAt <= now + 5000, 'FUTURE_QUOTA', '额度观测不能来自未来。');
    requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_QUOTA', '需要原生额度工具返回的对象。');
    const root = value;
    const buckets = root.rateLimitsByLimitId;
    let raw;
    // Never fall back to a different bucket when the multi-bucket response exists.
    if (buckets !== null && buckets !== undefined) {
        requireCondition(typeof buckets === 'object' && !Array.isArray(buckets), 'INVALID_QUOTA', '额度桶格式不正确。');
        raw = buckets.codex;
    }
    else
        raw = root.rateLimits;
    const limits = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const primary = window(limits.primary), secondary = window(limits.secondary);
    const both = [primary, secondary].filter((w) => w !== null).sort((a, b) => a.windowDurationMins - b.windowDurationMins);
    const distinct = both.length === 2 && both[0].windowDurationMins < both[1].windowDurationMins;
    return { schemaVersion: 1, source: 'codex-app-get-usage-limits', observedAt,
        ordinaryUsageAllowed: typeof root.ordinaryUsageAllowed === 'boolean' ? root.ordinaryUsageAllowed : null,
        spendControlReached: typeof limits.spendControlReached === 'boolean' ? limits.spendControlReached : null,
        short: distinct ? both[0] : null, long: distinct ? both[1] : null };
}
export function assessQuota(observation, policy = defaultQuotaPolicy, now = Date.now()) {
    policy = quotaPolicy(policy);
    const no = (state, reason, recheckAt = now) => ({ state, reason, allowWork: false, allowHandoff: false, allowReview: false, allowResume: false, remaining: null, recheckAt });
    if (!observation || !observation.short || !observation.long || observation.ordinaryUsageAllowed === null || observation.spendControlReached === null)
        return no('unknown', '缺少原生双窗口额度；未知值不视为剩余额度。');
    const windows = [observation.short, observation.long];
    if (observation.observedAt > now + 5000 || now - observation.observedAt > policy.staleAfterMs || windows.some(w => now >= w.resetsAt))
        return no('stale', '额度已过期或经过重置时间，需重新查询，不推定已恢复。');
    const remaining = { short: 100 - observation.short.usedPercent, long: 100 - observation.long.usedPercent };
    const min = Math.min(remaining.short, remaining.long);
    // Wake at the latest reset among the windows that block resuming. Re-query then; never manufacture 100%.
    const blocked = windows.filter(w => 100 - w.usedPercent < policy.resumePercent);
    const recheckAt = blocked.length ? Math.max(...blocked.map(w => w.resetsAt)) : now + policy.staleAfterMs;
    if (!observation.ordinaryUsageAllowed || observation.spendControlReached)
        return { ...no('blocked', '原生账户当前不允许继续，保留任务，等待重新核实。', recheckAt), remaining };
    return { state: 'ready', reason: '使用实际短、长窗口及本项目预留阈值。', remaining, recheckAt,
        allowWork: min >= policy.workPercent + policy.handoffPercent + policy.reviewPercent,
        allowHandoff: min >= policy.handoffPercent + policy.reviewPercent,
        allowReview: min >= policy.reviewPercent, allowResume: min >= policy.resumePercent };
}
//# sourceMappingURL=quota.js.map