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
check(
  "a target that resolves to the root itself is refused, not treated as contained",
  rootItself !== null && rootItself.includes(root),
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
const viaSymlink = refusal(() => assertContainedIn(link, root));
check(
  "a symlink inside the root whose target is outside it is refused",
  viaSymlink !== null && viaSymlink.includes(outside),
  viaSymlink,
);

// POSITIVE CONTROL. Without this, a guard that refused unconditionally would pass every cell above
// while making the helper useless.
const allowed = refusal(() => assertContainedIn(inside, root));
check("a genuine strict child is allowed", allowed === null, allowed);

console.log("\nPART B — an over-long control socket path fails by name, not by EINVAL");

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
    && overlong.includes("108")
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
  Buffer.byteLength(minted.path) <= 108 && minted.path.endsWith(".sock"),
  minted.path,
);

removeContained(root, TEMP_ROOT, "1625 fixture root");
removeContained(outside, TEMP_ROOT, "1625 fixture outside-root");

console.log(`\nTEMP CONTAINMENT SMOKE ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed)`);
if (fail) process.exitCode = 1;
