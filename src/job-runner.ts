import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { HandoffError, id, requireCondition } from './contracts.js';
import { digest } from './packet.js';
import { HarnessWorker } from './harness-worker.js';
import { TaskTools } from './task-tools.js';
import type { WorkerOptions } from './harness-worker.js';
import { assessQuota } from './quota.js';

export async function runJob(configFile: string, commandId: string, token: string, workerOptions: WorkerOptions = {}): Promise<void> {
  id(commandId); id(token); const tools = new TaskTools(configFile);
  let worker: HarnessWorker | undefined, acquired = false;
  try {
    const job = tools.store.update(commandId, token, previous => {
      requireCondition(previous.phase === 'reserved' && previous.configSha256 === digest(tools.config), 'JOB_NOT_RESERVED', '执行意图已处理或配置已变化，不重发。');
      acquired = true; return { ...previous, phase: 'running', pid: process.pid, updatedAt: Date.now() };
    });
    requireCondition(assessQuota(tools.store.quota(), tools.config.quotaPolicy).allowHandoff, 'QUOTA_NOT_READY', '后台启动时额度已过期或不足，未发送模型任务。');
    worker = new HarnessWorker(tools.ledger, tools.files, JSON.parse(readFileSync(tools.config.endpointFile, 'utf8')), workerOptions);
    const result = await worker.dispatch(commandId, job.plan ?? undefined);
    tools.store.update(commandId, token, previous => ({ ...previous, phase: result.command.status === 'unknown' ? 'unknown' : 'settled', updatedAt: Date.now() }));
  } catch (error) {
    if (acquired) tools.store.update(commandId, token, previous => ({ ...previous, phase: 'unknown',
      errorCode: error instanceof HandoffError ? error.code : 'JOB_FAILED', updatedAt: Date.now() }));
    throw error;
  } finally { worker?.close(); tools.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { config: { type: 'string' }, command: { type: 'string' }, token: { type: 'string' } } });
    requireCondition(values.config && values.command && values.token, 'JOB_ARGUMENTS_REQUIRED', '缺少后台执行参数。');
    await runJob(values.config, values.command, values.token);
  } catch { process.exitCode = 2; }
}
