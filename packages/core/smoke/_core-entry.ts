/**
 * The seam a mutation proof uses to load a PRIVATE build of core.
 *
 * WHY THIS EXISTS. A mutation proof compiles a deliberately broken core and runs a suite against
 * it. If that build lands in `packages/core/dist`, it is not merely visible to other readers — it
 * is the artifact they EXECUTE. On this box two installed connector extensions symlink
 * `@cotal-ai/core` into a worktree, so a mutant compiled to the shared path was loaded by every
 * Claude and OpenCode seat for the length of the proof. See
 * `.meshctl-measurement/FINDING-mutation-on-shared-dist.md`.
 *
 * THE DEFAULT IS THE SHARED BUILD, DELIBERATELY. An ordinary run resolves exactly what a user
 * executes, so this trades no coverage for its provenance. Only a mutation proof sets
 * `COTAL_CORE_ENTRY`, and it points at a scratch directory that did not exist until that run
 * created it — exclusivity by construction, not by checking who else reads the shared path (which
 * is not answerable; see `DESIGN-mutation-private-build.md` §2).
 *
 * FAILURE MODE, CHOSEN: an ABSENT variable falls back to the shared build. So a proof that forgets
 * to set it grades the shared build — loud, and wrong in the safe direction — rather than an
 * ordinary run silently grading a private one.
 *
 * The caller passes its own `fallback` because a relative specifier resolved inside THIS module
 * would resolve against this file rather than the caller's. Pass a bare specifier, or an absolute
 * URL built with `new URL(..., import.meta.url).href`.
 */
export function coreEntry(fallback: string): string {
  return process.env.COTAL_CORE_ENTRY ?? fallback;
}

/** `import()` core through the seam, typed as the real module rather than `any`. */
export async function importCore(fallback: string): Promise<typeof import("../src/index.js")> {
  return import(coreEntry(fallback)) as Promise<typeof import("../src/index.js")>;
}
