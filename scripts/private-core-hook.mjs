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
/** Which bare specifier to redirect. Supplied by the harness from the mutated package's own
 *  package.json `name`, so the hook is not hard-wired to one package and a fixture can exercise
 *  exactly this code path rather than a lookalike. */
const CORE = process.env.COTAL_PRIVATE_SPECIFIER ?? "@cotal-ai/core";

/** Fail loud rather than silently resolving to the shared build: a hook that quietly does nothing
 *  is the failure mode this file was written to remove. */
if (!TARGET) throw new Error("private-core-hook: COTAL_PRIVATE_CORE is unset — refusing to load a hook that would silently no-op");

/** ── THE SECOND KEY: redirect by RESOLVED URL, not by specifier ────────────────────────────────
 *  A bare-specifier redirect cannot reach a suite that imports its subject by RELATIVE PATH, and
 *  `connection-control.smoke.ts` imports the connector as `../src/agent.js` — source, compiled in
 *  memory by tsx, never through `@cotal-ai/*`. So a connector mutation was ungradeable by the same
 *  mechanism that made a core mutation gradeable: `LIMITS-private-build.md` #2 had a sibling.
 *
 *  A PREFIX map rather than a file list, deliberately: the copy's own internal imports (`./x.js`)
 *  already resolve inside the copy, and a per-file list would silently miss any module the mutated
 *  one pulls in — the same partial-redirect failure that produced a vacuous SURVIVED once already.
 *  Set by the harness as `<treeSrcRoot>::<copySrcRoot>`; absent means no URL redirect at all. */
const URLMAP = process.env.COTAL_PRIVATE_SRC_MAP;
const [FROM_ROOT, TO_ROOT] = URLMAP ? URLMAP.split("::") : [];
if (URLMAP && (!FROM_ROOT || !TO_ROOT))
  throw new Error(`private-core-hook: COTAL_PRIVATE_SRC_MAP is malformed (${URLMAP}) — refusing to load a half-configured redirect`);
const FROM_URL = FROM_ROOT ? `${pathToFileURL(FROM_ROOT).href}/` : undefined;
const TO_URL = TO_ROOT ? `${pathToFileURL(TO_ROOT).href}/` : undefined;

export async function resolve(specifier, context, next) {
  if (specifier === CORE) return { url: pathToFileURL(TARGET).href, shortCircuit: true };
  if (specifier.startsWith(`${CORE}/`)) {
    // Subpath exports (e.g. `@cotal-ai/core/session-browser`) live beside the entry in the same
    // build. Mapped by name so a subpath cannot silently fall through to the shared build.
    const sub = specifier.slice(CORE.length + 1);
    return { url: pathToFileURL(join(dirname(TARGET), `${sub}.js`)).href, shortCircuit: true };
  }
  const resolved = await next(specifier, context);
  // Applied to the RESOLVED url, so it catches relative, absolute and specifier-mapped imports
  // alike — whatever route the importer took to name the file, this is where it landed.
  if (FROM_URL && resolved?.url?.startsWith(FROM_URL))
    return { ...resolved, url: `${TO_URL}${resolved.url.slice(FROM_URL.length)}`, shortCircuit: true };
  return resolved;
}
