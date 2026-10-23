/** Use the installed official proxy; never start, resume or replace an app-server. */
export declare function codexLauncher(): {
    command: string;
    args: string[];
};
export declare class NativeRpcError extends Error {
    readonly code: number;
    constructor(code: number);
}
export interface ControlPort {
    request(method: string, params?: unknown): Promise<any>;
    close(): void;
}
export declare class NativeControl implements ControlPort {
    private readonly socket;
    private readonly child;
    private sequence;
    private readonly pending;
    private constructor();
    static connect(): Promise<NativeControl>;
    request(method: string, params?: unknown): Promise<any>;
    private fail;
    close(): void;
}
