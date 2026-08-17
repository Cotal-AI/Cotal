/**
 * `@cotal-ai/smoke-kit` — helpers shared by the smoke suites, and nothing else.
 *
 * Private and never published: it is a devDependency of the packages whose suites use it, and no
 * `src/**` file anywhere may import it. That rail is enforced rather than stated, by
 * `packages/core/smoke/core-boundary.smoke.ts`, so a src import fails the `check` gate and CI.
 *
 * NO `dist`, AND THAT IS THE POINT. Every published package here resolves through `exports` to a
 * built `dist/`, which means a suite can read a compiled copy that is hours older than the `src` its
 * author is looking at — a failure that has cost real time on this repo: a fix that was correct in
 * source read as UNFIXED live, because the probe exercised a stale build while every grep read the
 * fixed source. These helpers are only ever loaded by `tsx`, which resolves an `exports` entry
 * pointing straight at `.ts`, so there is no build step, no build ordering, and no second copy that
 * can disagree with this one.
 */
export { SMOKE_BROKER_PREFIX, SMOKE_BROKER_TOKEN, killAndAwaitExit, teardownOnSignal } from "./broker-teardown.js";
