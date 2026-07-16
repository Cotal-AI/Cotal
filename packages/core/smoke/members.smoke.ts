/**
 * Durable-membership registry (Plane-3 Piece 1) against a REAL broker (no test runner).
 *
 * Exercises members.ts end-to-end on a live KV bucket: record create/read, the generation guard +
 * revision CAS (a stale control reply can't clobber a newer rejoin/tombstone), tombstone-by-cursor,
 * the membership-interval eligibility rule (`joinCursor < seq <= leaveCursor`, durable-active only),
 * the channel/owner scans, and the concrete-only key round-trip. No endpoint, no manager — just the
 * privileged registry primitives the rest of Stage 4 builds on.
 *
 * Run: pnpm smoke:members
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
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

const PORT = await pickFreePort();
const servers = `nats://127.0.0.1:${PORT}`;
const space = "memreg";
const W = "writer_priv"; // the privileged writer identity (audit)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const dir = mkdtempSync(join(tmpdir(), "cotal-memreg-"));
const srv = spawn("nats-server", ["-js", "-p", String(PORT), "-sd", join(dir, "js")], { stdio: "ignore" });

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
  check("memberKey/parseMemberKey round-trip (flat)", JSON.stringify(parseMemberKey(memberKey("review", "OWNERA"))) === JSON.stringify({ channel: "review", owner: "OWNERA" }));
  check("memberKey/parseMemberKey round-trip (dotted channel)", JSON.stringify(parseMemberKey(memberKey("team.backend", "OWNERB"))) === JSON.stringify({ channel: "team.backend", owner: "OWNERB" }));
  check("parseMemberKey rejects a non-key", parseMemberKey("=defaults") === null);
  check("bucket name", membersBucket(space) === "cotal_members_memreg");

  // ---- create + read ----
  await commitMember(kv, rec({ channel: "review", owner: "ALICE", joinCursor: 10, state: "durable-active" }));
  const a = await readMember(kv, "review", "ALICE");
  check("created record reads back", a?.record.owner === "ALICE" && a.record.joinCursor === 10 && a.record.state === "durable-active");
  check("absent record reads undefined", (await readMember(kv, "review", "NOBODY")) === undefined);

  // ---- same-generation upgrade (live-confirmed -> durable-active) is allowed ----
  await commitMember(kv, rec({ channel: "general", owner: "BOB", generation: 1, state: "live-confirmed", joinCursor: 5 }));
  await commitMember(kv, rec({ channel: "general", owner: "BOB", generation: 1, state: "durable-active", joinCursor: 5 }));
  check("same-generation state upgrade commits", (await readMember(kv, "general", "BOB"))?.record.state === "durable-active");

  // ---- generation guard: a STALE (older-generation) write is rejected, record unchanged ----
  await commitMember(kv, rec({ channel: "review", owner: "ALICE", generation: 3, joinCursor: 100 })); // rejoin: gen 3
  let threw = false;
  try {
    await commitMember(kv, rec({ channel: "review", owner: "ALICE", generation: 2, joinCursor: 50 })); // stale reply: gen 2
  } catch (e) {
    threw = e instanceof StaleMembershipWrite;
  }
  check("stale-generation write throws StaleMembershipWrite", threw);
  check("stale write left the newer record intact (gen 3, cursor 100)", (await readMember(kv, "review", "ALICE"))?.record.joinCursor === 100);

  // ---- tombstone (leave) sets leaveCursor; a stale leave (older gen) can't tombstone the rejoin ----
  await commitMember(kv, rec({ channel: "ops", owner: "CAROL", generation: 1, joinCursor: 0 }));
  await tombstoneMember(kv, "ops", "CAROL", 200, W);
  const tomb = await readMember(kv, "ops", "CAROL");
  check("tombstone sets leaveCursor", tomb?.record.leaveCursor === 200 && tomb.record.state === "live-confirmed");
  // a rejoin (gen 2, fresh cursor, clears leaveCursor) then a stale leave reply (gen 1) must not re-tombstone
  await commitMember(kv, rec({ channel: "ops", owner: "CAROL", generation: 2, joinCursor: 300, state: "durable-active", leaveCursor: undefined }));
  let staleLeaveThrew = false;
  try {
    // tombstoneMember reads current (gen 2) and writes back gen 2 with leaveCursor — that's a CURRENT
    // leave, allowed. To simulate a STALE leave reply we commit an explicit gen-1 tombstone:
    await commitMember(kv, rec({ channel: "ops", owner: "CAROL", generation: 1, leaveCursor: 250, state: "live-confirmed" }));
  } catch (e) {
    staleLeaveThrew = e instanceof StaleMembershipWrite;
  }
  check("stale leave reply (older gen) rejected — rejoin survives", staleLeaveThrew && (await readMember(kv, "ops", "CAROL"))?.record.joinCursor === 300 && (await readMember(kv, "ops", "CAROL"))?.record.leaveCursor === undefined);

  // ---- membership-interval eligibility (durableEligible) ----
  const open = rec({ channel: "x", owner: "Z", state: "durable-active", joinCursor: 100 });
  check("durable-active: seq > joinCursor eligible", durableEligible(open, 101));
  check("durable-active: seq == joinCursor NOT eligible (exclusive)", !durableEligible(open, 100));
  check("durable-active: seq < joinCursor NOT eligible", !durableEligible(open, 50));
  const left = rec({ channel: "x", owner: "Z", state: "durable-active", joinCursor: 100, leaveCursor: 200 });
  check("interval: seq == leaveCursor eligible (inclusive)", durableEligible(left, 200));
  check("interval: seq > leaveCursor NOT eligible (hard cut)", !durableEligible(left, 201));
  check("interval: mid-interval eligible", durableEligible(left, 150));
  // durableEligible is a PURE-INTERVAL delivery predicate, INDEPENDENT of `activated` (the activation-
  // race fix): a `durable-active` record still completing catch-up (`activated:false`) IS delivery-
  // eligible in-interval — so the catch-up + post-fence messages activation exists to deliver are never
  // ack-dropped/skipped before the flip. `activated` gates only the REPORT (durableJoin's return +
  // channelMembers), never delivery. Reverting this predicate to gate on `activated` reopens the race.
  const notActivated = rec({ channel: "x", owner: "Z", state: "durable-active", activated: false, joinCursor: 100 });
  check("activation-pending (activated:false) IS delivery-eligible in-interval (activation-race fix)", durableEligible(notActivated, 150));
  check("activation-pending: seq <= joinCursor still NOT eligible (interval still bounds delivery)", !durableEligible(notActivated, 100));
  // HIGH-1 regression: a TOMBSTONE (live-confirmed + leaveCursor — exactly what tombstoneMember writes)
  // stays interval-eligible for its PRE-leave window. This previously dropped ALL pre-leave entries
  // because durableEligible required state===durable-active and the leaveCursor branch was dead code.
  const tombstoned = rec({ channel: "x", owner: "Z", state: "live-confirmed", joinCursor: 100, leaveCursor: 200 });
  check("tombstone (live-confirmed+leaveCursor): pre-leave seq IS eligible (HIGH-1)", durableEligible(tombstoned, 150));
  check("tombstone: seq == leaveCursor eligible", durableEligible(tombstoned, 200));
  check("tombstone: post-leave seq NOT eligible (hard cut)", !durableEligible(tombstoned, 201));

  // ---- stale leave through the REAL tombstoneMember helper must not tombstone a newer rejoin ----
  // (panel BLOCKER: the helper takes an expected generation; join gen1 → rejoin gen2 → stale leave gen1.)
  await commitMember(kv, rec({ channel: "team.api", owner: "EVE", state: "durable-active", joinCursor: 10, generation: 1 }));
  await commitMember(kv, rec({ channel: "team.api", owner: "EVE", state: "durable-active", joinCursor: 99, generation: 2 }));
  let staleTombThrew = false;
  try { await tombstoneMember(kv, "team.api", "EVE", 50, W, 1); } catch (e) { staleTombThrew = e instanceof StaleMembershipWrite; }
  const eve = await readMember(kv, "team.api", "EVE");
  check("stale leave via tombstoneMember (expectedGen=1) refused — gen2 rejoin survives durable-active", staleTombThrew && eve?.record.generation === 2 && eve.record.leaveCursor === undefined && eve.record.state === "durable-active");
  await tombstoneMember(kv, "team.api", "EVE", 120, W, 2); // a CURRENT leave (matching gen) succeeds
  check("current leave via tombstoneMember (expectedGen=2) tombstones at leaveCursor", (await readMember(kv, "team.api", "EVE"))?.record.leaveCursor === 120);

  // ---- activation completing AFTER a same-generation leave must NOT resurrect the membership (reopen §7)
  // (review-general-2 BLOCKER: commitMember allows same-generation updates, so a blind activation flip
  //  would CLOBBER a same-gen tombstone — clear its leaveCursor. activateMember refuses via CAS unless the
  //  record is still the exact open pending join.) ----
  await commitMember(kv, rec({ channel: "race", owner: "AL", state: "durable-active", joinCursor: 50, generation: 1, activated: false }));
  await tombstoneMember(kv, "race", "AL", 60, W); // a same-gen leave lands while activation is "in flight"
  const resurrect = await activateMember(kv, "race", "AL", 1, 50); // the in-flight flip tries to complete
  const raceRec = await readMember(kv, "race", "AL");
  check("activateMember REFUSES to flip a same-gen tombstoned record — no §7 resurrection (leaveCursor survives)", resurrect === undefined && raceRec?.record.leaveCursor === 60 && raceRec.record.activated !== true, raceRec?.record);
  // happy path: a clean open pending join flips, idempotently
  await commitMember(kv, rec({ channel: "race2", owner: "BO", state: "durable-active", joinCursor: 10, generation: 1, activated: false }));
  check("activateMember flips a clean open pending join → activated:true", (await activateMember(kv, "race2", "BO", 1, 10))?.activated === true);
  check("activateMember is idempotent on an already-activated record", (await activateMember(kv, "race2", "BO", 1, 10))?.activated === true);
  // rejoin: a stale-generation activation is refused (a newer generation won)
  await commitMember(kv, rec({ channel: "race3", owner: "CY", state: "durable-active", joinCursor: 30, generation: 2, activated: false }));
  check("activateMember REFUSES a stale-generation flip (rejoin won)", (await activateMember(kv, "race3", "CY", 1, 5)) === undefined);

  // ---- scans: by channel, by owner; concrete-only; tombstones included ----
  await commitMember(kv, rec({ channel: "review", owner: "DAVE", joinCursor: 0 }));
  await commitMember(kv, rec({ channel: "team.backend", owner: "DAVE", joinCursor: 0 }));
  const reviewMembers = (await listMembers(kv, { channel: "review" })).map((m) => m.owner).sort();
  check("listMembers(channel=review) = ALICE,DAVE", JSON.stringify(reviewMembers) === JSON.stringify(["ALICE", "DAVE"]));
  const daveMemberships = (await listMembers(kv, { owner: "DAVE" })).map((m) => m.channel).sort();
  check("listMembers(owner=DAVE) = review,team.backend", JSON.stringify(daveMemberships) === JSON.stringify(["review", "team.backend"]));
  check("channel scan does NOT bleed across the dotted prefix (review != team.backend)", !reviewMembers.includes("team.backend"));

  // ---- delete (GC) removes the footprint ----
  await deleteMember(kv, "review", "DAVE");
  check("deleteMember purges the record", (await readMember(kv, "review", "DAVE")) === undefined);
  check("delete left the sibling record intact", (await readMember(kv, "review", "ALICE")) !== undefined);

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
    process.exit(process.exitCode ?? 0);
  });
