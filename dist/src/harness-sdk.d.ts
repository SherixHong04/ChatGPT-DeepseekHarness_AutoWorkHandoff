export interface HarnessEndpoint {
    launcher: string;
    profile: string;
    provider: 'deepseek-account';
    model: string;
    reasoningEffort?: string;
    maxTokens?: number;
}
export interface RuntimeLaunch {
    executable: string;
    args: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
}
export interface SdkNotification {
    method: string;
    params: unknown;
}
export interface CloseEvidence {
    shutdownAcknowledged: boolean;
    exited: boolean;
    code: number | null;
}
export declare function validateEndpoint(value: unknown): HarnessEndpoint;
export declare function harnessLaunch(endpoint: HarnessEndpoint, cwd: string): RuntimeLaunch;
/** One owned SDK process, strict stdio framing; no listener, credentials, or prompt retry. */
export declare class HarnessSdk {
    private readonly child;
    private readonly pending;
    private sequence;
    private buffer;
    private readonly decoder;
    private fault;
    private protocolIssue;
    private initialized;
    private startupDiagnosticCount;
    private readonly observers;
    private closing;
    private hasExited;
    private exitCode;
    constructor(launch: RuntimeLaunch);
    get pid(): number | null;
    get failure(): Error | null;
    get diagnostic(): string | null;
    get ignoredStartupDiagnostics(): number;
    get exited(): boolean;
    subscribe(observer: (event: SdkNotification) => void): () => void;
    private fail;
    private frame;
    request(method: string, params?: unknown, timeoutMs?: number | null): Promise<unknown>;
    initialize(endpoint: HarnessEndpoint, cwd: string): Promise<{
        name: string;
        version: string;
    }>;
    waitUntil(predicate: () => boolean, deadline: number | null, check?: () => void): Promise<void>;
    private exitWithin;
    close(): Promise<CloseEvidence>;
    private dispose;
}
/** Folds only the single, newly created root session; other sessions and raw account logs are discarded. */
export declare class SessionEvidence {
    readonly sessionId: string;
    readonly admitted: Set<string>;
    stepStarted: boolean;
    finalText: string;
    turnReason: string | null;
    lastSequence: number;
    eventCount: number;
    constructor(sessionId: string);
    observe(notification: SdkNotification): void;
}
