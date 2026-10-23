import type { Packet } from './contracts.js';
/** Planning only. The local runner owns real wall-clock scheduling and native delivery evidence. */
export declare function followupPlan(packet: Packet, configFile: string): {
    kind: string;
    busyRecheckMinutes: number;
    name: string;
    launcher: string;
    entry: string;
    scheduleArguments: string[];
    needsExplicitDueTimeAndMessage: boolean;
    nativeActivationVerified: boolean;
    prompt: string;
};
