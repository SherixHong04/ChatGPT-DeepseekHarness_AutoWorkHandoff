import { mkdirSync, mkdtempSync, readFileSync, unlinkSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import type { Receipt } from './contracts.js';
import { requireCondition } from './contracts.js';
import { createPacket } from './packet.js';
import { Ledger } from './ledger.js';
import { FileEngine } from './files.js';

/** An end-to-end example confined to a fresh project-owned directory. */
export function runFileDemo(): Record<string, unknown> {
  const parent = fileURLToPath(new URL('../../.local/file-demos/', import.meta.url)); mkdirSync(parent, { recursive: true });
  const directory = mkdtempSync(path.join(parent, 'run-')), input = path.join(directory, 'input'), work = path.join(directory, 'work');
  mkdirSync(input); mkdirSync(work);
  writeFileSync(path.join(input, 'sample.txt'), 'Original demo content\n');
  writeFileSync(path.join(input, 'remove.txt'), 'Explicit deletion example\n');
  writeFileSync(path.join(input, 'unlisted.txt'), 'Do not collect or alter this demo sentinel\n');
  const database = path.join(directory, 'ledger.sqlite'), ledger = new Ledger(database), engine = new FileEngine(ledger, work);
  try {
    ledger.publishPacket(createPacket({ taskId: 'file-demo', version: 1, requirementsVersion: 1, title: '本地文件引擎演示',
      objective: '验证备份、冲突保护与恢复', requirements: ['仅操作本次创建的样例'], summary: '无模型、无外部文件', remainingWork: ['修改样例'],
      acceptanceCriteria: ['原件有备份', '恢复可核对', '未选文件保持原样'], conversationId: 'local-file-demo', resourceRoot: input,
      workRoot: work, recipients: ['work', 'harness'], deadlineAt: Date.now() + 3_600_000, files: ['sample.txt', 'remove.txt'] }), null);
    const baseline = engine.createBaseline('file-demo');
    const queued = ledger.enqueue('file-demo', ledger.getTask('file-demo').revision, { idempotencyKey: randomUUID(), packetVersion: 1,
      side: 'work', kind: 'execute', instructions: '仅修改本地演示样例。' });
    const command = ledger.claim(queued.id, 'local-file-demo').command; engine.prepareExecution(command.id, baseline.id);
    const copy = ledger.executionDirectory(command.id);
    writeFileSync(path.join(copy, 'sample.txt'), 'Updated demo content\n'); writeFileSync(path.join(copy, 'new.txt'), 'Added demo content\n');
    unlinkSync(path.join(copy, 'remove.txt'));
    const snapshot = engine.createSnapshot(command.id, ['sample.txt', 'new.txt'], ['remove.txt']);
    const event = (status: Receipt['status'], sequence: number): Receipt => ({ eventId: randomUUID(), commandId: command.id,
      executionId: command.executionId!, workerId: command.workerId!, sequence, status });
    ledger.receive(event('received', 1)); ledger.receive(event('running', 2));
    const done = ledger.receive({ ...event('succeeded', 3), output: { summary: '本地样例完成', acceptanceNotes: ['本地模拟，无模型'], files: snapshot.files } });
    const commit = engine.prepareCommit(snapshot.id, ledger.getTask('file-demo').revision); engine.applyCommit(commit.id);
    const restore = engine.prepareRestore(commit.id, ledger.getTask('file-demo').revision); engine.applyCommit(restore.id);
    const restoreVerified = readFileSync(path.join(input, 'sample.txt'), 'utf8') === 'Original demo content\n'
      && existsSync(path.join(input, 'remove.txt')) && !existsSync(path.join(input, 'new.txt'));
    requireCondition(restoreVerified, 'DEMO_RESTORE_FAILED', '本地样例恢复检查失败。');
    const final = engine.prepareCommit(snapshot.id, ledger.getTask('file-demo').revision); engine.applyCommit(final.id);
    ledger.complete('file-demo', ledger.getTask('file-demo').revision, done.resultId!);
    const summary = { mode: 'local-file-engine-no-model', directory, database, workRoot: work, modelsCalled: 0,
      physicalFileWritebackImplemented: true, backupVerified: readFileSync(path.join(engine.backupDirectory(final.id), 'sample.txt'), 'utf8') === 'Original demo content\n',
      restoreVerified, finalWritebackVerified: readFileSync(path.join(input, 'sample.txt'), 'utf8') === 'Updated demo content\n'
        && existsSync(path.join(input, 'new.txt')) && !existsSync(path.join(input, 'remove.txt')),
      unlistedPreserved: readFileSync(path.join(input, 'unlisted.txt'), 'utf8') === 'Do not collect or alter this demo sentinel\n' && !existsSync(path.join(copy, 'unlisted.txt')),
      journalCount: engine.listCommits().length, taskStage: ledger.getTask('file-demo').stage };
    requireCondition(summary.backupVerified && summary.finalWritebackVerified && summary.unlistedPreserved, 'DEMO_FAILED', '本地样例检查未通过。');
    writeFileSync(path.join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n', { flag: 'wx' }); return summary;
  } finally { engine.close(); ledger.close(); }
}
