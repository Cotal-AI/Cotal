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
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertContainedIn, removeContained } from "./_scratch.js";
// BY SOURCE PATH, NOT BY PACKAGE NAME: `@cotal-ai/connector-core` resolves to that package's
// `dist`, so a mutation against `runtime.ts` would report SURVIVED until someone rebuilt.
import { controlEndpoint } from "../../extensions/connector-core/src/runtime.js";

let pass = 0;
let fail = 0;
let skipped = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

/**
 * A cell that CANNOT be graded here, named and counted rather than silently dropped or attempted.
 *
 * Distinct from a pass: the summary reports skips separately, so a run where the environment could
 * not host a cell never reads as a run where the cell passed. The reason is printed with it, because
 * "SKIP" with no cause is indistinguishable from a cell someone disabled to get green.
 */
const skip = (name: string, why: string) => {
  skipped++;
  console.log(`  ⊘ SKIP: ${name} — ${why}`);
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
// Captured BEFORE the body, so the `finally` can put it back even if the body threw mid-swap.
const originalTmp = process.env.TMPDIR;

try {
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

  // A DANGLING SYMLINK IS NOT A MISSING BASENAME. `realpath` reports ENOENT for both, so a resolver
  // that reads every ENOENT as "not created yet" steps PAST an existing symlink, canonicalizes an
  // ancestor ABOVE it, and appends the tail lexically — certifying a path the kernel would not take.
  // Measured at e6a831e36: with `outside-absent` NOT created this was ACCEPTED, and creating the
  // directory REFUSED the IDENTICAL call. The same spelling flipping verdict because someone else
  // created the parent is the tell, and the ACCEPTED half is the dangerous one.
  const danglingParent = join(root, "dangling-link");
  symlinkSync(join(TEMP_ROOT, "cotal-1626-outside-absent"), danglingParent);
  const underDangling = refusal(() => assertContainedIn(join(danglingParent, "future"), root));
  check(
    "a target under a DANGLING symlinked parent is refused, not read as a missing basename",
    underDangling !== null && /dangling symlink/.test(underDangling) && underDangling.includes(danglingParent),
    underDangling,
  );

  // A `..` AFTER A SYMLINK BELONGS TO THE PHYSICAL PREFIX, NOT TO THE SPELLING. `resolve()` on entry
  // applied it textually before any symlink was read, so this was certified as `root/SIBLING.txt`
  // while the kernel reads it as `<outside>/../SIBLING.txt`. REFUSED at the pre-fix base 1d389afb and
  // ACCEPTED at e6a831e36: this PR introduced it.
  //
  // BUILT AS A LITERAL STRING. `join(link, "..", "SIBLING.txt")` collapses the `..` at the CALL SITE,
  // so the guard never sees the case at all — that mismeasurement is why this was first reported as
  // pre-existing rather than as the regression it is.
  const dotdotAfterLink = refusal(() => assertContainedIn(`${link}/../SIBLING.txt`, root));
  check(
    "a `..` after a symlink is applied to the physical prefix, so it cannot walk back into the root",
    dotdotAfterLink !== null && dotdotAfterLink.includes(root),
    dotdotAfterLink,
  );

  // ACCEPT CONTROL, AND THE ONE WITH NO ALARM ATTACHED. Over-refusal is the failure mode a regression
  // cell cannot see: a resolver that refused every unresolvable-looking target would pass all three
  // refusal cells above and silently break every real caller. An INWARD symlink to a directory that
  // genuinely exists resolves fine, and its missing child must still be ACCEPTED.
  const inwardLink = join(root, "inward-link");
  symlinkSync(inside, inwardLink);
  const underInward = refusal(() => assertContainedIn(join(inwardLink, "future"), root));
  check(
    "a missing child under an INWARD symlink that resolves is still allowed",
    underInward === null,
    underInward,
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

  // A `..` in the tail of a MISSING target must not walk back out of the root. This one is textual
  // even under the walking resolver, and soundly so: `not-yet` does not exist, so nothing under it
  // can, and a component with no inode cannot be a symlink. The `..`s are therefore popped from the
  // missing tail rather than applied to the physical prefix, and the result still has to land outside
  // the root and be refused. The symlinked sibling of this case is the cell above, where the `..`
  // follows a link that DOES resolve and so belongs to the prefix.
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

  // POSITIVE CONTROL, AND IT MUST NOT BE THE ONE UNGUARDED CALL IN THE FILE. Every sibling above
  // goes through `refusal()`, so a throw becomes a red cell with a name. This one called
  // `controlEndpoint` bare, so when TEMP_ROOT itself could not fit the byte budget the control threw
  // on the way to proving that short paths are minted, and the suite died with a raw stack from
  // runtime.ts, NO SUMMARY LINE, and its fixture directories still on disk. A control that dies
  // without a summary is worse than one that fails: the shard runner sees no sentinel at all, so the
  // suite reads as infrastructure trouble rather than as a result, and the leak persists.
  //
  // Measured on this Linux box (limit 108, so 64 bytes of root): a 66-byte TMPDIR exits 1 with that
  // raw stack from runtime.ts:57 and leaves the two `cotal-1625-*` fixtures behind. The maintainer
  // measured the same shape on darwin from a 62-byte TMPDIR, which is the shorter figure because
  // sun_path is 104 there. I had swept 50/59/64/66/72 on Linux ONLY, concluded the boundary sat
  // where Linux puts it, and reported the finding as false — asserting a platform constant from one
  // platform, which is the precise mistake this PR already carries a commit to fix.
  //
  // SKIPPED BY NAME rather than attempted, when the budget cannot hold it. A skip that says which
  // root was too long and by how much is a result; a raw stack is not. The figure is read from the
  // platform, never written as a literal.
  const CONTROL_TAIL_BYTES = "/cotal-".length + 32 + ".sock".length;
  const rootBudget = SUN_PATH_LIMIT - CONTROL_TAIL_BYTES;
  const tempRootBytes = Buffer.byteLength(TEMP_ROOT);
  if (tempRootBytes > rootBudget) {
    skip(
      "a control socket path within the limit is still minted",
      `TEMP_ROOT is ${tempRootBytes} bytes and the ${SUN_PATH_LIMIT}-byte sun_path limit on ` +
        `${process.platform} leaves only ${rootBudget} for it (${TEMP_ROOT}), so no path minted under ` +
        `it can be within the limit and this control cannot run. Point TMPDIR at a shorter directory ` +
        `to grade it.`,
    );
  } else {
    process.env.TMPDIR = TEMP_ROOT;
    const minted = refusal(() => controlEndpoint("space", "name"));
    process.env.TMPDIR = originalTmp;
    check(
      "a control socket path within the limit is still minted",
      minted === null,
      minted,
    );
    // Graded separately from the refusal above, so "it did not throw" and "what it returned is
    // actually bindable" cannot pass for each other.
    process.env.TMPDIR = TEMP_ROOT;
    const path = controlEndpoint("space", "name").path;
    process.env.TMPDIR = originalTmp;
    check(
      "the minted control socket path is within the limit and is a .sock",
      Buffer.byteLength(path) <= SUN_PATH_LIMIT && path.endsWith(".sock"),
      path,
    );
  }

  // THE CONTROL'S OWN BEHAVIOUR ON A TOO-LONG ROOT, GRADED RATHER THAN ASSUMED. The two cells above
  // cannot see this: under a short TMPDIR the skip branch never runs, so the guard that makes a
  // too-long root a RESULT instead of a raw stack is invisible to every other cell in the file. That
  // is exactly the state this suite shipped in — the defect was in the one path nothing exercised.
  //
  // So run THIS SUITE as a child under a deliberately over-long TMPDIR and grade what the shard
  // runner would actually see: a zero exit, the sentinel summary line, a skip that names itself, and
  // no fixture left behind. `COTAL_1626_OVERLONG_CHILD` fences the recursion to one level.
  if (!process.env.COTAL_1626_OVERLONG_CHILD) {
    // Built INSIDE the fixture root, so the `finally` below removes it with everything else.
    let overlongRoot = join(root, "overlong");
    while (Buffer.byteLength(overlongRoot) <= rootBudget) overlongRoot += "o";
    mkdirSync(overlongRoot, { recursive: true });
    const child = spawnSync(process.execPath, [...process.execArgv, ...[process.argv[1]]], {
      env: { ...process.env, TMPDIR: overlongRoot, COTAL_1626_OVERLONG_CHILD: "1" },
      encoding: "utf8",
    });
    const out = `${child.stdout ?? ""}${child.stderr ?? ""}`;
    check(
      "under a TMPDIR too long for the socket budget the suite still reports a result, skipping the control by name",
      child.status === 0
        && /TEMP CONTAINMENT SMOKE OK\b/.test(out)
        && /1 skipped/.test(out)
        && /⊘ SKIP: a control socket path within the limit is still minted/.test(out)
        && out.includes(`${SUN_PATH_LIMIT}-byte sun_path limit`),
      `status=${child.status} signal=${child.signal}\n${out.slice(-1200)}`,
    );
    // The measured failure left three entries under the temp root. A skip that leaks is not a skip.
    const leaked = readdirSync(overlongRoot).filter((n) => n.startsWith("cotal-1625-"));
    check(
      "a skipped control tears its fixture down, leaving nothing behind",
      leaked.length === 0,
      leaked,
    );
  }
} catch (e) {
  // A throw ESCAPING the body is itself a failure with a name, not a reason to lose the summary.
  // Recorded as a red cell so `fail` is non-zero, the sentinel line still prints, and the `finally`
  // below still tears the fixture down.
  check(
    "the suite body ran to completion without an unhandled throw",
    false,
    `${(e as Error).message}\n${(e as Error).stack ?? ""}`,
  );
} finally {
  // TEARDOWN IN `finally`, so a skip or a throw cannot leak the fixture. The measured failure left
  // three entries under the temp root; nothing above this line is allowed to skip it.
  process.env.TMPDIR = originalTmp;
  removeContained(root, TEMP_ROOT, "1625 fixture root");
  removeContained(outside, TEMP_ROOT, "1625 fixture outside-root");
}

// PRINTED UNCONDITIONALLY, from outside the `try`. The sentinel line is what the shard runner reads;
// a suite that dies before emitting it reports no result at all rather than a failure, which is how
// the unguarded control above turned a too-long TMPDIR into apparent infrastructure trouble.
console.log(
  `\nTEMP CONTAINMENT SMOKE ${fail === 0 ? "OK" : "FAILED"} (${pass} passed, ${fail} failed` +
    `${skipped ? `, ${skipped} skipped` : ""})`,
);
if (fail) process.exitCode = 1;
