import type { ChatOperation, ChatPolicy, ChatState } from './harness-chats.js';
interface Workspace {
    id: string;
    path: string;
    sessionIds: readonly string[];
    attachSession(sessionId: string): Promise<void>;
}
interface Observation {
    header: {
        id: string;
        cwd?: string;
    };
    events: readonly {
        seq: number;
    }[];
    projections?: {
        asOfSeq: number;
        values: {
            title?: string | null;
        };
    };
    [Symbol.dispose](): void;
}
/** Public Harness services only. No application-private database or credentials. */
export interface HarnessChatHost {
    workspaceRegistry: {
        resolveByPath(path: string): Promise<Workspace | undefined>;
        create(path: string, title: string): Promise<Workspace>;
        get(id: string): Workspace | undefined;
        readonly archivedSessionIds: readonly string[];
        archiveSession(sessionId: string): Promise<void>;
    };
    sessionController: {
        create(request: {
            sessionId: string;
            workspaceId: string;
        }): Promise<{
            sessionId: string;
        }>;
        rename(request: {
            sessionId: string;
            title: string;
        }): Promise<{
            title: string;
            seq: number;
        }>;
    };
    sessionQuery: {
        observeSession(sessionId: string): Promise<Observation>;
    };
    waterfall(event: 'workspace/session-activity', request: {
        sessionId: string;
    }, next: () => Promise<readonly unknown[]>): Promise<readonly unknown[]>;
}
export declare class HarnessChatManager {
    private readonly host;
    readonly policy: ChatPolicy;
    constructor(host: HarnessChatHost, policy: ChatPolicy);
    private filename;
    private observation;
    private registered;
    private state;
    call(value: ChatOperation): Promise<ChatState>;
}
export declare const name = "work-handoff-chat-manager";
export declare const inject: string[];
interface PluginContext extends HarnessChatHost {
    effect(action: () => () => void): unknown;
    logger: {
        warn(message: string): void;
    };
}
/** Official Cordis plugin entry, loaded into the existing desktop host. */
export declare function apply(ctx: PluginContext, config: unknown): Promise<void>;
export {};
