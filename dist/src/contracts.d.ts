export declare const SCHEMA_VERSION = 1;
export type Side = 'work' | 'harness';
export type CommandKind = 'execute' | 'review' | 'rework' | 'finish';
export type CommandStatus = 'queued' | 'dispatching' | 'sent' | 'received' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown' | 'superseded';
export type Stage = 'ready' | 'active' | 'awaiting_review' | 'rework_ready' | 'work_finishing' | 'completed';
export type Control = 'open' | 'pause_requested' | 'paused' | 'cancel_requested' | 'cancelled';
export declare class HandoffError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare function requireCondition(value: unknown, code: string, message: string): asserts value;
export declare function text(value: unknown, name: string, max?: number): string;
export declare function id(value: unknown, name?: string): string;
export declare function positive(value: unknown, name: string): number;
export declare function record(value: unknown, fields: readonly string[], name: string): Record<string, unknown>;
export declare function strings(value: unknown, name: string, allowEmpty?: boolean): string[];
export declare function side(value: unknown): Side;
export declare function canonical(value: unknown): string;
export interface Resource {
    path: string;
    bytes: number;
    sha256: string;
}
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
export interface CommittedPacket {
    packet: Packet;
    sha256: string;
    committedAt: number;
}
export interface Task {
    id: string;
    revision: number;
    packetVersion: number;
    stage: Stage;
    control: Control;
    reworkCount: 0 | 1;
    mustFinishWithWork: boolean;
    completedResultId: string | null;
    lastControlRequestId: string | null;
    createdAt: number;
    updatedAt: number;
}
export interface CommandRequest {
    idempotencyKey: string;
    packetVersion: number;
    side: Side;
    kind: CommandKind;
    instructions: string;
}
export interface Command extends CommandRequest {
    id: string;
    taskId: string;
    status: CommandStatus;
    executionId: string | null;
    workerId: string | null;
    receiptSequence: number;
    resultId: string | null;
    reason: string | null;
    createdAt: number;
    updatedAt: number;
}
export interface Output {
    summary: string;
    acceptanceNotes: string[];
    files: Resource[];
}
export interface Receipt {
    eventId: string;
    commandId: string;
    executionId: string;
    workerId: string;
    sequence: number;
    status: 'received' | 'running' | 'succeeded' | 'failed' | 'cancelled';
    output?: Output;
    reason?: string;
    controlRequestId?: string;
}
export interface Result {
    id: string;
    taskId: string;
    packetVersion: number;
    commandId: string;
    side: Side;
    kind: CommandKind;
    resourceRoot: string;
    output: Output;
    createdAt: number;
    sha256: string;
}
export interface Reservation {
    id: string;
    taskId: string;
    packetVersion: number;
    paths: string[];
}
export interface ControlRequest {
    id: string;
    taskId: string;
    idempotencyKey: string;
    operation: 'pause' | 'cancel';
    status: 'requested' | 'settled';
    executionIds: string[];
    createdAt: number;
    settledAt: number | null;
}
export declare const terminal: (status: CommandStatus) => boolean;
export declare const inFlight: (status: CommandStatus) => boolean;
