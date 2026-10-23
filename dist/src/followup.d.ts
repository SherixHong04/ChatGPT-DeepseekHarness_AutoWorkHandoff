import type { Packet } from './contracts.js';
/** A native same-chat scheduler consumes this prompt; this module does not create another chat or scheduler. */
export declare function followupPlan(packet: Packet, configFile: string): {
    kind: string;
    busyRecheckMinutes: number;
    name: string;
    prompt: string;
    nativeActivationVerified: boolean;
};
