import type { ToolStore } from './tool-store.js';
export interface TaskContextPolicy {
    root: string;
}
export interface TaskContextRecord {
    taskId: string;
    conversationId: string;
    resourceRoot: string;
    workRoot: string;
    files: string[];
    source: 'project' | 'selected-files' | 'conversation';
}
export type ContextResult = ({
    state: 'ready';
    requiresUserConfirmation: false;
} & TaskContextRecord) | {
    state: 'needs-selection';
    reason: string;
    choices: {
        file: string;
        candidates: string[];
    }[];
    message: string;
};
export declare function taskContextPolicy(value: unknown, workRoot: string): TaskContextPolicy;
export declare class TaskContexts {
    private readonly store;
    private readonly policy;
    private readonly workRoot;
    constructor(store: ToolStore, policy: TaskContextPolicy, workRoot: string);
    get(taskId: string, conversationId: string): TaskContextRecord | null;
    prepare(input: {
        taskId: unknown;
        conversationId: unknown;
        projectRoot?: unknown;
        files?: unknown;
        summary?: unknown;
    }): ContextResult;
}
