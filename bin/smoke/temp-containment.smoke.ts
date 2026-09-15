/**
 * Issue #1625: two path defects, neither of which a green suite can see.
 *
 * A) A recursive delete with no containment check removes whatever it is handed, so any defect
 *    UPSTREAM of it becomes an arbitrary recursive delete instead of a failed test. Measured: a
 *    mint that returned `candidate + "/.."` made its own teardown delete the PARENT of its mkdtemp,
 *    taking an orchestrator relay socket and fourteen seats' control sockets with it.
 *
 * B) A control socket path over `sun_path` fails at the bind with a bare `EINVAL`, an errno that
 *    names neither paths, nor lengths, nor sockets, so an over-long TMPDIR reads as a broken
 *    connector.
 *
 * PART A IS GRADED THROUGH THE ASSERTION, NEVER THROUGH A DELETE. The containment decision lives in
 * `assertContainedIn`, so every refusal below can be proven without any traversing path ever
 * reaching `rmSync` — running the incident to test the fix for the incident is not a test worth
 * having. The one delete this suite performs is its own fixture teardown, and it goes through
 * `removeContained` like everything else should.
 *
 * Run: pnpm smoke:temp-containment
 */
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertContainedIn, removeContained } from "./_scratch.js";
// BY SOURCE PATH, NOT BY PACKAGE NAME: `@cotal-ai/connector-core` resolves to that package's
// `dist`, so a mutation against `runtime.ts` would report SURVIVED until someone rebuilt.
import { controlEndpoint } from "../../extensions/connector-core/src/runtime.js";

let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

/** The refusal message, or null if the call did not throw. */
const refusal = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};

const TEMP_ROOT = realpathSync.native(tmpdir());
const root = realpathSync.native(mkdtempSync(join(TEMP_ROOT, "cotal-1625-")));
const inside = join(root, "child");
mkdirSync(inside);
const outside = realpathSync.native(mkdtempSync(join(TEMP_ROOT, "cotal-1625-outside-")));

console.log("\nPART A — a cleanup may only remove what it minted");

// The exact shape that fired: `candidate + "/.."` resolves to the mkdtemp's PARENT. Equal-to must
// be a refusal, because deleting the root itself IS the incident.
const rootItself = refusal(() => assertContainedIn(`${inside}/..`, root));
// The message is graded, not just the throw. If the equal-to branch is removed the target still
// gets refused — the root does not start with `root + sep`, so the outside-check catches it — and
// the refusal then blames an escape that did not happen. The distinct diagnosis IS the behaviour
// here, so a cell that only asserted "it threw" would grade a guard that no longer exists.
check(
  "a target that resolves to the root itself is refused, not treated as contained",
  rootItself !== null && rootItself.includes(root) && /\bIS the root\b/.test(rootItself),
  rootItself,
);

const escaped = refusal(() => assertContainedIn(`${root}/..`, root));
check(
  "a target that resolves outside its root is refused",
  escaped !== null && escaped.includes(root),
  escaped,
);

// Canonical, not lexical: a symlink INSIDE the root whose target is outside it satisfies every
// string compare and is still a delete of somebody else's directory.
const link = join(root, "link-to-outside");
symlinkSync(outside, link);
// The `exists` half of the pair below needs a real directory on the far side of the link, so the two
// targets differ in EXACTLY one property: whether the thing at the end of the path exists yet.
mkdirSync(join(outside, "exists"));
const viaSymlink = refusal(() => assertContainedIn(link, root));
check(
  "a symlink inside the root whose target is outside it is refused",
  viaSymlink !== null && viaSymlink.includes(outside),
  viaSymlink,
);

// THE PAIR THAT MAKES THE DEFECT LEGIBLE. Same shape, and before the deepest-existing-ancestor fix,
// OPPOSITE verdicts: `exists` was refused because realpath could resolve it, while `future` was
// ACCEPTED because a missing target fell back to its LEXICAL spelling, which cannot see that `link`
// points out of the root. Reproduced twice at 87fe6991d, once with real data loss outside the root
// through the accepted path. The missing one is the cell that matters; the existing one is kept
// beside it so a regression that re-splits the pair is visible as a pair.
const underLinkExists = refusal(() => assertContainedIn(join(link, "exists"), root));
check(
  "a target under a symlinked parent is refused when it exists",
  underLinkExists !== null && underLinkExists.includes(outside),
  underLinkExists,
);

const underLinkMissing = refusal(() => assertContainedIn(join(link, "future"), root));
check(
  "a MISSING target under a symlinked parent is refused, not certified by its spelling",
  underLinkMissing !== null && underLinkMissing.includes(outside),
  underLinkMissing,
);

// The deepest existing ancestor of this target IS the root, and the tail is still missing. It must
// stay allowed, or the fix above would trade the bypass for a guard that cannot approve a legitimate
// not-yet-created child - which is how a containment fix gets reverted wholesale.
const missingInsideRoot = refusal(() => assertContainedIn(join(root, "not-yet"), root));
check(
  "a missing target whose deepest existing ancestor IS the root is still allowed",
  missingInsideRoot === null,
  missingInsideRoot,
);

// A `..` in the tail of a MISSING target must not walk back out of the root. This is a boundary
// cell, not a mutant-graded one, and deliberately so: `resolve()` normalizes the path on entry to
// the resolver, so `..` is gone before the deepest-ancestor walk ever starts and every element of
// the missing tail is a plain basename. A mutant that removed the re-resolve I first wrote around
// the re-join SURVIVED, because that re-resolve was dead code — normalization had already happened.
// The cell stays because the PROPERTY is worth pinning against a future resolver that stops
// normalizing at entry; the dead mutant and the dead code both went, rather than shipping a NO-OP
// that would have read as coverage (#1627).
//
// BUILT AS A RAW STRING, NOT WITH join(): `join(root, "not-yet", "..", "..", "x")` collapses the
// `..` at the CALL SITE, so the guard would never see it at all.
const missingEscapes = refusal(() => assertContainedIn(`${root}/not-yet/../../elsewhere`, root));
check(
  "a missing target whose tail walks back out of the root is refused",
  missingEscapes !== null,
  missingEscapes,
);

// FAIL CLOSED ON AN ERRNO THAT IS NOT ENOENT. Walking up to the deepest existing ancestor must not
// turn "I could not resolve this" into "it does not exist yet, so trust its spelling": that is the
// same silent downgrade `physical` documents, reintroduced one level down.
//
// ELOOP, via a symlink cycle, rather than EACCES via chmod 000: a chmod-based cell grades nothing
// when the suite runs as root (CI containers routinely do), passing for the wrong reason. A cycle
// is refused by the kernel for every uid.
const cyclic = join(root, "cycle-a");
symlinkSync(join(root, "cycle-b"), cyclic);
symlinkSync(cyclic, join(root, "cycle-b"));
const unresolvable = refusal(() => assertContainedIn(join(cyclic, "future"), root));
check(
  "a target whose ancestry cannot be resolved at all is refused, not downgraded to its spelling",
  unresolvable !== null && /could not be established/.test(unresolvable),
  unresolvable,
);

// POSITIVE CONTROL. Without this, a guard that refused unconditionally would pass every cell above
// while making the helper useless.
const allowed = refusal(() => assertContainedIn(inside, root));
check("a genuine strict child is allowed", allowed === null, allowed);

console.log("\nPART B — an over-long control socket path fails by name, not by EINVAL");

// The limit the guard applies is the platform's: 108 on Linux, 104 on darwin. The cell reads the
// same figure back so a run on either platform grades the message it would actually get.
const SUN_PATH_LIMIT = process.platform === "darwin" ? 104 : 108;
const originalTmp = process.env.TMPDIR;
let deep = root;
while (deep.length <= 64) deep = join(deep, "dddddddddd");
mkdirSync(deep, { recursive: true });

process.env.TMPDIR = deep;
const overlong = refusal(() => controlEndpoint("space", "name"));
process.env.TMPDIR = originalTmp;
check(
  "a control socket path over the sun_path limit is refused with its path, length and limit",
  overlong !== null
    && /\b\d+ bytes\b/.test(overlong)
    && overlong.includes("sun_path")
    && overlong.includes(`${SUN_PATH_LIMIT}-byte`)
    && overlong.includes(deep),
  overlong,
);

// POSITIVE CONTROL. The temp root here is short, so a guard that refused every path would be
// caught rather than read as a fix.
process.env.TMPDIR = TEMP_ROOT;
const minted = controlEndpoint("space", "name");
process.env.TMPDIR = originalTmp;
check(
  "a control socket path within the limit is still minted",
  Buffer.byteLength(minted.path) <= SUN_PATH_LIMIT && minted.path.endsWith(".sock"),
  minted.path,
);

removeContained(root, TEMP_ROOT, "1625 fixture root");
removeContained(outside, TEMP_ROOT, "1625 fixture outside-root");

console.log(`\nTEMP CONTAINMENT SMOKE ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;
