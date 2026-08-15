/**
 * A per-process ESM resolve hook that redirects the BARE `@cotal-ai/core` specifier to a private
 * build, for the lifetime of one mutation-proof run and nothing longer.
 *
 * WHY THIS EXISTS. `mutation-proof --private-build` compiles a mutant into a scratch directory and
 * points the SUITE at it. That is not enough, and a full window was spent learning why: the cells
 * drive a `MeshAgent`, `connector-core` imports core by BARE specifier, and a bare specifier
 * resolves through the workspace link to the SHARED `packages/core/dist`. So the suite ran the
 * mutant and the subject ran the shipped build, and the proof graded nothing while reporting a
 * clean SURVIVED. See `.meshctl-measurement/FINDING-mx14-survived-vacuously.md`.
 *
 * WHY A HOOK AND NOT THE TWO OBVIOUS ALTERNATIVES — both were considered and both are unsafe:
 *
 *   - REPOINTING `node_modules/@cotal-ai/core`: that link is resolved by every process on the
 *     machine, including installed connectors under live agent sessions. It would redirect them
 *     all, and unlike a bad build it takes effect with no compile step at all. Strictly wider blast
 *     radius than the incident this whole seam exists to prevent.
 *   - `NODE_PATH`: legacy CJS resolution. ESM ignores it, so it would silently do nothing and the
 *     run would report a green about an unredirected process — the exact failure being fixed.
 *
 * A resolve hook is per-process, dies with the run, and touches no shared state.
 *
 * Registered via `scripts/private-core-register.mjs`, injected as `--import` through NODE_OPTIONS
 * by the harness. No suite's source changes, and nothing about how this tree resolves core by
 * default is altered.
 */
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const TARGET = process.env.COTAL_PRIVATE_CORE;

/** Fail loud rather than silently resolving to the shared build: a hook that quietly does nothing
 *  is the failure mode this file was written to remove. */
if (!TARGET) throw new Error("private-core-hook: COTAL_PRIVATE_CORE is unset — refusing to load a hook that would silently no-op");

const CORE = "@cotal-ai/core";

export async function resolve(specifier, context, next) {
  if (specifier === CORE) return { url: pathToFileURL(TARGET).href, shortCircuit: true };
  if (specifier.startsWith(`${CORE}/`)) {
    // Subpath exports (e.g. `@cotal-ai/core/session-browser`) live beside the entry in the same
    // build. Mapped by name so a subpath cannot silently fall through to the shared build.
    const sub = specifier.slice(CORE.length + 1);
    return { url: pathToFileURL(join(dirname(TARGET), `${sub}.js`)).href, shortCircuit: true };
  }
  return next(specifier, context);
}
