import type { Command, Receipt } from './contracts.js';
import { FileEngine } from './files.js';
import type { Snapshot } from './files.js';
import { Ledger } from './ledger.js';
import type { CloseEvidence, HarnessEndpoint, RuntimeLaunch } from './harness-sdk.js';
export interface ExecutionPlan {
    outputs: string[];
    deletions: string[];
    timeoutMs?: number;
    seedSnapshotId?: string;
}
export interface WorkerAttempt {
    schemaVersion: 1;
    commandId: string;
    executionId: string;
    workerId: string;
    sessionId: string;
    endpointSha256: string;
    plan: ExecutionPlan;
    phase: 'prepared' | 'initializing' | 'sending' | 'accepted' | 'running' | 'settling' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
    pid: number | null;
    messageId: string | null;
    snapshotId: string | null;
    close: CloseEvidence | null;
    seedSnapshotId?: string | null;
    pendingReceipt: Receipt | null;
    eventCount: number;
    lastEventSequence: number;
    turnReason: string | null;
    errorCode: string | null;
    createdAt: number;
    updatedAt: number;
}
export interface DispatchResult {
    started: boolean;
    command: Command;
    attempt: WorkerAttempt | null;
}
export interface WorkerOptions {
    clock?: () => number;
    launch?: (endpoint: HarnessEndpoint, cwd: string) => RuntimeLaunch;
    checkpoint?: (point: string, attempt: WorkerAttempt) => void;
}
export declare function executionPlan(value: unknown): ExecutionPlan;
/** No synthetic five/fifteen-minute cutoff. Only explicit limits contribute. */
export declare function executionDeadline(plan: ExecutionPlan, packetDeadline: number | null, now: number, wallNow?: number): number | null;
export declare function parseWorkerResult(value: string, plan: ExecutionPlan): {
    summary: string;
    acceptanceNotes: string[];
    files: string[];
    deletions: string[];
};
/** One native Harness SDK runtime per execution. It never writes originals or silently resends a prompt. */
export declare class HarnessWorker {
    private readonly ledger;
    private readonly files;
    private readonly options;
    private readonly endpoint;
    private readonly store;
    private readonly active;
    private readonly clock;
    constructor(ledger: Ledger, files: FileEngine, endpoint: unknown, options?: WorkerOptions);
    close(): void;
    getAttempt(commandId: string): WorkerAttempt | null;
    private receipt;
    private check;
    private prompt;
    saveStage(commandId: string, paths: string[], deletions?: string[]): Snapshot;
    /** Replays only a persisted terminal receipt backed by cooperative native shutdown and actual process exit. No new model prompt. */
    recoverReceipt(commandId: string): Command;
    dispatch(commandId: string, planValue?: unknown): Promise<DispatchResult>;
}
