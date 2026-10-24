import { FileEngine } from './files.js';
import { Ledger } from './ledger.js';
import type { QuotaPolicy } from './quota.js';
import { ToolStore } from './tool-store.js';
import type { Job } from './tool-store.js';
import type { ChatPolicy, ChatPort } from './harness-chats.js';
import type { QuotaHookPolicy } from './quota-hooks.js';
import type { ManagedPort } from './managed-worker.js';
import type { TaskContextPolicy } from './task-context.js';
import type { HandoffPrompt } from './handoff-consent.js';
export interface ToolsConfig {
    schemaVersion: 1;
    db: string;
    store: string;
    workRoot: string;
    endpointFile: string;
    resourceRoots: string[];
    quotaPolicy: QuotaPolicy;
    chatManagement?: ChatPolicy;
    quotaHooks?: QuotaHookPolicy;
    taskContext?: TaskContextPolicy;
}
export declare function toolsConfig(value: unknown): ToolsConfig;
export declare function loadToolsConfig(filename: string): ToolsConfig;
export interface ToolRuntimeOptions {
    clock?: () => number;
    launchJob?: (job: Job) => number | null;
    chatPort?: ChatPort;
    managedPort?: ManagedPort;
}
export declare class TaskTools {
    readonly configFile: string;
    private readonly options;
    readonly ledger: Ledger;
    readonly files: FileEngine;
    readonly store: ToolStore;
    readonly config: ToolsConfig;
    private readonly now;
    constructor(configFile: string, options?: ToolRuntimeOptions);
    close(): void;
    private packet;
    private allowRoot;
    private contexts;
    private prepareContext;
    private command;
    private quota;
    private admission;
    private worker;
    private managed;
    private currentChat;
    private chatPort;
    private quotaHooks;
    private chat;
    private archiveChat;
    private approved;
    private launch;
    /** Tool annotations aid the host UI; every tool still checks its own records and file scope. */
    call(name: string, value: unknown, interaction?: {
        prompt: HandoffPrompt;
        signal?: AbortSignal;
    }): Promise<unknown>;
}
type Schema = Record<string, unknown>;
export declare const toolDefinitions: {
    name: string;
    description: string;
    inputSchema: {
        type: "object";
        properties: Record<string, Schema>;
        required: string[];
        additionalProperties: boolean;
    };
    annotations: {
        readOnlyHint: boolean;
        destructiveHint: boolean;
        openWorldHint: boolean;
        idempotentHint: boolean;
    };
}[];
export {};
