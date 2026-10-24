import { spawn } from 'node:child_process';
import type { HandoffConsentRecord, HandoffPrompt } from './handoff-consent.js';
export declare function desktopQuestionAvailable(): boolean;
export declare function validDesktopReply(row: any, offer: HandoffConsentRecord, shownAt: number | null): boolean;
/** Own user-facing app window; never changes the host's approval or security policy. */
export declare function desktopHandoffPrompt(diagnose?: (event: string) => void, launch?: typeof spawn): HandoffPrompt;
