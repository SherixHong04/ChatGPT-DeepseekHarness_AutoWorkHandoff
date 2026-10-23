export declare function usage(short?: number, long?: number, now?: number): {
    ordinaryUsageAllowed: boolean;
    accountId: string;
    rateLimitResetCredits: {
        availableCount: number;
    };
    rateLimitsByLimitId: {
        codex: {
            spendControlReached: boolean;
            primary: {
                usedPercent: number;
                windowDurationMins: number;
                resetsAt: number;
            };
            secondary: {
                usedPercent: number;
                windowDurationMins: number;
                resetsAt: number;
            };
        };
    };
};
