import type { Resource } from './contracts.js';
import { Ledger } from './ledger.js';
interface Identity {
    id: string;
    taskId: string;
    packetVersion: number;
    createdAt: number;
}
export interface Baseline extends Identity {
    packetSha256: string;
    files: Resource[];
}
export interface WorkCopy {
    commandId: string;
    baselineId: string;
    status: 'preparing' | 'ready';
    seedSnapshotId?: string | null;
}
export interface Snapshot extends Identity {
    commandId: string;
    baselineId: string;
    files: Resource[];
    deletions: string[];
}
export interface FileChange {
    path: string;
    before: Resource | null;
    after: Resource | null;
    applied: boolean;
    intent: 'none' | 'apply' | 'rollback';
}
export interface FileCommit extends Identity {
    snapshotId: string;
    sourceKind: 'snapshot' | 'backup';
    sourceId: string;
    restoreOf: string | null;
    expectedRevision: number;
    phase: 'preparing' | 'prepared' | 'applying' | 'committed' | 'rolling_back' | 'rolled_back';
    changes: FileChange[];
    lastError: string | null;
}
export type FileCheckpoint = (point: string, commit: FileCommit) => void;
export declare const FILE_ENGINE_FORMAT = 1;
/** Explicit file copies and recoverable, per-file writeback. No network or host/security control. */
export declare class FileEngine {
    private readonly ledger;
    private readonly checkpoint?;
    readonly storageRoot: string;
    readonly workRoot: string;
    private readonly db;
    constructor(ledger: Ledger, workRoot: string, checkpoint?: FileCheckpoint | undefined);
    close(): void;
    private get;
    private has;
    private save;
    private locked;
    private packet;
    private artifact;
    private createArtifact;
    getBaseline(baselineId: string): Baseline;
    baselineDirectory(baselineId: string): string;
    createBaseline(taskId: string, version?: number): Baseline;
    prepareExecution(commandId: string, baselineId: string, seedSnapshotId?: string | null): WorkCopy;
    getSnapshot(snapshotId: string): Snapshot;
    snapshotDirectory(snapshotId: string): string;
    verifySnapshot(snapshotId: string): Snapshot;
    createSnapshot(commandId: string, files: string[], deletions?: string[]): Snapshot;
    getCommit(commitId: string): FileCommit;
    listCommits(): FileCommit[];
    backupDirectory(commitId: string): string;
    private source;
    private allowed;
    private createCommit;
    prepareCommit(snapshotId: string, expectedRevision: number): FileCommit;
    prepareRestore(commitId: string, expectedRevision: number): FileCommit;
    private saveCommit;
    private mark;
    private prepare;
    private release;
    private preflight;
    private replace;
    private tempName;
    private cleanupTemps;
    applyCommit(commitId: string): FileCommit;
    rollbackCommit(commitId: string): FileCommit;
}
export {};
