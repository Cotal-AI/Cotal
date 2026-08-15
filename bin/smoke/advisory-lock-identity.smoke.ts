/**
 * The advisory lock is ONE implementation reachable by two import paths — asserted by IDENTITY.
 *
 * `advisory-lock` moved from `@cotal-ai/workspace` to `@cotal-ai/core` so
 * `extensions/connector-core` could reach it for the event emitter's one-per-principal lock
 * (extensions peer-depend core alone). A re-export was left behind so no existing import line
 * changed.
 *
 * **A COMPATIBILITY RE-EXPORT IS EXACTLY HOW YOU GET THE SECOND COPY THE MOVE EXISTED TO PREVENT,
 * AND IT LOOKS LIKE SUCCESS WHILE DOING IT.** Point the shim at a stale build, or let someone
 * "restore" the deleted file, and both paths still export functions with the right names and the
 * right signatures. Every behavioural test passes twice, against two implementations, and the
 * divergence surfaces later as one caller's lock quietly missing the release nonce or the PID-reuse
 * token — the copy that drifts being the one whose author needed it less.
 *
 * So the assertion is **identity, not equivalence**: the same function object, `===`. Two copies
 * that behave identically today fail this cell, which is the point. The claim is "one
 * implementation", and no behavioural test can express that.
 *
 * **THIS SUITE LIVES IN `bin/` DELIBERATELY.** It has to see both packages at once, and neither can
 * see the other: core depends on nothing else in the repo (a version of this suite inside
 * `packages/core/smoke` could not resolve `@cotal-ai/workspace`, correctly), and importing one side
 * by source and the other by package would compare two different module instances and fail for a
 * reason that has nothing to do with the claim. `bin/` is the composition root, so BOTH resolve
 * here by package name — the same way a consumer sees them, and the class `mutation-reachable`
 * already recognises as package-name-by-design.
 *
 * Run: pnpm smoke:advisory-lock-identity
 */
import * as core from "@cotal-ai/core";
import * as workspace from "@cotal-ai/workspace";

let pass = 0;
let fail = 0;
const c = (n: string, v: boolean, extra?: unknown): void => {
  if (v) {
    pass += 1;
    return;
  }
  fail += 1;
  console.error(`  x FAIL: ${n}${extra === undefined ? "" : ` ${JSON.stringify(extra)}`}`);
};

// Runtime values only. Types are erased, so a type-only re-export pointing elsewhere is invisible
// here and is `tsc`'s job instead.
const NAMES = ["acquireLock", "inspectLock", "breakLock", "lockIsActive", "liveLockOwnerPid", "processStartToken"] as const;

for (const n of NAMES) {
  const fromCore = (core as unknown as Record<string, unknown>)[n];
  const fromWorkspace = (workspace as unknown as Record<string, unknown>)[n];

  // Reached at all. Without these, a name missing from BOTH sides makes the identity cell below
  // compare `undefined === undefined` and PASS — the vacuous form of this exact assertion.
  c(`${n}: exported by @cotal-ai/core`, typeof fromCore === "function", typeof fromCore);
  c(`${n}: still exported by @cotal-ai/workspace`, typeof fromWorkspace === "function", typeof fromWorkspace);

  // THE CLAIM. Not "both work" — the same object.
  c(`${n}: BOTH IMPORT PATHS RESOLVE TO THE SAME FUNCTION OBJECT`, fromCore === fromWorkspace);
}

// THE CONTROL: the inverse of the predicate. `===` on functions must be able to report FALSE, or
// every cell above is a tautology about a comparison that never discriminates.
const a = (): number => 1;
const b = (): number => 1;
c("CONTROL — two distinct but identical functions are NOT ===, so the cells above can fail", (a as unknown) !== (b as unknown));

// The shim must not have WIDENED workspace's surface. `export * from "@cotal-ai/core"` would have
// been the one-line way to satisfy every cell above while dragging all of core into this package —
// a different boundary change than the one authorised.
c("the shim did NOT re-export all of core into workspace",
  (workspace as unknown as Record<string, unknown>).CotalEndpoint === undefined,
  typeof (workspace as unknown as Record<string, unknown>).CotalEndpoint);

console.log(`advisory-lock identity smoke: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
