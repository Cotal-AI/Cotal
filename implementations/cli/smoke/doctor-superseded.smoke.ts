/**
 * SUPERSEDED-CREDENTIAL RECONCILIATION SMOKE (#1576 asks 2 and 3) — broker-free.
 *
 * THE REPORTED HARM, TWICE OVER. After a delivery daemon re-minted a 30-agent fleet's credentials,
 * `cotal doctor auth` reported 15 of the superseded FILES left on disk as
 * "EXPIRED - the broker denies this credential", for agents that were demonstrably healthy and
 * present in `cotal endpoints`, and told the operator to `respawn the agent` for each. Both halves
 * were wrong in the same direction: the fleet was fine, and following the remedy would have
 * destroyed 18 live sessions holding working context to fix nothing.
 *
 * WHY THE FILE GRAMMAR IS THE EVIDENCE, not a heuristic. An endpoint-provisioned incarnation's secret
 * family is named `<alias>.<lifecycleUid>.creds`, and the standing-name encoder REFUSES `.` inside an
 * alias, so the two families are structurally disjoint: two files sharing an alias with different
 * lifecycle uids are necessarily two incarnations of one agent, and the newer `iat` is the live one.
 * The doctor therefore needs no mesh connection to know which file is a husk — which matters, because
 * `doctor auth` is the OFFLINE credential surface and may not mint on a user-auth mesh.
 *
 * CELLS, EACH RED WITHOUT THE FIX:
 *   CELL 1  a superseded incarnation is NOT a problem and does NOT break the verdict.
 *           Before: `auth: 2 cred problems`, exit 1, on a healthy fleet.
 *   CELL 2  it is still VISIBLE, named as superseded, with a cleanup that is not a respawn.
 *           (A fix that merely hid the row would pass cell 1 and fail this.)
 *   CELL 3  the remedy for a recoverable credential says the daemon re-mints it and NOT to respawn.
 *   CELL 4  REFUSE CONTROLS: a LONE expired incarnation is still a problem with a real remedy, and an
 *           UNREADABLE credential still says respawn — the one case where respawn was ever right.
 *           Without these, "stop saying respawn" could be implemented by never saying it.
 *
 * Run: pnpm smoke:doctor-superseded
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpaceAuth, mintCreds, mintLifecycleUid, newIdentity } from "@cotal-ai/core";
import { agentCredsDir, saveSpaceAuth } from "@cotal-ai/workspace";
import { emitSentinel } from "@cotal-ai/smoke-kit";
import { doctor } from "../src/commands/doctor.js";

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

const SPACE = "doctor-superseded";
const auth = await createSpaceAuth(SPACE);
const now = Math.floor(Date.now() / 1000);
const root = mkdtempSync(join(tmpdir(), "cotal-doctor-superseded-"));
mkdirSync(join(root, ".cotal", "auth", "creds"), { recursive: true });
saveSpaceAuth(join(root, ".cotal", "auth"), auth);

const credsDir = agentCredsDir(root, SPACE);
mkdirSync(credsDir, { recursive: true });

/** Mint a real agent credential for one incarnation. `iat` ordering is what marks the successor, so
 *  the live file is minted with a LATER issued-at than the husk rather than merely a later expiry. */
const incarnation = async (opts: { expiresAt: number }) =>
  mintCreds(auth, newIdentity(), "agent", { lifecycleUid: mintLifecycleUid(), expiresAt: opts.expiresAt });

// worker: a live incarnation plus the husk of the one it replaced. This is the reporter's shape.
//
// THE UIDS ARE CHOSEN SO THAT "FIRST FILE SEEN" IS THE WRONG ANSWER, which is what makes the
// ordering assertions bite. Files are enumerated with `readdirSync().sort()`, so an implementation
// that ignores `iat` and simply keeps the first entry it meets picks the one whose uid sorts first.
// The HUSK is therefore given the uid that sorts first: such an implementation crowns the husk as
// the live incarnation and marks the genuinely live credential as the leftover, which the ORDERING
// cells below catch by name.
//
// I got this backwards on the first attempt — I gave the LIVE file the first-sorting uid, which made
// "first seen" and "newest" coincide again, and the ordering mutant went on surviving. A fixture is
// only adversarial if the lazy implementation actually fails it.
const oldUid = `a${"0".repeat(25)}`;   // sorts FIRST, minted first (the HUSK)
const liveUid = `z${"0".repeat(25)}`;  // sorts LAST, minted second (the LIVE one)
writeFileSync(join(credsDir, `worker.${oldUid}.creds`), await mintCreds(auth, newIdentity(), "agent", { lifecycleUid: oldUid, expiresAt: now - 3600 }), { mode: 0o600 });
// The successor is minted second so its `iat` is strictly later; a whole second apart so the
// comparison never rests on a tie.
await new Promise((r) => setTimeout(r, 1100));
writeFileSync(join(credsDir, `worker.${liveUid}.creds`), await mintCreds(auth, newIdentity(), "agent", { lifecycleUid: liveUid, expiresInSeconds: 86_400 }), { mode: 0o600 });

// orphan: a LONE expired incarnation — nothing supersedes it, so it stays a real problem (control).
const orphanUid = mintLifecycleUid();
writeFileSync(join(credsDir, `orphan.${orphanUid}.creds`), await incarnation({ expiresAt: now - 3600 }), { mode: 0o600 });

// broken: an UNREADABLE credential — the one case where "respawn the agent" is the honest remedy.
writeFileSync(join(credsDir, `broken.${mintLifecycleUid()}.creds`), "not a creds file", { mode: 0o600 });

const origCwd = process.cwd(), origLog = console.log, origErr = console.error;
async function runDoctor(): Promise<{ out: string; code: number | undefined }> {
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  console.error = (...a: unknown[]) => { lines.push(a.join(" ")); };
  process.exitCode = undefined;
  process.chdir(root);
  try {
    await doctor({ values: { space: SPACE }, positionals: ["auth"], raw: [] });
    return { out: strip(lines.join("\n")), code: process.exitCode as number | undefined };
  } finally {
    console.log = origLog;
    console.error = origErr;
    process.chdir(origCwd);
    process.exitCode = 0;
  }
}

try {
  const r = await runDoctor();
  const lineFor = (file: string) => r.out.split("\n").map((l) => l.trim()).filter((l) => l.includes(file));
  const husk = lineFor(`worker.${oldUid}.creds`);
  const live = lineFor(`worker.${liveUid}.creds`);
  const orphan = lineFor(`orphan.${orphanUid}.creds`);

  // ---- CELL 1: the husk is not a problem ----
  check("CELL 1: the superseded incarnation is NOT reported as an EXPIRED problem",
    !husk.some((l) => l.startsWith("✗") && l.includes("EXPIRED")), husk);
  check("CELL 1: the live incarnation of the same alias is not a problem either",
    !live.some((l) => l.startsWith("✗")), live);

  // ---- CELL 2: it is still visible, and named ----
  check("CELL 2: the superseded file is still LISTED (hiding it is not the fix)", husk.length > 0, r.out);
  check("CELL 2: its row NAMES it superseded and names the alias whose successor is live",
    husk.some((l) => /superseded/.test(l)) && husk.some((l) => l.includes("worker")), husk);
  check("CELL 2: its remedy is a file cleanup and explicitly NOT a respawn",
    r.out.includes("DO NOT respawn the agent"), r.out);

  // ---- CELL 3: the recoverable remedy ----
  check("CELL 3: a recoverable agent credential says the manager RE-MINTS it",
    /RE-MINTS this credential by itself/.test(r.out), orphan);
  check("CELL 3: and that the agent is not restarted for it",
    /adopts the new file without being restarted/.test(r.out), orphan);

  // ---- CELL 4: refuse controls ----
  check("CELL 4 CONTROL: a LONE expired incarnation is STILL a problem (supersession is not a blanket excuse)",
    orphan.some((l) => l.startsWith("✗") && l.includes("EXPIRED")), orphan);
  check("CELL 4 CONTROL: an UNREADABLE credential still recommends a respawn (the one case it fits)",
    /cannot be re-minted from disk/.test(r.out) && /respawn the agent/.test(r.out), r.out);
  check("CELL 4 CONTROL: the run still exits 1, because real problems remain",
    r.code === 1, r.code);

  // ---- the verdict line an operator reads during an incident ----
  check("the superseded count is reported as a tidy-up, not as fleet damage",
    /superseded credential file/.test(r.out) && !/15 cred problems/.test(r.out), r.out);

  // ---- the ORDERING itself: which of two incarnations is the husk ----
  // A mutant that picked the FIRST file it saw instead of the newest `iat` survived the cells above,
  // because both files got a role and the husk happened to be listed first. Supersession is a
  // DIRECTED relation and the direction is the whole safety property: pick it backwards and doctor
  // calls the LIVE credential a leftover and tells the operator to delete it, which is worse than the
  // bug being fixed. So the direction is asserted by name on both members of the pair.
  check("ORDERING: the OLDER incarnation is the one marked superseded",
    husk.some((l) => /superseded/.test(l)), husk);
  check("ORDERING: the NEWER incarnation is NEVER marked superseded",
    !live.some((l) => /superseded/.test(l)), live);
  check("ORDERING: the newer incarnation is not offered for deletion",
    !r.out.split("\n").some((l) => l.includes(`worker.${liveUid}.creds`) && /rm |DO NOT respawn/.test(l)),
    live);

  console.log(fail === 0 ? `\nDOCTOR-SUPERSEDED SMOKE OK ✅  (${pass} passed, ${fail} failed)` : `\nDOCTOR-SUPERSEDED SMOKE FAILED ❌  (${pass} passed, ${fail} failed)`);
  // Canonical sentinel: the shard runner refuses a suite that exits 0 having run zero cells, and
  // the banner above only parses through a legacy compatibility branch.
  emitSentinel({ passed: pass, failed: fail });
  process.exitCode = fail === 0 ? 0 : 1;
} finally {
  rmSync(root, { recursive: true, force: true });
}
