import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Ledger } from '../src/ledger.js';
import { createPacket } from '../src/packet.js';
import { HandoffError } from '../src/contracts.js';
import type { Command, CommandKind, Output, Packet, Receipt, Side } from '../src/contracts.js';

export const baseTime = Date.UTC(2026, 9, 22);
export function fixture(t: TestContext) {
  const project = fileURLToPath(new URL('../../', import.meta.url));
  const cases = path.join(project, '.local-tests'); mkdirSync(cases, { recursive: true });
  const root = mkdtempSync(path.join(cases, 'case-')), resources = path.join(root, 'resources');
  const workRoot = path.join(root, 'work'); mkdirSync(workRoot);
  mkdirSync(resources); writeFileSync(path.join(resources, 'input.txt'), 'only designated task content\n');
  writeFileSync(path.join(resources, 'second.txt'), 'another independent file\n');
  let current = baseTime;
  const db = path.join(root, 'ledger.sqlite'), ledger = new Ledger(db, () => current);
  const closers: Array<() => void> = [];
  t.after(() => {
    for (const close of closers) close();
    ledger.close();
    const absolute = realpathSync(root);
    assert(absolute.startsWith(realpathSync(cases) + path.sep) && path.basename(absolute).startsWith('case-'));
    rmSync(absolute, { recursive: true, force: true });
  });
  const input = (taskId = 'task-a', version = 1) => ({ taskId, version, requirementsVersion: version,
    title: 'Local task', objective: 'Edit the designated sample', requirements: ['preserve meaning'],
    summary: 'Local fixture, no model', remainingWork: ['complete edit'], acceptanceCriteria: ['clear result'],
    conversationId: 'original-chat', resourceRoot: resources, workRoot, recipients: ['work', 'harness'],
    deadlineAt: current + 3_600_000, files: ['input.txt'] });
  const packet = (taskId = 'task-a', version = 1): Packet => createPacket(input(taskId, version), current);
  const publish = (taskId = 'task-a') => ledger.publishPacket(packet(taskId), null);
  const enqueue = (taskId = 'task-a', target: Side = 'harness', kind: CommandKind = 'execute', key: string = randomUUID()) =>
    ledger.enqueue(taskId, ledger.getTask(taskId).revision, { idempotencyKey: key,
      packetVersion: ledger.getTask(taskId).packetVersion, side: target, kind, instructions: 'Do the declared task only.' });
  return { root, resources, workRoot, ledger, db, packet, input, publish, enqueue, onCleanup: (close: () => void) => { closers.unshift(close); }, advance: (ms: number) => { current += ms; } };
}
export function errorCode(code: string) { return (error: unknown) => error instanceof HandoffError && error.code === code; }
export function receipt(command: Command, status: Receipt['status'], sequence: number, extra: Partial<Receipt> = {}): Receipt {
  assert(command.executionId && command.workerId);
  return { eventId: randomUUID(), commandId: command.id, executionId: command.executionId, workerId: command.workerId,
    sequence, status, ...extra };
}
export const output = (): Output => ({ summary: 'Completed local sample', acceptanceNotes: ['checked'], files: [] });
export function succeed(ledger: Ledger, queued: Command, worker = 'fixture-worker'): Command {
  const command = ledger.claim(queued.id, worker).command;
  ledger.markSent(command.id, command.executionId!);
  ledger.receive(receipt(command, 'received', 1)); ledger.receive(receipt(command, 'running', 2));
  return ledger.receive(receipt(command, 'succeeded', 3, { output: output() }));
}
