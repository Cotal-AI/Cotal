/**
 * DELIVERY-LEASE READ GRANT SMOKE (#1576).
 *
 * WHY THIS FILE EXISTS: it was the one source I changed with NO cell of its own. Every other file in
 * this change has a suite; `provision.ts` had a two-line grant and nothing reading it. That is the
 * shape this whole issue is about (a claim nobody checks), so the gap is closed rather than noted.
 *
 * WHAT THE GRANT IS FOR. The operator-facing surfaces must be able to answer "is the delivery
 * responder bound", and the only fact that answers it is the shard-0 readiness lease. A read-only
 * diagnostic credential that cannot read that key can only report the daemon's PROCESS, which is
 * exactly the green-while-broken surface the reporter watched for 22 hours. So `observer` and
 * `admin` carry STREAM.INFO + STREAM.MSG.GET on the delivery bucket.
 *
 * AND THE HALF THAT MATTERS MORE: it must stay READ-ONLY, and it must not leak to agents. The lease
 * has exactly one writer, the `delivery` credential, because a second writer would let two daemons
 * split a durable's delivery. A grant added for visibility that quietly widened write authority
 * would trade a reporting bug for a correctness bug, so both directions are cells here: the
 * capability IS present where a diagnostic needs it, and the write is ABSENT everywhere.
 *
 * This measured a real refusal, not a hypothetical: before the grant existed, `status --components`
 * on an observer credential returned `lease probe refused: permissionsFor ...` rather than a verdict.
 */
import assert from "node:assert/strict";
import { permissionsFor, deliveryBucket, DEV_OWNER, mintLifecycleUid } from "@cotal-ai/core";
import { emitSentinel } from "@cotal-ai/smoke-kit";

const SPACE = "leasegrant";
const DLVKV = `KV_${deliveryBucket(SPACE)}`;
const pr = { owner: DEV_OWNER, actor: "leasegrant", connId: "conn0123456789abcdef", lifecycleUid: mintLifecycleUid() };

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra === undefined ? "" : JSON.stringify(extra)); }
};

/** The `pub.allow` rows a profile mints with. `permissionsFor` takes a MintOpts fourth argument;
 *  the lifecycle uid rides both the principal and the opts, as the operator instruments do.
 *  `deprovisioner` additionally REFUSES to mint without the departed incarnation it is pinned to,
 *  so that is supplied rather than dropping the profile from the sweep: a profile skipped because it
 *  was awkward to construct is a profile nobody is checking. */
function pubRows(profile: string): string[] {
  // A profile that REFUSES to mint without its pin is supplied one rather than dropped from the
  // sweep: a profile skipped because it was awkward to construct is a profile nobody is checking.
  // `remote-manager` additionally pins the actor to the server-selected `manager_<instanceId>`, so
  // the principal is rebuilt to match rather than the pin bent to fit the shared one.
  const extra = profile === "deprovisioner"
    ? { deprovisionTarget: { principal: `${DEV_OWNER}.departed`, lifecycleUid: pr.lifecycleUid } }
    : profile === "remote-manager"
      ? { remoteManager: { instanceId: pr.lifecycleUid, owner: DEV_OWNER, actor: `manager_${pr.lifecycleUid}` } }
      : {};
  const principal = profile === "remote-manager"
    ? { ...pr, actor: `manager_${pr.lifecycleUid}` }
    : pr;
  const perms = permissionsFor(
    profile as Parameters<typeof permissionsFor>[0],
    SPACE,
    principal as never,
    { lifecycleUid: pr.lifecycleUid, ...extra } as never,
  ) as { pub?: { allow?: string[]; deny?: string[] } };
  return perms.pub?.allow ?? [];
}

/** NATS subject matching, so a row is judged by what it AUTHORIZES rather than by its spelling: a
 *  wildcard row that happens not to contain the literal bucket name still grants it. */
function subjectMatches(pattern: string, subject: string): boolean {
  const p = pattern.split("."), s = subject.split(".");
  for (let i = 0; i < p.length; i++) {
    if (p[i] === ">") return s.length > i;
    if (i >= s.length) return false;
    if (p[i] !== "*" && p[i] !== s[i]) return false;
  }
  return p.length === s.length;
}
const grants = (rows: string[], subject: string) => rows.some((r) => subjectMatches(r, subject));

// The exact subjects a KV point-read needs, and the ones a WRITE would need.
const READ_INFO = `$JS.API.STREAM.INFO.${DLVKV}`;
const READ_GET = `$JS.API.STREAM.MSG.GET.${DLVKV}`;
const WRITE_PUT = `$KV.${deliveryBucket(SPACE)}.lease.0`;
const WRITE_DELETE = `$JS.API.STREAM.DELETE.${DLVKV}`;
const WRITE_PURGE = `$JS.API.STREAM.PURGE.${DLVKV}`;

console.log("DELIVERY-LEASE READ GRANT (#1576)\n");

// ---------- the capability, for the profiles a human diagnostic actually runs as ----------
for (const profile of ["observer", "admin"]) {
  const rows = pubRows(profile);
  check(`CELL: \`${profile}\` can read the delivery lease record (STREAM.MSG.GET)`,
    grants(rows, READ_GET), { profile, DLVKV });
  check(`CELL: \`${profile}\` can see the delivery bucket at all (STREAM.INFO)`,
    grants(rows, READ_INFO), { profile, DLVKV });
}

// ---------- the confinement: visibility must not have widened the WRITE authority ----------
// The lease has exactly one writer by design. If a diagnostic profile could write it, a monitoring
// command could claim or clobber the single-flight slot and split a durable's delivery.
for (const profile of ["observer", "admin"]) {
  const rows = pubRows(profile);
  check(`CELL: \`${profile}\` CANNOT write the lease key (one writer: the delivery cred)`,
    !grants(rows, WRITE_PUT), { profile, offenders: rows.filter((r) => subjectMatches(r, WRITE_PUT)) });
  check(`CELL: \`${profile}\` CANNOT delete the delivery bucket`,
    !grants(rows, WRITE_DELETE), { profile, offenders: rows.filter((r) => subjectMatches(r, WRITE_DELETE)) });
  check(`CELL: \`${profile}\` CANNOT purge the delivery bucket`,
    !grants(rows, WRITE_PURGE), { profile, offenders: rows.filter((r) => subjectMatches(r, WRITE_PURGE)) });
}

// ---------- the manager's own read, and the same confinement over it ----------
// The supervisor credential is the manager's always-on connection, and the daemon-store challenge
// now settles two questions from the lease row rather than from the rail: does anything hold this
// space's shard, and is the process that answered the queue-grouped admin rail that holder. Both
// were previously taken from what a responder sent, and the rail is served by whichever permitted
// responder the broker picks. Without this grant the manager cannot establish either fact itself and
// the challenge falls back to a report; with it, the challenge is a measurement.
//
// `remote-manager` carries it for the same reason: it runs the identical challenge.
for (const profile of ["supervisor", "remote-manager"]) {
  const rows = pubRows(profile);
  check(`CELL: \`${profile}\` can read the delivery lease record (the challenge verifies the holder itself)`,
    grants(rows, READ_GET), { profile, DLVKV });
  check(`CELL: \`${profile}\` can see the delivery bucket at all (STREAM.INFO)`,
    grants(rows, READ_INFO), { profile, DLVKV });
  // THE HALF THAT MATTERS MORE, and the reason this grant is a point-read pair rather than a
  // convenience: a credential that could WRITE the row could manufacture the very fact the challenge
  // reads, which would put the determination back in the hands of a participant.
  check(`CELL: \`${profile}\` CANNOT write the lease key (reading a claim must never become authority to make one)`,
    !grants(rows, WRITE_PUT), { profile, offenders: rows.filter((r) => subjectMatches(r, WRITE_PUT)) });
  check(`CELL: \`${profile}\` CANNOT delete the delivery bucket`,
    !grants(rows, WRITE_DELETE), { profile, offenders: rows.filter((r) => subjectMatches(r, WRITE_DELETE)) });
  check(`CELL: \`${profile}\` CANNOT purge the delivery bucket`,
    !grants(rows, WRITE_PURGE), { profile, offenders: rows.filter((r) => subjectMatches(r, WRITE_PURGE)) });
}

// ---------- the blast radius: a read grant for operators is not a grant for every agent ----------
// REFUSE CONTROL in the other direction. `provisioner` and `deprovisioner` are one-shot setup
// windows, not diagnostics; if the row had been added to a shared array rather than the elevated
// read-only arm, it would have leaked here and these cells say so by name.
for (const profile of ["provisioner", "deprovisioner"]) {
  const rows = pubRows(profile);
  check(`REFUSE CONTROL: \`${profile}\` did not silently inherit the lease READ grant`,
    !grants(rows, READ_GET), { profile, offenders: rows.filter((r) => subjectMatches(r, READ_GET)) });
}

// ---------- the writer keeps its write ----------
// The mirror of the confinement cells: proving nobody can write is worthless if the daemon lost its
// own authority in the process, because then the fix would have broken delivery itself.
const deliveryRows = pubRows("delivery");
check("CELL: the `delivery` credential DOES keep its lease write (the single writer is intact)",
  grants(deliveryRows, WRITE_PUT), { offendersSeen: deliveryRows.filter((r) => r.includes(deliveryBucket(SPACE))).slice(0, 6) });

// ---------- the grant is real, not a string that happens to contain the bucket name ----------
// A row is only a grant if it MATCHES as a subject. This cell fails if the implementation ever
// switches to a spelling that reads plausibly but authorizes nothing.
const observerRows = pubRows("observer");
check("CELL: the observer grant is subject-matched, not merely text present in some row",
  observerRows.some((r) => subjectMatches(r, READ_GET)) &&
    observerRows.filter((r) => subjectMatches(r, READ_GET)).every((r) => r.includes(DLVKV) || r.includes("*") || r.includes(">")),
  observerRows.filter((r) => subjectMatches(r, READ_GET)));

console.log(fail === 0
  ? `\nDELIVERY-LEASE GRANT SMOKE OK ✅  (${pass} passed, ${fail} failed)`
  : `\nDELIVERY-LEASE GRANT SMOKE FAILED ❌  (${pass} passed, ${fail} failed)`);
emitSentinel({ passed: pass, failed: fail });
process.exitCode = fail === 0 ? 0 : 1;
assert.ok(pass > 0, "the suite ran at least one cell");
