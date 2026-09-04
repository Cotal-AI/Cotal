// Generated from verify-publish-closure.mjs by gen-publish-closure-dts.mts. Do not edit:
// run `pnpm gen:publish-closure-dts`. The module is the only source of truth for these types;
// `pnpm smoke:verify-publish-closure` fails if they drift.
/**
 * Operator knobs. The timings are flags rather than constants because the right stability window is
 * a property of the registry's propagation behaviour, not of this repo, and whoever runs the gate
 * needs to be able to widen it without editing code. `--registry` exists for the same reason npm
 * itself takes one.
 */
export function parseOptions(argv: any, base?: {
    registryBase: string;
    pollIntervalMs: number;
    stableWindowMs: number;
    deadlineMs: number;
}): {
    registryBase: string;
    pollIntervalMs: number;
    stableWindowMs: number;
    deadlineMs: number;
};
/**
 * The closure is DERIVED from the repo, never typed. An earlier hand-written list carried 20 entries
 * against a 21-package `fixed` group, so it would have reported "fully published" while blind to
 * exactly the failure it existed to catch: a gate's own inputs have to come from the source of truth,
 * or the gate inherits the error it is checking for.
 */
export function closureFromConfig(configText: any, file?: string): any[];
/** npm scopes and slashes are percent-encoded in a registry path: @scope/name -> %40scope%2fname */
export function versionUrl(base: any, pkg: any, version: any): string;
/**
 * Classify one reading. Split out from the polling so the decision can be exercised directly:
 * the thing worth testing is the rule, not the sleeping.
 */
export function classify({ missing, total, unchangedForMs, elapsedMs }: {
    missing: any;
    total: any;
    unchangedForMs: any;
    elapsedMs: any;
}, opts?: {
    registryBase: string;
    pollIntervalMs: number;
    stableWindowMs: number;
    deadlineMs: number;
}): {
    state: string;
    missing?: undefined;
    why?: undefined;
} | {
    state: string;
    missing: any;
    why?: undefined;
} | {
    state: string;
    missing: any;
    why: string;
};
/**
 * Poll the closure until it settles. `packages` has no default on purpose -- there is no sensible
 * fallback list, and inventing one is how a gate ends up checking a set that is not the release's.
 *
 * @param {string} version
 * @param {{
 *   packages: string[],
 *   opts?: typeof DEFAULTS,
 *   fetchImpl?: typeof fetch,
 *   sleep?: (ms: number) => Promise<void>,
 *   now?: () => number,
 *   log?: (line: string) => void,
 * }} options
 */
export function verifyClosure(version: string, { packages, opts, fetchImpl, sleep, now, log, }?: {
    packages: string[];
    opts?: typeof DEFAULTS;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    log?: (line: string) => void;
}): Promise<{
    reads: {
        published: number;
        missing: any[];
        elapsedMs: number;
    }[];
    packages: number;
    state: string;
    missing?: undefined;
    why?: undefined;
} | {
    reads: {
        published: number;
        missing: any[];
        elapsedMs: number;
    }[];
    packages: number;
    state: string;
    missing: any;
    why?: undefined;
} | {
    reads: {
        published: number;
        missing: any[];
        elapsedMs: number;
    }[];
    packages: number;
    state: string;
    missing: any;
    why: string;
}>;
export namespace DEFAULTS {
    let registryBase: string;
    let pollIntervalMs: number;
    let stableWindowMs: number;
    let deadlineMs: number;
}
