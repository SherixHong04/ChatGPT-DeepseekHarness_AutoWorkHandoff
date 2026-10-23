import type { Packet } from './contracts.js';
export interface ChatPolicy {
    queueRoot: string;
    workspaceRoot: string;
    enabledAt: number;
}
export interface ChatBinding {
    schemaVersion: 1;
    taskId: string;
    conversationId: string;
    sessionId: string;
    title: string;
    workspaceRoot: string;
    createdAt: number;
    phase: 'planned' | 'ready' | 'archived';
    workspaceId: string | null;
}
export interface ChatState {
    sessionId: string;
    workspaceId: string;
    title: string;
    sequence: number;
    active: boolean;
    archived: boolean;
}
export interface ChatApproval {
    resultId: string;
    snapshotId: string;
    sequence: number;
}
export type ChatOperation = {
    kind: 'prepare';
    binding: ChatBinding;
} | {
    kind: 'inspect';
    binding: ChatBinding;
} | {
    kind: 'archive';
    binding: ChatBinding;
    approval: ChatApproval;
};
export interface ChatPort {
    call(operation: ChatOperation): Promise<ChatState>;
}
export declare const CHAT_PROTOCOL = "work-handoff-chat-management-v1";
export declare function chatPolicy(value: unknown): ChatPolicy;
export declare function newChatBinding(packet: Packet, policy: ChatPolicy): ChatBinding;
export declare function validateChatBinding(value: unknown): ChatBinding;
export declare function validateChatOperation(value: unknown): ChatOperation;
export declare function validateChatState(value: unknown, binding: ChatBinding): ChatState;
export declare function atomicChatJson(filename: string, value: unknown): void;
export declare function readChatJson(filename: string): unknown;
/** Restricted local file transport to a plugin in the normal Harness host. No listener or credentials. */
export declare class FileChatPort implements ChatPort {
    private readonly policy;
    private readonly acknowledgementMs;
    constructor(policy: ChatPolicy, acknowledgementMs?: number);
    call(input: ChatOperation): Promise<ChatState>;
}
export declare function initializeChatQueue(policy: ChatPolicy): void;
