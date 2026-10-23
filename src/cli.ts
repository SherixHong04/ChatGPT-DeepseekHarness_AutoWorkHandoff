import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { HandoffError, positive, requireCondition } from './contracts.js';
import type { Command, Receipt, Side } from './contracts.js';
import { createPacket, fingerprint } from './packet.js';
import { Ledger, taskPhase } from './ledger.js';
import { runFileDemo } from './file-demo.js';
import { FileEngine } from './files.js';
import { HarnessWorker } from './harness-worker.js';

const project = fileURLToPath(new URL('../../', import.meta.url));
function simulatedSuccess(ledger: Ledger, queued: Command, filename?: string): Command {
  const command = ledger.claim(queued.id, `demo-${queued.side}`).command;
  requireCondition(command.workerId === `demo-${queued.side}` && command.status === 'dispatching' && command.receiptSequence === 0,
    'DEMO_EXECUTION_MISMATCH', '演示只能处理本地模拟工人已登记且尚未开始的执行。');
  const event = (status: Receipt['status'], sequence: number): Receipt => ({ eventId: randomUUID(), commandId: command.id,
    executionId: command.executionId!, workerId: command.workerId!, sequence, status });
  ledger.markSent(command.id, command.executionId!);
  ledger.receive(event('received', 1)); ledger.receive(event('running', 2));
  const work = ledger.executionDirectory(command.id);
  if (filename) { mkdirSync(work); writeFileSync(path.join(work, filename), 'Local simulated output; no model was called.\n'); }
  return ledger.receive({ ...event('succeeded', 3), output: { summary: 'Local simulation completed', acceptanceNotes: ['fixture checked'],
    files: filename ? [fingerprint(work, filename)] : [] } });
}
export function runDemo(): Record<string, unknown> {
  const demos = path.join(project, '.local', 'demos'); mkdirSync(demos, { recursive: true });
  const directory = mkdtempSync(path.join(demos, 'run-')), root = path.join(directory, 'input'), workRoot = path.join(directory, 'work');
  mkdirSync(root); mkdirSync(workRoot); writeFileSync(path.join(root, 'sample.txt'), 'A local sample for this project only.\n');
  const filename = path.join(directory, 'ledger.sqlite'); let ledger = new Ledger(filename);
  try {
    for (const taskId of ['demo-a', 'demo-b']) ledger.publishPacket(createPacket({ taskId, version: 1, requirementsVersion: 1,
      title: '本地交接模块演示', objective: '验证任务包、并发状态和回执', requirements: ['仅使用项目内样例'], summary: '不调用模型的本地演示',
      remainingWork: ['模拟处理样例'], acceptanceCriteria: ['回执可追溯', '最多返工一次'], conversationId: 'demo-original-chat',
      resourceRoot: root, workRoot, recipients: ['work', 'harness'], deadlineAt: Date.now() + 3_600_000, files: ['sample.txt'] }), null);
    const enqueue = (taskId: string, target: Side, kind: Command['kind']) => ledger.enqueue(taskId, ledger.getTask(taskId).revision,
      { idempotencyKey: randomUUID(), packetVersion: 1, side: target, kind, instructions: '仅处理本地演示资料。' });
    const queuedA = enqueue('demo-a', 'harness', 'execute'), queuedB = enqueue('demo-b', 'work', 'execute');
    const a = ledger.claim(queuedA.id, 'demo-harness').command, b = ledger.claim(queuedB.id, 'demo-work').command;
    const parallelAttempts = ledger.listAttempts('demo-a').length + ledger.listAttempts('demo-b').length;
    ledger.markWorkerLost(b.workerId!, 'Simulated lost connection');
    ledger.close(); ledger = new Ledger(filename);
    const unknownSurvivedReopen = ledger.getCommand(b.id).status === 'unknown';
    ledger.reconcile({ eventId: randomUUID(), commandId: b.id, executionId: b.executionId!, workerId: b.workerId!, sequence: 1,
      status: 'cancelled', reason: 'This local fixture had no real executor' }, 'Local fixture confirmed no model or remote request was started');
    const first = simulatedSuccess(ledger, a, 'first.txt');
    ledger.requestRework('demo-a', ledger.getTask('demo-a').revision, first.resultId!, '一次样例修订');
    const rework = simulatedSuccess(ledger, enqueue('demo-a', 'harness', 'rework'), 'reworked.txt');
    requireCondition(rework.status === 'succeeded', 'DEMO_FAILED', '演示返工失败。');
    const finished = simulatedSuccess(ledger, enqueue('demo-a', 'work', 'finish'), 'final.txt');
    const held = ledger.reserveCommit('demo-a', ledger.getTask('demo-a').revision, ['sample.txt']);
    let sameFileConflictDetected = false;
    try { ledger.reserveCommit('demo-b', ledger.getTask('demo-b').revision, ['sample.txt']); }
    catch (error) { if (error instanceof HandoffError && error.code === 'RESOURCE_BUSY') sameFileConflictDetected = true; else throw error; }
    ledger.releaseCommit('demo-a', held.id);
    ledger.complete('demo-a', ledger.getTask('demo-a').revision, finished.resultId!);
    const summary = { mode: 'local-simulation-no-model', directory, database: filename, taskCount: ledger.listTasks().length,
      parallelAttempts, unknownSurvivedReopen, sameFileConflictDetected, taskA: taskPhase(ledger.getTask('demo-a')),
      reworkCount: ledger.getTask('demo-a').reworkCount, inputUnchanged: readFileSync(path.join(root, 'sample.txt'), 'utf8') === 'A local sample for this project only.\n',
      modelsCalled: 0, physicalWritebackImplemented: false };
    writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n'); return summary;
  } finally { ledger.close(); }
}
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const { values } = parseArgs({ args, strict: true, options: { db: { type: 'string' }, input: { type: 'string' },
    task: { type: 'string' }, revision: { type: 'string' }, version: { type: 'string' }, output: { type: 'string' },
    command: { type: 'string' }, endpoint: { type: 'string' }, plan: { type: 'string' } } });
  if (command === 'demo') { requireCondition(args.length === 0, 'INVALID_ARGUMENTS', '演示不接受外部资料路径。'); console.log(JSON.stringify(runDemo())); return; }
  if (command === 'file-demo') { requireCondition(args.length === 0, 'INVALID_ARGUMENTS', '演示不接受外部资料路径。'); console.log(JSON.stringify(runFileDemo())); return; }
  requireCondition(['publish', 'status', 'export', 'harness-run', 'harness-recover'].includes(command ?? ''), 'USAGE',
    '用法：demo | file-demo | publish --input draft.json | status [--task 编号] | export --task 编号 --output 路径 | harness-run --command 编号 --endpoint 配置 [--plan 文件计划] | harness-recover --command 编号 --endpoint 配置。可加--db指定账本。');
  const database = path.resolve(values.db ?? path.join(project, '.local', 'ledger.sqlite'));
  if (command !== 'publish') requireCondition(existsSync(database), 'DATABASE_NOT_FOUND', '账本尚未创建。');
  const ledger = new Ledger(database);
  try {
    if (command === 'harness-run' || command === 'harness-recover') {
      requireCondition(values.command && values.endpoint, 'ENDPOINT_REQUIRED', '请明确指定已登记指令及执行端配置文件。');
      const queued = ledger.getCommand(values.command), packet = ledger.getPacket(queued.taskId, queued.packetVersion).packet;
      const files = new FileEngine(ledger, packet.workRoot);
      try {
        const worker = new HarnessWorker(ledger, files, JSON.parse(readFileSync(path.resolve(values.endpoint), 'utf8')));
        try {
          if (command === 'harness-recover') console.log(JSON.stringify(worker.recoverReceipt(queued.id)));
          else {
            const result = await worker.dispatch(queued.id, values.plan ? JSON.parse(readFileSync(path.resolve(values.plan), 'utf8')) : undefined);
            console.log(JSON.stringify({ started: result.started, command: result.command, attempt: result.attempt }));
            if (result.command.status !== 'succeeded') process.exitCode = 2;
          }
        } finally { worker.close(); }
      } finally { files.close(); }
    } else if (command === 'publish') {
      requireCondition(values.input, 'INPUT_REQUIRED', '请指定本项目任务输入文件。');
      const packet = createPacket(JSON.parse(readFileSync(path.resolve(values.input), 'utf8')));
      console.log(JSON.stringify(ledger.publishPacket(packet, values.revision === undefined ? null : positive(Number(values.revision), '任务版本'))));
    } else if (command === 'export') {
      requireCondition(values.task && values.output, 'OUTPUT_REQUIRED', '导出须指定任务与新文件路径。');
      const packet = ledger.getPacket(values.task, values.version === undefined ? undefined : positive(Number(values.version), '包版本'));
      const file = path.resolve(values.output); writeFileSync(file, JSON.stringify(packet, null, 2) + '\n', { flag: 'wx' });
      console.log(JSON.stringify({ file, taskId: packet.packet.taskId, version: packet.packet.version, sha256: packet.sha256 }));
    } else {
      const tasks = values.task ? [ledger.getTask(values.task)] : ledger.listTasks();
      console.log(JSON.stringify(tasks.map(task => ({ ...task, phase: taskPhase(task), commands: ledger.listCommands(task.id).map(item =>
        ({ id: item.id, kind: item.kind, side: item.side, status: item.status, executionId: item.executionId, packetVersion: item.packetVersion })) }))));
    }
  } finally { ledger.close(); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => { console.error(JSON.stringify({ error: error instanceof HandoffError ? error.code : 'LOCAL_ERROR',
    message: error instanceof Error ? error.message : 'Unknown local error' })); process.exitCode = 1; });
}
