/**
 * THE MANAGER'S OWN RECORD IS PER-SPACE. Hermetic — no broker, no network, no child processes.
 *
 * `recordManagerPid` is the supervise-side writer: whatever started this manager (the CLI's detached
 * re-exec, a container entrypoint, `cotal supervise` typed by hand), this is what puts its pid on
 * disk for `status`, `down` and the delivery preflight to find. It used to write one root-scoped
 * `manager.pid` and `manager.delivery-aware`, so a second manager supervising a second space in the
 * same workspace root overwrote the first one's record and every local reader then answered about
 * the wrong process.
 *
 * What this asserts, against the SHIPPED writer:
 *  1. Two spaces in one root produce two records, and the release closure removes only its own.
 *  2. An upgraded root does not end up holding the old name beside the new one: a DEAD pre-upgrade
 *     record is reclaimed as the manager records itself.
 *  3. A LIVE pre-upgrade record is refused rather than overwritten. The old code overwrote it and
 *     orphaned that manager; refusing is the only answer that does not lose a running process.
 *
 * Run: pnpm smoke:record-manager-pid-per-space
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalLocalProcessPath, MANAGER_DELIVERY_AWARE_MARKER, MANAGER_PIDFILE } from "@cotal-ai/workspace";
import { recordManagerPid } from "../src/commands.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const roots: string[] = [];
function makeRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `cotal-recpid-${label}-`));
  mkdirSync(join(root, ".cotal"), { recursive: true });
  roots.push(root);
  return root;
}
const record = (template: string, root: string, space: string) => canonicalLocalProcessPath(template, { root, space });
const children = (root: string) => readdirSync(join(root, ".cotal")).sort();

try {
  console.log("1) two spaces supervised from one root record separately");
  {
    const root = makeRoot("two");
    const releaseAlpha = recordManagerPid(root, "alpha");
    const releaseBeta = recordManagerPid(root, "beta");
    const alphaPid = record(MANAGER_PIDFILE, root, "alpha"), betaPid = record(MANAGER_PIDFILE, root, "beta");
    check("alpha and beta write DIFFERENT pid records", alphaPid !== betaPid, children(root));
    check("both records exist after both managers recorded themselves",
      existsSync(alphaPid) && existsSync(betaPid), children(root));
    check("each record holds this process's pid, so both were actually written",
      readFileSync(alphaPid, "utf8") === String(process.pid) && readFileSync(betaPid, "utf8") === String(process.pid));
    check("each space also gets its own delivery-aware marker",
      existsSync(record(MANAGER_DELIVERY_AWARE_MARKER, root, "alpha")) && existsSync(record(MANAGER_DELIVERY_AWARE_MARKER, root, "beta")));
    releaseAlpha();
    check("alpha's release removes alpha's records", !existsSync(alphaPid) && !existsSync(record(MANAGER_DELIVERY_AWARE_MARKER, root, "alpha")));
    check("...and leaves beta's alone — the overwrite this change removes", existsSync(betaPid), children(root));
    releaseBeta();
    check("beta's release then clears the root", children(root).length === 0, children(root));
  }

  console.log("\n2) an upgraded root does not keep the pre-upgrade record beside the new one");
  {
    const root = makeRoot("upgrade");
    // A pre-segmentation build recorded a manager here and the process is long gone: the ordinary
    // state of any existing single-space mesh at the moment it upgrades.
    writeFileSync(join(root, ".cotal", "manager.pid"), "999999999");
    writeFileSync(join(root, ".cotal", "manager.delivery-aware"), "999999999");
    const release = recordManagerPid(root, "alpha");
    check("the dead pre-upgrade records are reclaimed",
      !existsSync(join(root, ".cotal", "manager.pid")) && !existsSync(join(root, ".cotal", "manager.delivery-aware")), children(root));
    check("...and the manager is recorded under its space", existsSync(record(MANAGER_PIDFILE, root, "alpha")), children(root));
    release();
  }

  console.log("\n3) a LIVE pre-upgrade manager is refused, never overwritten");
  {
    const root = makeRoot("live");
    // This process stands in for the running pre-upgrade manager: a pid that is provably alive.
    writeFileSync(join(root, ".cotal", "manager.pid"), String(process.pid));
    try {
      recordManagerPid(root, "alpha");
      check("recording refuses while a pre-upgrade manager is live (did not throw)", false, children(root));
    } catch (e) {
      const msg = (e as Error).message;
      check("recording refuses while a pre-upgrade manager is live",
        /pre-upgrade process is already running/.test(msg) && /cotal down/.test(msg), msg);
    }
    check("...and nothing was written over it", readFileSync(join(root, ".cotal", "manager.pid"), "utf8") === String(process.pid));
    check("...and no canonical record was left behind by the refused start", !existsSync(record(MANAGER_PIDFILE, root, "alpha")), children(root));
  }
} finally {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "✓" : "✗"} record-manager-pid-per-space: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
