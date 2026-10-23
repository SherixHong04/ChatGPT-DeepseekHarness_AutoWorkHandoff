import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { NativeControl } from './native-control.js';
import { acknowledgeWake, checkWake, findWakeReceipt, safeWakePath, WakeStore, wakeDue } from './local-wake.js';
import { quotaPolicy } from './quota.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  state: { type: 'string' }, thread: { type: 'string' }, task: { type: 'string' }, 'after-seconds': { type: 'string' }, at: { type: 'string' },
  message: { type: 'string' }, id: { type: 'string' }, request: { type: 'string' }, policy: { type: 'string' },
  phase: { type: 'string' }, key: { type: 'string' }, detached: { type: 'boolean' }, once: { type: 'boolean' }, 'queue-probe': { type: 'boolean' },
} });
const directory = safeWakePath(values.state ?? path.join(root, '.local/runtime/wake'));
const mode = positionals[0] ?? 'help';
function output(value: unknown): void { process.stdout.write(JSON.stringify(value, null, 2) + '\n'); }
function required(value: string | undefined): string { if (!value) throw new Error('REQUIRED_ARGUMENT_MISSING'); return value; }
function lockRunner(): (() => void) | null {
  const file = safeWakePath(path.join(directory, 'runner.lock.json'));
  const content = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
  try { fs.writeFileSync(file, content, { flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const owner = JSON.parse(fs.readFileSync(file, 'utf8')) as { pid: number };
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) throw new Error('RUNNER_LOCK_INVALID');
    try { process.kill(owner.pid, 0); return null; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') return null; }
    // No lease expires during sleep: a living process keeps ownership.
    fs.unlinkSync(file); return lockRunner();
  }
  return () => { if (fs.existsSync(file) && fs.readFileSync(file, 'utf8') === content) fs.unlinkSync(file); };
}
async function main(): Promise<void> {
  if (mode === 'help') { output({ commands: ['schedule --thread UUID --task ID --after-seconds N --message TEXT [--detached]', 'watch [--once]',
    'status [--id UUID]', 'cancel --id UUID', 'ack --id UUID --request UUID --thread UUID [--phase completed]', 'inspect --thread UUID'],
    timing: 'absolute Unix milliseconds; delayed callbacks recheck wall time; no model/Harness execution without explicit scheduling' }); return; }
  const store = new WakeStore(directory);
  try {
    if (mode === 'schedule') {
      if (Boolean(values.at) === Boolean(values['after-seconds'])) throw new Error('CHOOSE_AT_OR_AFTER_SECONDS');
      const seconds = Number(values['after-seconds']);
      if (values['after-seconds'] && (!Number.isFinite(seconds) || seconds <= 0)) throw new Error('INVALID_DELAY');
      const dueAt = values.at ? Date.parse(values.at) : Date.now() + seconds * 1000;
      const policy = values.policy ? quotaPolicy(JSON.parse(fs.readFileSync(safeWakePath(values.policy), 'utf8')).quotaPolicy) : undefined;
      const job = store.schedule({ conversationId: required(values.thread ?? process.env.CODEX_THREAD_ID), taskId: required(values.task),
        dueAt, message: required(values.message), ...(policy ? { policy } : {}), ...(values.key ? { scheduleKey: values.key } : {}), ...(values['queue-probe'] ? { queueProbe: true } : {}) }); output(job);
      if (values.detached) {
        const log = fs.openSync(safeWakePath(path.join(directory, 'runner.log')), 'a');
        try { const runner = spawn(process.execPath, [fileURLToPath(import.meta.url), 'watch', '--state', directory],
          { detached: true, windowsHide: true, stdio: ['ignore', log, log] }); runner.unref(); }
        finally { fs.closeSync(log); }
      }
      return;
    }
    if (mode === 'status') { output(values.id ? { job: store.get(values.id), events: store.events(values.id) } : store.list()); return; }
    if (mode === 'cancel') { output(store.cancel(required(values.id))); return; }
    if (mode === 'ack') {
      const current = process.env.CODEX_THREAD_ID;
      if (current && current !== values.thread) throw new Error('WRONG_ACTIVE_CONVERSATION');
      const phase = values.phase ?? 'completed'; if (phase !== 'started' && phase !== 'completed') throw new Error('INVALID_ACK_PHASE');
      const job = store.get(required(values.id));
      if (job.requestId !== required(values.request) || job.conversationId !== required(values.thread)) throw new Error('WAKE_ACK_MISMATCH');
      if (job.phase !== 'completed') {
        const port = await NativeControl.connect();
        try { if (!await findWakeReceipt(port, job, directory)) throw new Error('ORIGINAL_NATIVE_MESSAGE_NOT_CONFIRMED'); }
        finally { port.close(); }
      }
      output(acknowledgeWake(store, job.id, job.requestId, job.conversationId, phase)); return;
    }
    if (mode === 'inspect') {
      const port = await NativeControl.connect();
      try {
        const quota = await port.request('account/rateLimits/read'), thread = await port.request('thread/read', { threadId: required(values.thread) });
        const q = quota.rateLimitsByLimitId?.codex ?? quota.rateLimits;
        output({ source: 'codex-app-server-read', observedAt: Date.now(), primary: q?.primary, secondary: q?.secondary,
          ordinaryUsageAllowed: quota.ordinaryUsageAllowed, spendControlReached: q?.spendControlReached,
          thread: { id: thread.thread?.id, status: thread.thread?.status }, modelCalls: 0 });
      } finally { port.close(); } return;
    }
    if (mode !== 'watch') throw new Error('UNKNOWN_WAKE_COMMAND');
    const unlock = lockRunner(); if (!unlock) { output({ alreadyRunning: true }); return; }
    let stopping = false; process.once('SIGTERM', () => { stopping = true; }); process.once('SIGINT', () => { stopping = true; });
    try {
      do {
        const jobs = store.list().filter(j => !['completed', 'failed', 'unknown', 'cancelled'].includes(j.phase));
        if (!jobs.length) return;
        for (const job of jobs) {
          if (!wakeDue(job, Date.now())) continue;
          let port: NativeControl | undefined;
          try { port = await NativeControl.connect(); await checkWake(store, job.id, port); }
          catch { store.update(job.id, { phase: job.phase === 'dispatching' ? 'unknown' : ['queued', 'started'].includes(job.phase) ? job.phase : 'host-unavailable',
            reason: 'native-connection-unavailable', checks: job.checks + 1, lastCheckedAt: Date.now(), nextCheckAt: Date.now() + 120_000 }); }
          finally { port?.close(); }
        }
        if (values.once || stopping) return;
        // Short local sleep only. No quota/network polling until a job's absolute nextCheckAt.
        await delay(1000);
      } while (!stopping);
    } finally { unlock(); }
  } finally { store.close(); }
}
try { await main(); } catch { output({ error: 'LOCAL_WAKE_OPERATION_FAILED', note: 'No security settings were changed. Inspect this project state and preserve uncertain sends.' }); process.exitCode = 1; }
