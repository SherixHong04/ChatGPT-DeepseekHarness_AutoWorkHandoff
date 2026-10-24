import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { QuotaHookBridge, defaultQuotaHookPolicy, quotaHookPolicy } from '../src/quota-hooks.js';
import { ToolStore } from '../src/tool-store.js';
import { defaultQuotaPolicy } from '../src/quota.js';
import { baseTime, errorCode, fixture } from './helpers.js';
function setup(t) {
    const f = fixture(t), filename = path.join(f.root, 'hooks.sqlite'), store = new ToolStore(filename);
    f.onCleanup(() => store.close());
    let now = baseTime;
    const bridge = new QuotaHookBridge(store, [f.resources], defaultQuotaHookPolicy, defaultQuotaPolicy, () => now);
    const event = (conversationId = 'chat-a', event = 'UserPromptSubmit') => bridge.event({ conversationId, cwd: f.resources, event });
    const check = (conversationId = 'chat-a') => store.get('quota-hook', conversationId);
    const usage = () => ({ ordinaryUsageAllowed: true, privateAccountLabel: 'do-not-store-this', resetCoupons: ['do-not-store-this'], rateLimitsByLimitId: {
            codex: { spendControlReached: false, primary: { usedPercent: 81, windowDurationMins: 300, resetsAt: Math.floor(now / 1000) + 3600 },
                secondary: { usedPercent: 28, windowDurationMins: 10080, resetsAt: Math.floor(now / 1000) + 604800 } }
        } });
    const record = (conversationId = 'chat-a') => bridge.record({ conversationId, usage: { content: [{ type: 'text', text: JSON.stringify(usage()) }] },
        toolName: 'mcp__codex_app__get_usage_limits', toolUseId: 'fixture-native-call' }, true);
    return { ...f, bridge, store, filename, event, check, usage, record, advance: (milliseconds) => { now += milliseconds; }, now: () => now };
}
test('hook events issue separate original-chat tickets without copying a prompt, transcript or tool content', t => {
    const f = setup(t);
    const first = f.event();
    assert.match(first.hookSpecificOutput.additionalContext, /get_usage_limits/);
    const a = f.check();
    f.event('chat-b');
    assert.notEqual(a.checkId, f.check('chat-b').checkId);
    assert.equal(f.check().conversationId, 'chat-a');
    assert.deepEqual(f.event(), {});
    assert.equal(f.check().checkId, a.checkId);
    assert.equal(JSON.stringify(a).includes('transcript'), false);
});
test('unrelated roots and quota-hook tools do not register or loop', t => {
    const f = setup(t);
    assert.deepEqual(f.bridge.event({ conversationId: 'unrelated', cwd: f.workRoot, event: 'SessionStart' }), {});
    assert.equal(f.store.get('quota-hook', 'unrelated'), null);
    for (const toolName of ['mcp__work_handoff_tasks__handoff_hook_event', 'mcp__work_handoff_tasks__handoff_quota_ack', 'mcp__codex_app__get_usage_limits'])
        assert.deepEqual(f.bridge.event({ conversationId: 'chat-a', cwd: f.resources, event: 'PostToolUse', toolName }), {});
    assert.equal(f.store.get('quota-hook', 'chat-a'), null);
});
test('native PostToolUse records actual-shaped dual windows and strips account and coupon fields', t => {
    const f = setup(t);
    f.event();
    f.advance(5);
    const output = f.record();
    const check = f.check();
    assert.equal(check.phase, 'recorded');
    assert.equal(check.evidence, 'hook-post-tool');
    assert.equal(check.observation?.observedAt, f.now());
    assert.equal(check.observation?.short?.usedPercent, 81);
    assert.equal(check.observation?.long?.usedPercent, 28);
    assert.match(output.hookSpecificOutput.additionalContext, /chat-a/);
    assert.equal(JSON.stringify(check).includes('do-not-store-this'), false);
    assert.equal(readFileSync(f.filename).includes(Buffer.from('do-not-store-this')), false);
    assert.equal(f.bridge.status('chat-a').decision.remaining.short, 19);
    assert.match(output.hookSpecificOutput.additionalContext, /"allowWork":false/);
    assert.match(output.hookSpecificOutput.additionalContext, /"handoffRequired":true/);
    assert.match(output.hookSpecificOutput.additionalContext, /handoff-unfinished-authorized-work/);
});
test('foreign conversation tickets, non-native tools and tool errors cannot fulfill a check', t => {
    const f = setup(t);
    f.event();
    f.event('chat-b');
    assert.throws(() => f.bridge.record({ conversationId: 'chat-b', checkId: f.check().checkId, usage: f.usage(), observedAt: f.now() }, false), errorCode('WRONG_QUOTA_CHECK'));
    assert.throws(() => f.bridge.record({ conversationId: 'chat-a', usage: f.usage(), toolName: 'other_get_usage_limits', toolUseId: 'fake' }, true), errorCode('WRONG_NATIVE_QUOTA_TOOL'));
    assert.throws(() => f.bridge.record({ conversationId: 'chat-a', usage: { isError: true, content: [] }, toolName: 'mcp__codex_app__get_usage_limits', toolUseId: 'failed' }, true), errorCode('NATIVE_QUOTA_TOOL_FAILED'));
    assert.equal(f.check().phase, 'pending');
    assert.equal(f.check('chat-b').phase, 'pending');
    assert.equal(f.store.quota(), null);
});
test('a fresh observation suppresses reminders; a reset or elapsed checking interval requires a new native query', t => {
    const f = setup(t);
    f.event();
    f.record();
    const before = f.check().checkId;
    assert.deepEqual(f.event(), {});
    f.advance(defaultQuotaHookPolicy.checkIntervalMs + 1);
    f.event();
    assert.notEqual(f.check().checkId, before);
    assert.equal(f.check().phase, 'pending');
    f.record();
    const observed = f.check();
    assert(observed.observation?.short);
    f.advance(observed.observation.short.resetsAt - f.now());
    assert.equal(f.bridge.status('chat-a').decision.state, 'stale');
    f.event();
    assert.equal(f.check().phase, 'pending');
});
test('expired checks and pre-ticket observations are refused rather than treated as recovered', t => {
    const f = setup(t);
    f.event();
    assert.throws(() => f.bridge.record({ conversationId: 'chat-a', checkId: f.check().checkId, usage: f.usage(), observedAt: baseTime - 1 }, false), errorCode('QUOTA_CHECK_EXPIRED'));
    f.advance(defaultQuotaHookPolicy.ticketTtlMs + 1);
    assert.throws(() => f.record(), errorCode('QUOTA_CHECK_EXPIRED'));
    assert.equal(f.check().phase, 'pending');
    assert.equal(f.store.quota(), null);
});
test('model fallback acknowledgements are labeled separately and never called native hook evidence', t => {
    const f = setup(t);
    f.event();
    f.bridge.record({ conversationId: 'chat-a', checkId: f.check().checkId, usage: f.usage(), observedAt: f.now() }, false);
    assert.equal(f.check().evidence, 'model-ack');
    assert.equal(f.check().nativeToolUseId, null);
    assert.throws(() => quotaHookPolicy({ checkIntervalMs: 120_000, ticketTtlMs: 1000 }), errorCode('INVALID_QUOTA_HOOK_POLICY'));
});
//# sourceMappingURL=quota-hooks.test.js.map