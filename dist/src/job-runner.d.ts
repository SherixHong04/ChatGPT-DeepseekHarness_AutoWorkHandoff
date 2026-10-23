import type { WorkerOptions } from './harness-worker.js';
export declare function runJob(configFile: string, commandId: string, token: string, workerOptions?: WorkerOptions): Promise<void>;
