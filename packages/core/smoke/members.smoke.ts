/**
 * Durable-membership registry (Plane-3 Piece 1) against a REAL broker (no test runner).
 *
 * Exercises members.ts end-to-end on a live KV bucket: record create/read, the generation guard +
 * revision CAS (a stale control reply can't clobber a newer rejoin/tombstone), tombstone-by-cursor,
 * the membership-interval eligibility rule (`joinCursor < seq <= leaveCursor`, durable-active only),
 * the channel/owner scans, and the concrete-only key round-trip. No endpoint, no manager — just the
 * privileged registry primitives the rest of Stage 4 builds on.
 *
 * Membership rows are LIFECYCLE-KEYED (SPEC §13.1): the KV key is `<channel>/<owner>.<actor>.<uid>`,
 * so every registry op takes the member incarnation's lifecycleUid and the "owner" identity is the
 * full principal dot-form `<owner>.<actor>` (not a bare token). One uid per simulated agent, derived
 * deterministically from the principal so key round-trips can assert the exact tail.
 *
 * Run: pnpm smoke:members
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@nats-io/transport-node";
import {
  membersBucket,
  memberKey,
  parseMemberKey,
  openMembersRegistry,
  commitMember,
  readMember,
  tombstoneMember,
  activateMember,
  deleteMember,
  listMembers,
  durableEligible,
  StaleMembershipWrite,
  type MembershipRecord,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = "memreg";
const W = "writer_priv"; // the privileged writer identity (audit)
// One lifecycle uid per simulated agent (SPEC §13.1). Deterministic per-principal: 26 hex chars ⊆
// [a-z0-9]{26,32}, so a key round-trip can assert the exact tail and a rejoin reuses the same uid.
const lid = (principal: string): string => createHash("sha256").update(principal).digest("hex").slice(0, 26);
// Principals are the owner+actor dot-form (`<owner>.<actor>`) the members API keys on.
const OA = "local.ownera", OB = "local.ownerb";
const A = "local.alice", B = "local.bob", CA = "local.carol", D = "local.dave", E = "local.eve";
const Z = "local.zeta", AL = "local.al", BO = "local.bo", CY = "local.cy";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

let pass = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  assert.ok(cond, `${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ""}`);
  pass++;
  console.log(`  ✓ ${name}`);
};
const rec = (over: Partial<MembershipRecord> & Pick<MembershipRecord, "channel" | "owner">): MembershipRecord => ({
  state: "durable-active",
  activated: true, // most test records are fully-activated durable members; live-confirmed sets false
  joinCursor: 0,
  generation: 1,
  writerIdentity: W,
  updatedAt: Date.now(),
  lifecycleUid: lid(over.owner), // lifecycle-keyed row; a rejoin (same principal) reuses this uid
  ...over,
});

async function main() {
  for (let i = 0; i < 50; i++) {
    try {
      const probe = await connect({ servers });
      await probe.close();
      break;
    } catch {
      await sleep(200);
    }
  }
  const nc = await connect({ servers });
  const kv = await openMembersRegistry(nc, space, { create: true });

  // ---- key encoding round-trips, incl. a dotted (hierarchical) channel ----
  // parseMemberKey peels the LAST dot token as the lifecycleUid and requires a valid principal dot-form.
  check("memberKey/parseMemberKey round-trip (flat)", JSON.stringify(parseMemberKey(memberKey("review", OA, lid(OA)))) === JSON.stringify({ channel: "review", principal: OA, lifecycleUid: lid(OA) }));
  check("memberKey/parseMemberKey round-trip (dotted channel)", JSON.stringify(parseMemberKey(memberKey("team.backend", OB, lid(OB)))) === JSON.stringify({ channel: "team.backend", principal: OB, lifecycleUid: lid(OB) }));
  check("parseMemberKey rejects a non-key", parseMemberKey("=defaults") === null);
  check("bucket name", membersBucket(space) === "cotal_members_memreg");

  // ---- create + read ----
  await commitMember(kv, rec({ channel: "review", owner: A, joinCursor: 10, state: "durable-active" }));
  const a = await readMember(kv, "review", A, lid(A));
  check("created record reads back", a?.record.owner === A && a.record.joinCursor === 10 && a.record.state === "durable-active");
  check("absent record reads undefined", (await readMember(kv, "review", "local.nobody", lid("local.nobody"))) === undefined);

  // ---- same-generation upgrade (live-confirmed -> durable-active) is allowed ----
  await commitMember(kv, rec({ channel: "general", owner: B, generation: 1, state: "live-confirmed", joinCursor: 5 }));
  await commitMember(kv, rec({ channel: "general", owner: B, generation: 1, state: "durable-active", joinCursor: 5 }));
  check("same-generation state upgrade commits", (await readMember(kv, "general", B, lid(B)))?.record.state === "durable-active");

  // ---- generation guard: a STALE (older-generation) write is rejected, record unchanged ----
  await commitMember(kv, rec({ channel: "review", owner: A, generation: 3, joinCursor: 100 })); // rejoin: gen 3
  let threw = false;
  try {
    await commitMember(kv, rec({ channel: "review", owner: A, generation: 2, joinCursor: 50 })); // stale reply: gen 2
  } catch (e) {
    threw = e instanceof StaleMembershipWrite;
  }
  check("stale-generation write throws StaleMembershipWrite", threw);
  check("stale write left the newer record intact (gen 3, cursor 100)", (await readMember(kv, "review", A, lid(A)))?.record.joinCursor === 100);

  // ---- tombstone (leave) sets leaveCursor; a stale leave (older gen) can't tombstone the rejoin ----
  await commitMember(kv, rec({ channel: "ops", owner: CA, generation: 1, joinCursor: 0 }));
  await tombstoneMember(kv, "ops", CA, lid(CA), 200, W);
  const tomb = await readMember(kv, "ops", CA, lid(CA));
  check("tombstone sets leaveCursor", tomb?.record.leaveCursor === 200 && tomb.record.state === "live-confirmed");
  // a rejoin (gen 2, fresh cursor, clears leaveCursor) then a stale leave reply (gen 1) must not re-tombstone
  await commitMember(kv, rec({ channel: "ops", owner: CA, generation: 2, joinCursor: 300, state: "durable-active", leaveCursor: undefined }));
  let staleLeaveThrew = false;
  try {
    // tombstoneMember reads current (gen 2) and writes back gen 2 with leaveCursor — that's a CURRENT
    // leave, allowed. To simulate a STALE leave reply we commit an explicit gen-1 tombstone:
    await commitMember(kv, rec({ channel: "ops", owner: CA, generation: 1, leaveCursor: 250, state: "live-confirmed" }));
  } catch (e) {
    staleLeaveThrew = e instanceof StaleMembershipWrite;
  }
  check("stale leave reply (older gen) rejected — rejoin survives", staleLeaveThrew && (await readMember(kv, "ops", CA, lid(CA)))?.record.joinCursor === 300 && (await readMember(kv, "ops", CA, lid(CA)))?.record.leaveCursor === undefined);

  // ---- membership-interval eligibility (durableEligible) ----
  const open = rec({ channel: "x", owner: Z, state: "durable-active", joinCursor: 100 });
  check("durable-active: seq > joinCursor eligible", durableEligible(open, 101));
  check("durable-active: seq == joinCursor NOT eligible (exclusive)", !durableEligible(open, 100));
  check("durable-active: seq < joinCursor NOT eligible", !durableEligible(open, 50));
  const left = rec({ channel: "x", owner: Z, state: "durable-active", joinCursor: 100, leaveCursor: 200 });
  check("interval: seq == leaveCursor eligible (inclusive)", durableEligible(left, 200));
  check("interval: seq > leaveCursor NOT eligible (hard cut)", !durableEligible(left, 201));
  check("interval: mid-interval eligible", durableEligible(left, 150));
  // durableEligible is a PURE-INTERVAL delivery predicate, INDEPENDENT of `activated` (the activation-
  // race fix): a `durable-active` record still completing catch-up (`activated:false`) IS delivery-
  // eligible in-interval — so the catch-up + post-fence messages activation exists to deliver are never
  // ack-dropped/skipped before the flip. `activated` gates only the REPORT (durableJoin's return +
  // channelMembers), never delivery. Reverting this predicate to gate on `activated` reopens the race.
  const notActivated = rec({ channel: "x", owner: Z, state: "durable-active", activated: false, joinCursor: 100 });
  check("activation-pending (activated:false) IS delivery-eligible in-interval (activation-race fix)", durableEligible(notActivated, 150));
  check("activation-pending: seq <= joinCursor still NOT eligible (interval still bounds delivery)", !durableEligible(notActivated, 100));
  // HIGH-1 regression: a TOMBSTONE (live-confirmed + leaveCursor — exactly what tombstoneMember writes)
  // stays interval-eligible for its PRE-leave window. This previously dropped ALL pre-leave entries
  // because durableEligible required state===durable-active and the leaveCursor branch was dead code.
  const tombstoned = rec({ channel: "x", owner: Z, state: "live-confirmed", joinCursor: 100, leaveCursor: 200 });
  check("tombstone (live-confirmed+leaveCursor): pre-leave seq IS eligible (HIGH-1)", durableEligible(tombstoned, 150));
  check("tombstone: seq == leaveCursor eligible", durableEligible(tombstoned, 200));
  check("tombstone: post-leave seq NOT eligible (hard cut)", !durableEligible(tombstoned, 201));

  // ---- stale leave through the REAL tombstoneMember helper must not tombstone a newer rejoin ----
  // (panel BLOCKER: the helper takes an expected generation; join gen1 → rejoin gen2 → stale leave gen1.)
  await commitMember(kv, rec({ channel: "team.api", owner: E, state: "durable-active", joinCursor: 10, generation: 1 }));
  await commitMember(kv, rec({ channel: "team.api", owner: E, state: "durable-active", joinCursor: 99, generation: 2 }));
  let staleTombThrew = false;
  try { await tombstoneMember(kv, "team.api", E, lid(E), 50, W, 1); } catch (e) { staleTombThrew = e instanceof StaleMembershipWrite; }
  const eve = await readMember(kv, "team.api", E, lid(E));
  check("stale leave via tombstoneMember (expectedGen=1) refused — gen2 rejoin survives durable-active", staleTombThrew && eve?.record.generation === 2 && eve.record.leaveCursor === undefined && eve.record.state === "durable-active");
  await tombstoneMember(kv, "team.api", E, lid(E), 120, W, 2); // a CURRENT leave (matching gen) succeeds
  check("current leave via tombstoneMember (expectedGen=2) tombstones at leaveCursor", (await readMember(kv, "team.api", E, lid(E)))?.record.leaveCursor === 120);

  // ---- activation completing AFTER a same-generation leave must NOT resurrect the membership (reopen §7)
  // (review-general-2 BLOCKER: commitMember allows same-generation updates, so a blind activation flip
  //  would CLOBBER a same-gen tombstone — clear its leaveCursor. activateMember refuses via CAS unless the
  //  record is still the exact open pending join.) ----
  await commitMember(kv, rec({ channel: "race", owner: AL, state: "durable-active", joinCursor: 50, generation: 1, activated: false }));
  await tombstoneMember(kv, "race", AL, lid(AL), 60, W); // a same-gen leave lands while activation is "in flight"
  const resurrect = await activateMember(kv, "race", AL, lid(AL), 1, 50); // the in-flight flip tries to complete
  const raceRec = await readMember(kv, "race", AL, lid(AL));
  check("activateMember REFUSES to flip a same-gen tombstoned record — no §7 resurrection (leaveCursor survives)", resurrect === undefined && raceRec?.record.leaveCursor === 60 && raceRec.record.activated !== true, raceRec?.record);
  // happy path: a clean open pending join flips, idempotently
  await commitMember(kv, rec({ channel: "race2", owner: BO, state: "durable-active", joinCursor: 10, generation: 1, activated: false }));
  check("activateMember flips a clean open pending join → activated:true", (await activateMember(kv, "race2", BO, lid(BO), 1, 10))?.activated === true);
  check("activateMember is idempotent on an already-activated record", (await activateMember(kv, "race2", BO, lid(BO), 1, 10))?.activated === true);
  // rejoin: a stale-generation activation is refused (a newer generation won)
  await commitMember(kv, rec({ channel: "race3", owner: CY, state: "durable-active", joinCursor: 30, generation: 2, activated: false }));
  check("activateMember REFUSES a stale-generation flip (rejoin won)", (await activateMember(kv, "race3", CY, lid(CY), 1, 5)) === undefined);

  // ---- scans: by channel, by owner; concrete-only; tombstones included ----
  await commitMember(kv, rec({ channel: "review", owner: D, joinCursor: 0 }));
  await commitMember(kv, rec({ channel: "team.backend", owner: D, joinCursor: 0 }));
  const reviewMembers = (await listMembers(kv, { channel: "review" })).map((m) => m.owner).sort();
  check("listMembers(channel=review) = alice,dave", JSON.stringify(reviewMembers) === JSON.stringify([A, D].sort()));
  const daveMemberships = (await listMembers(kv, { owner: D })).map((m) => m.channel).sort();
  check("listMembers(owner=dave) = review,team.backend", JSON.stringify(daveMemberships) === JSON.stringify(["review", "team.backend"]));
  check("channel scan does NOT bleed across the dotted prefix (review != team.backend)", !reviewMembers.includes("team.backend"));

  // ---- delete (GC) removes the footprint ----
  await deleteMember(kv, "review", D, lid(D));
  check("deleteMember purges the record", (await readMember(kv, "review", D, lid(D))) === undefined);
  check("delete left the sibling record intact", (await readMember(kv, "review", A, lid(A))) !== undefined);

  console.log(`\nMEMBERS-REGISTRY SMOKE PASSED ✅  (${pass} checks)`);
  await nc.close();
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    srv.kill("SIGKILL");
    await new Promise<void>((resolve) => {
      if (srv.exitCode !== null || srv.signalCode !== null) return resolve();
      srv.once("exit", () => resolve());
      setTimeout(resolve, 3000);
    });
    rmSync(dir, { recursive: true, force: true });
    releaseBroker(); // last: ownership is held until this teardown has actually finished
    process.exit(process.exitCode ?? 0);
  });
