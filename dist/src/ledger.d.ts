import type { Command, CommandRequest, CommittedPacket, ControlRequest, Output, Receipt, Reservation, Result, Task } from './contracts.js';
export declare const taskPhase: (task: Task) => string;
/** Local state only. No process control, network requests or plugin installation. */
export declare class Ledger {
    private readonly clock;
    private readonly db;
    constructor(filename: string, clock?: () => number);
    close(): void;
    private transaction;
    private now;
    private one;
    getTask(taskId: string): Task;
    listTasks(): Task[];
    getCommand(commandId: string): Command;
    listCommands(taskId: string): Command[];
    listAttempts(taskId: string): Command[];
    getControlRequest(requestId: string): ControlRequest;
    executionDirectory(commandId: string): string;
    getPacket(taskId: string, version?: number): CommittedPacket;
    getResult(resultId: string): Result;
    verifyResult(resultId: string): Result;
    listEvents(taskId: string): {
        seq: number;
        at: number;
        kind: string;
        data: unknown;
    }[];
    private audit;
    private revision;
    private saveTask;
    private saveCommand;
    private open;
    publishPacket(value: unknown, expectedRevision: number | null): Task;
    enqueue(taskId: string, expectedRevision: number, value: CommandRequest): Command;
    claim(commandId: string, workerId: string): {
        command: Command;
        claimed: boolean;
    };
    markSent(commandId: string, executionId: string): Command;
    receive(value: Receipt): Command;
    reconcile(value: Receipt, evidence: string): Command;
    private applyReceipt;
    refreshObservedResult(commandId: string, value: Output, evidence: string): Command;
    markWorkerLost(workerId: string, reason: string): Command[];
    private settleControl;
    requestControl(taskId: string, expectedRevision: number, operation: 'pause' | 'cancel', idempotencyKey?: string): Task;
    resume(taskId: string, expectedRevision: number): Task;
    requestRework(taskId: string, expectedRevision: number, resultId: string, reason: string): Task;
    reserveCommit(taskId: string, expectedRevision: number, paths: string[], reservationId?: string): Reservation;
    checkCommit(taskId: string, reservationId: string): Reservation;
    inspectCommit(reservationId: string): {
        reservation: Reservation;
        active: boolean;
    } | null;
    releaseCommit(taskId: string, reservationId: string): void;
    complete(taskId: string, expectedRevision: number, resultId: string): Task;
}
