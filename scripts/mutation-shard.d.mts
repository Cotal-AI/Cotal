// Generated from mutation-shard.mjs by gen-ci-suites-dts.mts. Do not edit: run `pnpm gen:ci-suites-dts`.
// The .mjs module is the only source of truth; `pnpm smoke:ci-declarations` fails if this drifts.

/**
 * Deterministic fixture-path assignment shared by mutation reproof and its corpus partition control.
 * Keep this independent of fixture contents so changing or adding one fixture cannot move another.
 *
 * @param {string} path
 * @param {number} count
 * @returns {number}
 */
export function mutationShard(path: string, count: number): number;
