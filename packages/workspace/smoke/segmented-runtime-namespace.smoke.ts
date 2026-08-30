/**
 * The runtime pid/log namespace is PER-SPACE. Hermetic — no broker, no network, no child processes.
 *
 * `auth-service.{space}.pid` was templated; `manager.pid`, `manager.log`, `manager.delivery-aware`,
 * `delivery.pid` and `delivery.log` were root-scoped constants. One workspace root therefore hosted
 * exactly one manager and one delivery daemon BY FILENAME: a second space booting in the same root
 * overwrote the first space's record, and every reader of that file then answered about the wrong
 * process. The `{space}` seam in `local-process.ts` already existed and already carried the
 * injective, case-safe hex key; these five records simply did not go through it.
 *
 * What this asserts:
 *
 *  1. THE NAMESPACE IS PER-SPACE. Two spaces on one root resolve five DIFFERENT records, and two
 *     spaces differing only in case resolve different records too (the hex key is why — a
 *     case-folding filesystem must not alias `alpha` onto `Alpha`).
 *
 *  2. THE UPGRADE DOES NOT ORPHAN A DAEMON. A root written by a pre-segmentation build holds
 *     `manager.pid` at the root. `status`/`down`/`up` READ through this seam, so the pre-upgrade
 *     name is admitted and the live daemon behind it is still found, stopped and reported. Byte-
 *     exact, never a case-folding `existsSync`.
 *
 *  3. AMBIGUITY FAILS LOUD. Canonical AND pre-segmentation both present is a state this cannot
 *     arbitrate, so it throws rather than silently picking one — the same rule the pre-hex
 *     auth-service shim already keeps, and the reason the start path reclaims a dead legacy record
 *     instead of leaving it beside the canonical one it just wrote.
 *
 *  4. `RESERVED_COTAL_CHILDREN` REFLECTS THE NEW REALITY. It lists the LITERAL children of
 *     `.cotal/`, and the five runtime records are no longer among them.
 *
 *  5. THE FOLDER'S SPACE COMES FROM THE RECORDS IT HOLDS. A root's space is otherwise read from its
 *     `.cotal/auth` account records, and an OPEN mesh has none - so that read answers with the
 *     default while the daemons here run under the mesh's own space. Space-blind names hid it; a
 *     per-space name does not, and a folder-wide `down` that cannot name the space walks past a live
 *     manager. The record filenames decode back to their space, residue never wedges the folder, and
 *     two spaces genuinely running under one root is refused rather than arbitrated.
 *
 * Run: pnpm smoke:segmented-runtime-namespace
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spaceKey } from "../src/auth-paths.js";
import {
  canonicalLocalProcessPath, DELIVERY_PIDFILE, localProcessPath, MANAGER_DELIVERY_AWARE_MARKER,
  MANAGER_PIDFILE, type LocalProcessContext,
} from "../src/local-process.js";
import { resolveRuntimeSpace, resolveSpace } from "../src/space.js";
import { RESERVED_COTAL_CHILDREN } from "../src/space-segmentation.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const rejects = (name: string, fn: () => unknown, mustInclude: string[]) => {
  try {
    fn();
    check(`${name} (did not throw)`, false);
  } catch (e) {
    const msg = (e as Error).message;
    const missing = mustInclude.filter((s) => !msg.includes(s));
    check(name, missing.length === 0, { missing, msg });
  }
};

const roots: string[] = [];
function makeRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `cotal-segrt-${label}-`));
  mkdirSync(join(root, ".cotal"), { recursive: true });
  roots.push(root);
  return root;
}
const ctx = (root: string, space: string): LocalProcessContext => ({ root, space });

try {
  console.log("1) the runtime record namespace is per-space");
  {
    const root = makeRoot("perspace");
    const alpha = ctx(root, "alpha"), beta = ctx(root, "beta");
    check(
      "manager.pid resolves to a DIFFERENT record for a second space on the same root",
      localProcessPath(MANAGER_PIDFILE, alpha) !== localProcessPath(MANAGER_PIDFILE, beta),
      { alpha: localProcessPath(MANAGER_PIDFILE, alpha), beta: localProcessPath(MANAGER_PIDFILE, beta) },
    );
    check(
      "the delivery-aware marker is per-space too (it names a pid, so a shared name mis-pairs it)",
      localProcessPath(MANAGER_DELIVERY_AWARE_MARKER, alpha) !== localProcessPath(MANAGER_DELIVERY_AWARE_MARKER, beta),
      { alpha: localProcessPath(MANAGER_DELIVERY_AWARE_MARKER, alpha) },
    );
    check(
      "the manager record carries this space's injective hex key",
      localProcessPath(MANAGER_PIDFILE, alpha).includes(spaceKey("alpha")),
      localProcessPath(MANAGER_PIDFILE, alpha),
    );
  }

  console.log("\n2) case-differing spaces never share a record (the hex key is why)");
  {
    const root = makeRoot("case");
    check(
      "\"alpha\" and \"Alpha\" resolve different manager records",
      localProcessPath(MANAGER_PIDFILE, ctx(root, "alpha")) !== localProcessPath(MANAGER_PIDFILE, ctx(root, "Alpha")),
      localProcessPath(MANAGER_PIDFILE, ctx(root, "alpha")),
    );
  }

  console.log("\n3) a pre-segmentation root-scoped record is still found (the upgrade path)");
  {
    const root = makeRoot("legacy");
    // Exactly what a pre-segmentation build left behind: the record at the ROOT of `.cotal/`.
    writeFileSync(join(root, ".cotal", "manager.pid"), "4242");
    const resolved = localProcessPath(MANAGER_PIDFILE, ctx(root, "alpha"));
    check(
      "with ONLY the pre-segmentation record present, the seam resolves to it",
      resolved === join(root, ".cotal", "manager.pid"),
      resolved,
    );
  }

  console.log("\n4) canonical AND pre-segmentation both present fails loud");
  {
    const root = makeRoot("ambiguous");
    writeFileSync(join(root, ".cotal", "manager.pid"), "4242");
    writeFileSync(join(root, ".cotal", `manager.${spaceKey("alpha")}.pid`), "4243");
    rejects(
      "both records present is ambiguous and throws rather than picking one",
      () => localProcessPath(MANAGER_PIDFILE, ctx(root, "alpha")),
      ["manager.pid", "ambiguous"],
    );
  }

  console.log("\n5) RESERVED_COTAL_CHILDREN reflects the new reality");
  {
    const gone = ["manager.pid", "manager.log", "manager.delivery-aware", "delivery.pid", "delivery.log"];
    for (const name of gone)
      check(
        `"${name}" is no longer a literal child of .cotal/`,
        !RESERVED_COTAL_CHILDREN.includes(name),
        RESERVED_COTAL_CHILDREN,
      );
  }

  console.log("\n6) the folder's runtime space is read off the records it holds");
  {
    // A LIVE record: this process, which is beyond doubt running. A DEAD one: a pid far above any
    // platform's pid_max, so the kernel answers ESRCH rather than "maybe".
    const LIVE = String(process.pid), DEAD = "999999999";
    const place = (root: string, template: string, space: string, pid: string) =>
      writeFileSync(canonicalLocalProcessPath(template, ctx(root, space)), pid);
    {
      const root = makeRoot("openmode");
      check(
        "with no records and no account material, it is the folder's own space",
        resolveRuntimeSpace(root) === resolveSpace(root),
        { runtime: resolveRuntimeSpace(root), folder: resolveSpace(root) },
      );
      place(root, MANAGER_PIDFILE, "beta", LIVE);
      check(
        "a live manager record NAMES its space, where the account-derived read cannot",
        resolveRuntimeSpace(root) === "beta" && resolveSpace(root) !== "beta",
        { runtime: resolveRuntimeSpace(root), folder: resolveSpace(root) },
      );
    }
    {
      const root = makeRoot("deliveryonly");
      place(root, DELIVERY_PIDFILE, "gamma", LIVE);
      check("a delivery record names its space too", resolveRuntimeSpace(root) === "gamma", resolveRuntimeSpace(root));
    }
    {
      const root = makeRoot("deadonly");
      place(root, MANAGER_PIDFILE, "delta", DEAD);
      check(
        "a DEAD record still names its space, so a stop can clear it",
        resolveRuntimeSpace(root) === "delta",
        resolveRuntimeSpace(root),
      );
    }
    {
      const root = makeRoot("residue");
      place(root, MANAGER_PIDFILE, "dead-one", DEAD);
      place(root, MANAGER_PIDFILE, "live-one", LIVE);
      check(
        "crash residue beside a running space does not wedge the folder - the live one answers",
        resolveRuntimeSpace(root) === "live-one",
        resolveRuntimeSpace(root),
      );
    }
    {
      const root = makeRoot("twolive");
      place(root, MANAGER_PIDFILE, "one", LIVE);
      place(root, DELIVERY_PIDFILE, "two", LIVE);
      rejects(
        "two spaces RUNNING under one root is refused, naming both",
        () => resolveRuntimeSpace(root),
        ["running daemons for 2 spaces", "one", "two"],
      );
    }
    {
      const root = makeRoot("strays");
      // Nothing that is not a name a canonical write produced may be read as a tenant: a
      // pre-segmentation root-scoped record (which names NO space and is found through the candidate
      // list instead), a non-hex body, an odd-length body, a body that is not UTF-8, and a LOG, which
      // holds text and not a pid.
      writeFileSync(join(root, ".cotal", "manager.pid"), LIVE);
      writeFileSync(join(root, ".cotal", "manager.notahexkey.pid"), LIVE);
      writeFileSync(join(root, ".cotal", "manager.abc.pid"), LIVE);
      // Well-formed hex that is not UTF-8: it decodes to a replacement character, so it round-trips
      // to a DIFFERENT key. Reading it as a tenant would name a space no writer here can produce.
      writeFileSync(join(root, ".cotal", "manager.ff.pid"), LIVE);
      writeFileSync(join(root, ".cotal", `manager.${spaceKey("logspace")}.log`), LIVE);
      check(
        "strays and pre-upgrade names are not read as spaces",
        resolveRuntimeSpace(root) === resolveSpace(root),
        resolveRuntimeSpace(root),
      );
      check(
        "...and the pre-upgrade record is still what the folder's space resolves to",
        localProcessPath(MANAGER_PIDFILE, ctx(root, resolveRuntimeSpace(root))) === join(root, ".cotal", "manager.pid"),
      );
    }
  }
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "✓" : "✗"} segmented-runtime-namespace: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
