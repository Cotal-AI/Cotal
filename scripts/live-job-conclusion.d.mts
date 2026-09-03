// Generated from live-job-conclusion.mjs by gen-ci-suites-dts.mts. Do not edit: run `pnpm gen:ci-suites-dts`.
// The .mjs module is the only source of truth; `pnpm smoke:ci-declarations` fails if this drifts.

/**
 * @typedef {{ kind: "not-cancelled" } | { kind: "superseded", supersedingRunId: number } |
 * { kind: "self-timeout", durationSeconds: number, timeoutSeconds: number } |
 * { kind: "unexplained-cancellation", durationSeconds: number }} LiveConclusion
 * @typedef {{ result: string, repo: string, runId: number, attempt: number, workflow: string,
 * job: string, timeoutSeconds: number, event: string, prNumber: number, headRef: string }} LiveConclusionOptions
 */
/** @param {{ result: string, durationSeconds: number, timeoutSeconds: number, supersedingRunId?: number }} input @returns {LiveConclusion} */
export function classifyLiveConclusion({ result, durationSeconds, timeoutSeconds, supersedingRunId }: {
    result: string;
    durationSeconds: number;
    timeoutSeconds: number;
    supersedingRunId?: number;
}): LiveConclusion;
/** @param {LiveConclusionOptions} opts @param {string} token @param {typeof fetch} [fetchImpl] @returns {Promise<LiveConclusion>} */
export function inspectLiveConclusion(opts: LiveConclusionOptions, token: string, fetchImpl?: typeof fetch): Promise<LiveConclusion>;
export type LiveConclusion = {
    kind: "not-cancelled";
} | {
    kind: "superseded";
    supersedingRunId: number;
} | {
    kind: "self-timeout";
    durationSeconds: number;
    timeoutSeconds: number;
} | {
    kind: "unexplained-cancellation";
    durationSeconds: number;
};
export type LiveConclusionOptions = {
    result: string;
    repo: string;
    runId: number;
    attempt: number;
    workflow: string;
    job: string;
    timeoutSeconds: number;
    event: string;
    prNumber: number;
    headRef: string;
};
