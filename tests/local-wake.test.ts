import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WakeStore, checkWake, acknowledgeWake, findWakeReceipt, wakeMessage, wakeDue } from '../src/local-wake.js';
import type { ControlPort } from '../src/native-control.js';
import { NativeRpcError } from '../src/native-control.js';

const at = Date.parse('2026-01-01T00:00:00Z');
function usage(short: number, long: number, now: number) {
  return { ordinaryUsageAllowed: true, accountId: 'private-never-retain', rateLimitResetCredits: { availableCount: 1 },
    rateLimitsByLimitId: { codex: { spendControlReached: false, primary: { usedPercent: short, windowDurationMins: 300, resetsAt: now / 1000 + 3600 },
      secondary: { usedPercent: long, windowDurationMins: 10080, resetsAt: now / 1000 + 604800 } } } };
}
const cases = fileURLToPath(new URL('../../.local-tests/', import.meta.url));
function removeCase(dir: string): void { const resolved = fs.realpathSync(dir); assert(resolved.startsWith(fs.realpathSync(cases) + path.sep) && path.basename(resolved).startsWith('wake-')); fs.rmSync(resolved, { recursive: true }); }
function setup() {
  fs.mkdirSync(cases, { recursive: true }); const dir = fs.mkdtempSync(path.join(cases, 'wake-')); const store = new WakeStore(dir);
  const job = store.schedule({ conversationId: 'origin-a', taskId: 'wake-test', dueAt: at + 20_000, message: 'Only acknowledge the local wake test.' }, at);
  return { store, job, close() { store.close(); removeCase(dir); } };
}
function port(now: () => number, options: { used?: number; status?: string; reject?: boolean; uncertain?: boolean; duringSend?: () => void } = {}) {
  const calls: string[] = []; let queued = false; let requestId = '';
  const adapter: ControlPort = { close() {}, async request(method, params: any) {
    calls.push(method);
    if (method === 'account/rateLimits/read') return usage(options.used ?? 0, 0, now());
    if (method === 'thread/read') return { thread: { id: 'origin-a', status: { type: options.status ?? 'idle' } } };
    if (method === 'thread/turns/list') return { data: [{ id: 'previous-turn', status: 'completed' }] };
    if (method === 'thread/queue/list') return { data: queued ? [{ id: 'submission-a', clientUserMessageId: requestId }] : [] };
    if (method === 'thread/queue/add') { options.duringSend?.(); if (options.reject) throw new NativeRpcError(-32601); if (options.uncertain) throw Error('network-lost'); queued = true; requestId = params.clientUserMessageId;
      return { queuedSubmission: { id: 'submission-a', clientUserMessageId: requestId } }; }
    throw Error('unexpected');
  } }; return { adapter, calls };
}
test('wake waits for absolute wall time and catches up once after a long sleep', async () => {
  const s = setup(); let now = at + 19_000; const p = port(() => now);
  try { assert(!wakeDue(s.job, now)); await checkWake(s.store, s.job.id, p.adapter, () => now); assert.deepEqual(p.calls, []);
    now += 3 * 3600_000; const result = await checkWake(s.store, s.job.id, p.adapter, () => now);
    assert.equal(result.phase, 'queued'); assert.equal(result.dueAt, at + 20_000); assert.equal(result.lastCheckedAt, now);
    await checkWake(s.store, s.job.id, p.adapter, () => now + 120_000); assert.equal(p.calls.filter(x => x === 'thread/queue/add').length, 1);
  } finally { s.close(); }
});
test('wake checks actual dual quota before reading a thread or submitting a model message', async () => {
  const s = setup(), now = at + 20_000, p = port(() => now, { used: 99 });
  try { const result = await checkWake(s.store, s.job.id, p.adapter, () => now); assert.equal(result.phase, 'quota-wait');
    assert.deepEqual(p.calls, ['account/rateLimits/read']); assert.equal(result.evidence?.source, 'codex-app-server-read');
    assert(!JSON.stringify(result).includes('private-never-retain')); assert(!JSON.stringify(result).includes('rateLimitResetCredits'));
  } finally { s.close(); }
});
test('busy or erroneous origins never start another runtime', async () => {
  for (const status of ['active', 'systemError']) { const s = setup(), now = at + 20_000, p = port(() => now, { status });
    try { const result = await checkWake(s.store, s.job.id, p.adapter, () => now); assert.equal(result.phase, status === 'active' ? 'busy' : 'host-unavailable');
      assert(!p.calls.includes('thread/queue/add')); assert(!p.calls.includes('thread/resume')); assert.equal(result.nextCheckAt, now + 120_000);
    } finally { s.close(); }
  }
});
test('unloaded means owner queue only; prolonged pending is not false completion or permission to resend', async () => {
  const s = setup(), now = at + 20_000, p = port(() => now, { status: 'notLoaded' });
  try { const result = await checkWake(s.store, s.job.id, p.adapter, () => now); assert.equal(result.phase, 'queued');
    assert.equal((result.evidence?.threadStatus as {type: string}).type, 'notLoaded');
    assert.equal(result.evidence?.deliveryMode, 'persist-to-native-owner-queue');
    assert(!p.calls.includes('thread/resume')); assert(!p.calls.includes('turn/start'));
    assert.equal((await checkWake(s.store, s.job.id, p.adapter, () => now + 3600_000)).phase, 'queued');
    assert.equal(p.calls.filter(x => x === 'thread/queue/add').length, 1);
  } finally { s.close(); }
});
test('cancelled tasks and ambiguous sends never dispatch or automatically resend', async () => {
  const s = setup(), now = at + 20_000, p = port(() => now, { uncertain: true });
  try { const result = await checkWake(s.store, s.job.id, p.adapter, () => now); assert.equal(result.phase, 'unknown');
    await checkWake(s.store, s.job.id, p.adapter, () => now + 600_000); assert.equal(p.calls.filter(x => x === 'thread/queue/add').length, 1);
  } finally { s.close(); }
  const c = setup(), q = port(() => now); try { c.store.cancel(c.job.id, now); await checkWake(c.store, c.job.id, q.adapter, () => now); assert.deepEqual(q.calls, []); } finally { c.close(); }
});
test('a native rejection is recorded separately from unknown delivery and acknowledgement is scoped', async () => {
  const s = setup(), now = at + 20_000, p = port(() => now, { reject: true });
  try { assert.equal((await checkWake(s.store, s.job.id, p.adapter, () => now)).phase, 'failed'); } finally { s.close(); }
  const a = setup(), q = port(() => now); try { await checkWake(a.store, a.job.id, q.adapter, () => now);
    assert.throws(() => acknowledgeWake(a.store, a.job.id, 'wrong', a.job.conversationId, 'completed', now));
    assert.throws(() => acknowledgeWake(a.store, a.job.id, a.job.requestId, 'other', 'completed', now));
    assert.equal(acknowledgeWake(a.store, a.job.id, a.job.requestId, a.job.conversationId, 'completed', now).phase, 'completed');
  } finally { a.close(); }
});
test('persisted deadlines survive closing the store; missing quota remains unknown', async () => {
  const s = setup(); const dir = s.store.directory; s.store.close(); const reopened = new WakeStore(dir), now = at + 5 * 3600_000;
  const p = port(() => now); const original = p.adapter.request;
  p.adapter.request = (method, params) => method === 'account/rateLimits/read' ? Promise.resolve({}) : original(method, params);
  try { assert.equal(reopened.get(s.job.id).dueAt, at + 20_000); assert.equal((await checkWake(reopened, s.job.id, p.adapter, () => now)).phase, 'quota-wait');
    assert(!p.calls.includes('thread/queue/add'));
  } finally { reopened.close(); removeCase(dir); }
});
test('overlapping due checks reserve exactly one send; cancellation during the query wins', async () => {
  const s = setup(), now = at + 20_000, p = port(() => now);
  try { await Promise.all([checkWake(s.store, s.job.id, p.adapter, () => now), checkWake(s.store, s.job.id, p.adapter, () => now)]);
    assert.equal(p.calls.filter(x => x === 'thread/queue/add').length, 1);
  } finally { s.close(); }
  const c = setup(), q = port(() => now), original = q.adapter.request;
  q.adapter.request = async (method, params) => { const r = await original(method, params); if (method === 'account/rateLimits/read') c.store.cancel(c.job.id, now); return r; };
  try { assert.equal((await checkWake(c.store, c.job.id, q.adapter, () => now)).phase, 'cancelled'); assert(!q.calls.includes('thread/queue/add')); } finally { c.close(); }
});

test('late queue polls and send responses cannot erase completion or regress a started receipt', async () => {
  const s = setup(), now = at + 20_000, p = port(() => now);
  try {
    await checkWake(s.store, s.job.id, p.adapter, () => now);
    acknowledgeWake(s.store, s.job.id, s.job.requestId, s.job.conversationId, 'started', now);
    assert.equal((await checkWake(s.store, s.job.id, p.adapter, () => now + 120_000)).phase, 'started');
    const original = p.adapter.request;
    p.adapter.request = async (method, params) => {
      const r = await original(method, params);
      if (method === 'thread/queue/list') acknowledgeWake(s.store, s.job.id, s.job.requestId, s.job.conversationId, 'completed', now);
      return r;
    };
    assert.equal((await checkWake(s.store, s.job.id, p.adapter, () => now + 240_000)).phase, 'completed');
    assert.equal(s.store.update(s.job.id, { phase: 'unknown', reason: 'late-error' }).phase, 'completed');
    assert.equal(acknowledgeWake(s.store, s.job.id, s.job.requestId, s.job.conversationId, 'started', now).phase, 'completed');
  } finally { s.close(); }
});

test('duplicate schedules preserve the original deadline and request; conflicting intent is rejected', () => {
  const s = setup();
  try {
    const same = s.store.schedule({ conversationId: s.job.conversationId, taskId: s.job.taskId, message: s.job.message, dueAt: at + 80_000 });
    assert.equal(same.id, s.job.id); assert.equal(same.dueAt, s.job.dueAt); assert.equal(s.store.list().length, 1);
    assert.throws(() => s.store.schedule({ conversationId: s.job.conversationId, taskId: s.job.taskId, message: 'different work', dueAt: at + 80_000 }));
    const keyed = { conversationId: 'origin-a', taskId: 'other-task', message: 'ack', dueAt: at + 30_000, scheduleKey: 'once-a' };
    const j = s.store.schedule(keyed); s.store.update(j.id, { phase: 'completed' });
    assert.equal(s.store.schedule(keyed).id, j.id);
    assert.throws(() => s.store.schedule({ ...keyed, dueAt: at + 40_000 }));
  } finally { s.close(); }
});

test('receipt reconciliation rejects copied text and only accepts exact native client identity plus content', async () => {
  const s = setup();
  try {
    const item = { type: 'userMessage', id: 'native-item', clientId: 'manually-sent', content: [{ type: 'text', text: wakeMessage(s.job, s.store.directory) }] };
    const p: ControlPort = { close() {}, async request(method, params: any) {
      assert.equal(method, 'thread/turns/list'); assert.equal(params.itemsView, 'summary');
      return { data: [{ id: 'actual-turn', items: [item] }] }; } };
    assert.equal(await findWakeReceipt(p, s.job, s.store.directory), null);
    item.clientId = s.job.requestId; item.content[0]!.text = '“' + wakeMessage(s.job, s.store.directory) + '”';
    assert.equal(await findWakeReceipt(p, s.job, s.store.directory), null);
    item.content[0]!.text = wakeMessage(s.job, s.store.directory);
    assert.deepEqual(await findWakeReceipt(p, s.job, s.store.directory), { turnId: 'actual-turn', messageId: 'native-item' });
  } finally { s.close(); }
});

test('a temporary receipt-query outage preserves an accepted message and retries checks without resending', async () => {
  const s = setup(), now = at + 20_000, p = port(() => now);
  try {
    await checkWake(s.store, s.job.id, p.adapter, () => now);
    const original = p.adapter.request; let offline = true;
    p.adapter.request = (method, params) => offline ? Promise.reject(new Error('offline-after-resume')) : original(method, params);
    const waiting = await checkWake(s.store, s.job.id, p.adapter, () => now + 120_000);
    assert.equal(waiting.phase, 'queued'); assert.equal(waiting.nextCheckAt, now + 240_000);
    offline = false; assert.equal((await checkWake(s.store, s.job.id, p.adapter, () => now + 240_000)).phase, 'queued');
    assert.equal(p.calls.filter(m => m === 'thread/queue/add').length, 1);
  } finally { s.close(); }
});
