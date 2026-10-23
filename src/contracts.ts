export const SCHEMA_VERSION = 1;
export type Side = 'work' | 'harness';
export type CommandKind = 'execute' | 'review' | 'rework' | 'finish';
export type CommandStatus = 'queued' | 'dispatching' | 'sent' | 'received' | 'running'
  | 'succeeded' | 'failed' | 'cancelled' | 'unknown' | 'superseded';
export type Stage = 'ready' | 'active' | 'awaiting_review' | 'rework_ready' | 'work_finishing' | 'completed';
export type Control = 'open' | 'pause_requested' | 'paused' | 'cancel_requested' | 'cancelled';

export class HandoffError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'HandoffError'; }
}
export function requireCondition(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new HandoffError(code, message);
}
export function text(value: unknown, name: string, max = 32_768): string {
  requireCondition(typeof value === 'string' && value.trim().length > 0 && value.length <= max && !value.includes('\0'),
    'INVALID_TEXT', `${name}必须是长度合适的非空文本。`);
  return value;
}
export function id(value: unknown, name = '编号'): string {
  const result = text(value, name, 128);
  requireCondition(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(result), 'INVALID_ID', `${name}包含不支持的字符。`);
  return result;
}
export function positive(value: unknown, name: string): number {
  requireCondition(Number.isSafeInteger(value) && Number(value) > 0, 'INVALID_NUMBER', `${name}必须为正整数。`);
  return Number(value);
}
export function record(value: unknown, fields: readonly string[], name: string): Record<string, unknown> {
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_OBJECT', `${name}格式不正确。`);
  const result = value as Record<string, unknown>;
  requireCondition(Object.keys(result).every(key => fields.includes(key)), 'UNKNOWN_FIELD', `${name}含有未支持的字段。`);
  return result;
}
export function strings(value: unknown, name: string, allowEmpty = false): string[] {
  requireCondition(Array.isArray(value) && value.length <= 256 && (allowEmpty || value.length > 0), 'INVALID_LIST', `${name}必须是明确的文本列表。`);
  return value.map(item => text(item, name));
}
export function side(value: unknown): Side {
  requireCondition(value === 'work' || value === 'harness', 'INVALID_SIDE', '执行方不正确。');
  return value;
}
export function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    requireCondition(Number.isFinite(value), 'INVALID_JSON', '记录不支持非有限数值。'); return JSON.stringify(value);
  }
  requireCondition(typeof value === 'object', 'INVALID_JSON', '记录只能包含明确的JSON数据。');
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const row = value as Record<string, unknown>;
  return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`;
}

export interface Resource { path: string; bytes: number; sha256: string }
export interface Packet {
  schemaVersion: 1;
  taskId: string;
  version: number;
  requirementsVersion: number;
  createdAt: number;
  title: string;
  objective: string;
  requirements: string[];
  summary: string;
  remainingWork: string[];
  acceptanceCriteria: string[];
  conversationId: string;
  resourceRoot: string;
  workRoot: string;
  recipients: Side[];
  resources: Resource[];
  deadlineAt: number | null;
  maxRework: 1;
}
export interface CommittedPacket { packet: Packet; sha256: string; committedAt: number }
export interface Task {
  id: string; revision: number; packetVersion: number; stage: Stage; control: Control;
  reworkCount: 0 | 1; mustFinishWithWork: boolean; completedResultId: string | null;
  lastControlRequestId: string | null;
  createdAt: number; updatedAt: number;
}
export interface CommandRequest {
  idempotencyKey: string; packetVersion: number; side: Side; kind: CommandKind; instructions: string;
}
export interface Command extends CommandRequest {
  id: string; taskId: string; status: CommandStatus; executionId: string | null; workerId: string | null;
  receiptSequence: number; resultId: string | null; reason: string | null; createdAt: number; updatedAt: number;
}
export interface Output { summary: string; acceptanceNotes: string[]; files: Resource[] }
export interface Receipt {
  eventId: string; commandId: string; executionId: string; workerId: string; sequence: number;
  status: 'received' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  output?: Output; reason?: string;
  controlRequestId?: string;
}
export interface Result {
  id: string; taskId: string; packetVersion: number; commandId: string; side: Side; kind: CommandKind;
  resourceRoot: string; output: Output; createdAt: number; sha256: string;
}
export interface Reservation { id: string; taskId: string; packetVersion: number; paths: string[] }
export interface ControlRequest {
  id: string; taskId: string; idempotencyKey: string; operation: 'pause' | 'cancel';
  status: 'requested' | 'settled'; executionIds: string[]; createdAt: number; settledAt: number | null;
}
export const terminal = (status: CommandStatus): boolean => ['succeeded', 'failed', 'cancelled', 'superseded'].includes(status);
export const inFlight = (status: CommandStatus): boolean => !terminal(status) && status !== 'queued';
