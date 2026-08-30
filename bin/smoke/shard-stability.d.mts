// Generated from shard-stability.mjs by gen-ci-suites-dts.mts. Do not edit: run `pnpm gen:ci-suites-dts`.
// The .mjs module is the only source of truth; `pnpm smoke:ci-declarations` fails if this drifts.

/** Compare the frozen legacy order, not only the derived shard number. */
/** @param {string[]} base @param {string[]} head @returns {{ changed: string[], examined: number }} */
export function changedSuiteIndices(base: string[], head: string[]): {
    changed: string[];
    examined: number;
};
