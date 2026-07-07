/**
 * `cotal doctor auth` smoke (D5 slice 6) — broker-free. Two layers:
 *
 *  1. `inspectCredHealth` (core) is pinned pure: healthy / near-expiry (past 75% of iat→exp) /
 *     expired / unbounded / unreadable, with an injected clock.
 *  2. The doctor command runs against a STAGED `.cotal` folder (real crypto: createSpaceAuth +
 *     mintCreds): an expired delivery cred and an unbounded standing membership-rw cred are
 *     problems with exact repairs; a static agent cred is NOT a problem (pre-flip, dim); a missing
 *     file is a note, not a failure. `--fix` re-signs the class-2 files for their EXISTING nkeys
 *     (the identity pin) and the re-diagnosis ends `healthy`.
 *
 * Run: pnpm smoke:doctor-auth
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSpaceAuth,
  idFromCreds,
  inspectCredHealth,
  mintCreds,
  mintMembershipObserverCreds,
  newIdentity,
} from "@cotal-ai/core";
import { saveSpaceAuth } from "@cotal-ai/workspace";
import { doctor } from "../src/commands/doctor.js";

let pass = 0,
  fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

// ── 1. inspectCredHealth: pure-state pins with an injected clock ─────────────────────────────────
const auth = await createSpaceAuth("doctor-smoke");
const sysObserver = await mintMembershipObserverCreds(auth, newIdentity()); // while the $SYS seed is in memory
const now = Math.floor(Date.now() / 1000);
const bounded = await mintCreds(auth, newIdentity(), "probe", { expiresInSeconds: 100 }); // iat=now, exp=now+100
check("healthy before the 75% renewal point", inspectCredHealth(bounded, now + 60).state === "healthy");
check("near-expiry past the 75% renewal point", inspectCredHealth(bounded, now + 80).state === "near-expiry");
check("expired at/after exp", inspectCredHealth(bounded, now + 100).state === "expired");
check("renewAt is 75% of the iat→exp lifetime", Math.abs(inspectCredHealth(bounded, now).renewAt! - (now + 75)) <= 2, inspectCredHealth(bounded, now));
const unbounded = await mintCreds(auth, newIdentity(), "agent");
check("unbounded when the JWT has no exp", inspectCredHealth(unbounded, now).state === "unbounded");
check("unreadable on garbage (reported, not thrown)", inspectCredHealth("not a creds file", now).state === "unreadable");

// ── 2. the doctor against a staged folder ────────────────────────────────────────────────────────
const root = mkdtempSync(join(tmpdir(), "cotal-doctor-"));
mkdirSync(join(root, ".cotal", "auth", "creds"), { recursive: true });
saveSpaceAuth(join(root, ".cotal", "auth"), auth);

// delivery: EXPIRED (broker-dead) — a problem with the --fix repair.
const dlvId = newIdentity();
writeFileSync(join(root, ".cotal", "delivery.creds"), await mintCreds(auth, dlvId, "delivery", { expiresAt: now - 10 }), { mode: 0o600 });
// membership-rw: UNBOUNDED standing cred (pre-slice-5 mint shape) — a problem.
const rwId = newIdentity();
writeFileSync(join(root, ".cotal", "membership-rw.creds"), await mintCreds(auth, rwId, "agent"), { mode: 0o600 });
// $SYS observer: healthy (bounded 30d at mint). connection-evictor deliberately MISSING (a note).
writeFileSync(join(root, ".cotal", "membership-observer.creds"), sysObserver, { mode: 0o600 });
// A static agent cred: unbounded is EXPECTED pre-flip — never a problem.
writeFileSync(join(root, ".cotal", "auth", "creds", "alice.creds"), unbounded, { mode: 0o600 });
// User-auth managed-agent sentinel: deny-all callout-account bearer plumbing, NOT a static agent cred.
writeFileSync(join(root, ".cotal", "auth", "creds", "alpha.sentinel.creds"), unbounded, { mode: 0o600 });

const origCwd = process.cwd();
const origLog = console.log;
const origErr = console.error;
function runDoctor(argvValues: Record<string, boolean | string | undefined>): Promise<{ out: string; code: number | undefined }> {
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
  process.exitCode = undefined;
  process.chdir(root);
  return doctor({ values: argvValues, positionals: ["auth"], raw: [] })
    .then(() => ({ out: lines.join("\n"), code: process.exitCode as number | undefined }))
    .finally(() => {
      console.log = origLog;
      console.error = origErr;
      process.chdir(origCwd);
      process.exitCode = 0;
    });
}

try {
  const first = await runDoctor({});
  check("diagnosis exits non-zero with problems", first.code === 1, first.code);
  check("expired delivery cred is a problem", first.out.includes("delivery.creds") && first.out.includes("EXPIRED"), first.out);
  check("unbounded standing membership-rw is a problem", first.out.includes("unbounded standing credential"), first.out);
  check("every problem names an exact next command", first.out.includes("next:") && first.out.includes("doctor auth --fix"), first.out);
  check("missing connection-evictor is a note, not a failure", first.out.includes("not provisioned here"), first.out);
  check("static agent cred is NOT a problem (pre-flip)", !first.out.includes("alice.creds:"), first.out);
  check("user-auth sentinel cred is not rendered as a static agent cred", !first.out.includes("alpha.sentinel.creds"), first.out);
  check("$SYS observer renders healthy with expiry", /healthy\s+membership-observer/.test(first.out.replace(/\[[0-9;]*m/g, "")), first.out);

  const fixed = await runDoctor({ fix: true });
  check("--fix ends healthy (exit 0)", fixed.code === undefined && fixed.out.includes("auth: healthy"), `${fixed.code} ${fixed.out.slice(-300)}`);
  // The audit line must not contradict itself: files WERE re-signed, so a record without an
  // explicit daemon adoption renders as "not requested" (backstop applies), never "nothing
  // re-signed" (the slice-6 UX-review catch).
  check(
    "--fix renewal record says adoption was not requested, not 'nothing re-signed'",
    fixed.out.includes("adoption not requested") && !fixed.out.includes("nothing re-signed"),
    fixed.out,
  );
  const dlvAfter = readFileSync(join(root, ".cotal", "delivery.creds"), "utf8");
  const rwAfter = readFileSync(join(root, ".cotal", "membership-rw.creds"), "utf8");
  check("--fix re-signed delivery for the SAME nkey (identity pin)", idFromCreds(dlvAfter) === dlvId.id);
  check("--fix re-signed membership-rw for the SAME nkey", idFromCreds(rwAfter) === rwId.id);
  check("--fix bounded the previously-unbounded membership-rw", inspectCredHealth(rwAfter).state === "healthy", inspectCredHealth(rwAfter));

  const wrongSub = await (async () => {
    const lines: string[] = [];
    console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
    process.exitCode = undefined;
    await doctor({ values: {}, positionals: [], raw: [] });
    const code = process.exitCode as number | undefined;
    console.error = origErr;
    process.exitCode = 0;
    return { out: lines.join("\n"), code };
  })();
  check("`doctor` without `auth` is a loud usage error", wrongSub.code === 1 && wrongSub.out.includes("doctor auth"), wrongSub);

  console.log(fail === 0 ? `\nDOCTOR-AUTH SMOKE OK ✅  (${pass} passed, ${fail} failed)` : `\nDOCTOR-AUTH SMOKE FAILED ❌  (${pass} passed, ${fail} failed)`);
  process.exitCode = fail === 0 ? 0 : 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
