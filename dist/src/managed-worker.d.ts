import type { Command } from './contracts.js';
import type { ExecutionPlan } from './harness-worker.js';
import type { RunRequest, RunState } from './managed-session.js';
import type { ChatBinding, ChatPolicy } from './harness-chats.js';
import { FileEngine } from './files.js';
import { Ledger } from './ledger.js';
import { ToolStore } from './tool-store.js';
export interface ManagedAttempt {
    commandId: string;
    plan: ExecutionPlan;
    phase: 'preparing' | 'sending' | 'accepted' | 'unknown' | 'collected';
    request: RunRequest | null;
    acceptedAt: number | null;
    sequence: number | null;
    snapshotId: string | null;
    resultId: string | null;
}
export type ManagedPort = (policy: ChatPolicy, input: RunRequest) => Promise<RunState>;
/** Resident desktop execution: no SDK session, background model or execution timeout. */
export declare class ManagedWorker {
    private readonly ledger;
    private readonly files;
    private readonly store;
    private readonly policy;
    private readonly port;
    constructor(ledger: Ledger, files: FileEngine, store: ToolStore, policy: ChatPolicy, port?: ManagedPort);
    private receipt;
    private attempt;
    dispatch(c: Command, binding: ChatBinding, value: unknown): Promise<{
        started: boolean;
        command: Command;
        attempt: ManagedAttempt;
        needsReconciliation: boolean;
        acceptedAt?: never;
        sessionId?: never;
        next?: never;
    } | {
        started: boolean;
        command: Command;
        acceptedAt: number;
        sessionId: string;
        next: string;
        attempt?: never;
        needsReconciliation?: never;
    }>;
    inspect(commandId: string): Promise<{
        attempt: ManagedAttempt;
        run: RunState;
        waiting: boolean;
    }>;
    collect(commandId: string): Promise<{
        command: Command;
        snapshot: import("./files.js").Snapshot;
        run: RunState;
        unchanged: boolean;
    } | {
        command: Command;
        snapshot: import("./files.js").Snapshot;
        run: RunState;
        unchanged?: never;
    }>;
    verifyLatest(commandId: string): Promise<RunState>;
}
