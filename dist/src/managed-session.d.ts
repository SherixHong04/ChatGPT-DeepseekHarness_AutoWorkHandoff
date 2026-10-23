import type { ChatBinding, ChatPolicy, ChatState } from './harness-chats.js';
import type { HarnessChatHost } from './harness-chat-plugin.js';
import type { Resource } from './contracts.js';
export interface RunRequest {
    kind: 'start' | 'inspect';
    binding: ChatBinding;
    commandId: string;
    directory: string;
    prompt: string;
    inputs: Resource[];
}
export interface RunState {
    chat: ChatState;
    phase: 'intent' | 'accepted' | 'unknown';
    acceptedAt: number | null;
    sequence: number;
    turnReason: string | null;
    messages: {
        seq: number;
        role: 'user' | 'assistant';
        text: string;
    }[];
}
export interface RunHost extends HarnessChatHost {
    sessionController: HarnessChatHost['sessionController'] & {
        prompt(request: {
            sessionId: string;
            requestId: string;
            mode: 'followup';
            content: {
                type: 'text';
                text: string;
            }[];
        }, signal: AbortSignal): Promise<{
            accepted: boolean;
        }>;
    };
}
export declare class ManagedSession {
    private readonly host;
    private readonly policy;
    private readonly chats;
    constructor(host: RunHost, policy: ChatPolicy);
    call(value: unknown): Promise<RunState>;
}
export declare function runPort(policy: ChatPolicy, input: RunRequest): Promise<RunState>;
export declare function installManagedSession(host: RunHost & {
    effect(action: () => () => void): unknown;
}, policy: ChatPolicy): void;
