/**
 * `confirmAttach` ON THE REAL MINTED DELIVERY CREDENTIAL — the boundary the open-broker rail smoke
 * is structurally incapable of measuring.
 *
 * WHY THIS SUITE EXISTS, AND IT IS THE WHOLE LESSON OF THE GRADE THAT ORDERED IT.
 * `smoke:artifact-control-rail` drives the same verb, over the same wire, through the same shipped
 * handler — and it was 14/14 GREEN while the rail was UNUSABLE in production. Its daemon runs on an
 * open broker with FULL AUTHORITY. **A test that holds every grant cannot measure an authorization
 * boundary; it measures the code path with that boundary removed.** Both facts were true at once and
 * neither was a mistake about the other.
 *
 * The defect it could not see: `c8d66fc5` served a REACHABLE handler whose call graph needs four
 * broker subjects the shipped `delivery` allow-list did not grant. A real auth-mode request was
 * denied at `$JS.API.STREAM.MSG.GET.<CHAT>` before it ever reached the possession fence.
 *
 * WHAT IS DIFFERENT HERE, in one line: every connection below is a REAL credential minted by the
 * shipped `mintCreds`, against a JWT-auth broker, and nothing in the suite holds authority the
 * production daemon would not.
 *
 * THE ASYMMETRY THIS PROVES AT THE BROKER, not in an array:
 *   READ  the CHAT entry by seq, READ possession, READ+CREATE+DELETE the attachment row  — ALLOWED
 *   WRITE possession                                                                     — DENIED
 * The denial is the fence. Possession is EARNED by putting the bytes and is the only thing the
 * succession check reads; a delivery daemon that could write it could manufacture possession for any
 * principal at any lifecycle. `smoke:artifact-grant-shape` guards that as a string in an allow-list;
 * this guards it as an answer from nats-server.
 *
 * A1-CONTROL IS LOAD-BEARING RATHER THAN CEREMONY. A5's denial is an ABSENCE, and an absence is
 * vacuously true against a credential that cannot write anything, a bucket that does not exist, or a
 * probe aimed at the wrong subject. A1 drives the SAME command shape — same connection, same client,
 * same `kv.put` — at a bucket the delivery cred is KNOWN to hold, so a denial in A5 means "this
 * subject", not "this probe never worked".
 *
 * Run: pnpm smoke:artifact-rail-authz:auth   (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import { jetstreamManager } from "@nats-io/jetstream";
import { Kvm } from "@nats-io/kv";
import { encodeUser, fmtCreds } from "@nats-io/jwt";
import { fromPublic, fromSeed } from "@nats-io/nkeys";
import {
  ARTIFACT_PART_KIND,
  ATTACH_REFUSAL,
  CONTROL_DELIVERY,
  CotalEndpoint,
  DEV_OWNER,
  attachmentBucket,
  attachmentKey,
  chatStream,
  chatSubject,
  controlServiceSubject,
  createSpaceAuth,
  isReachable,
  membersBucket,
  mintCreds,
  mintLifecycleUid,
  newIdentity,
  possessionBucket,
  possessionKey,
  principalKey,
  provisionAgent,
  serverConfig,
  setupSpaceStreams,
  type Identity,
  type SpaceAuth,
} from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { stopBrokerAndClean } from "./_stop-broker.js";

let ok = 0, fail = 0;
const check = (name: string, pass: boolean, extra?: unknown) => {
  if (pass) { ok++; console.log("  ✓", name); }
  else { fail++; console.log("  ✗ FAIL:", name, extra ?? ""); }
};

/**
 * A refusal cell asserts WHICH refusal, through a helper that cannot pass on a different one — and
 * here that is not pedantry: under a missing grant EVERY reply is `ok:false`, so a suite matching on
 * `ok === false` alone would call a broker denial a successful authorization refusal.
 */
const refuses = (name: string, reply: { ok: boolean; error?: string }, expected: string) =>
  check(name, reply.ok === false && reply.error === expected, reply);

/** What the broker answered, kept separable: a DENIAL is not the same event as an absent row. */
type Outcome = { kind: "ok"; value: unknown } | { kind: "denied"; detail: string } | { kind: "error"; detail: string };
const drive = async (fn: () => Promise<unknown>): Promise<Outcome> => {
  try {
    return { kind: "ok", value: await fn() };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    return { kind: /permission|authorization/i.test(detail) ? "denied" : "error", detail };
  }
};

const SPACE = `artauthz${randomUUID().slice(0, 8).replace(/-/g, "")}`;
const CHANNEL = "general";
const D = "sha256:" + "ab".repeat(32);      // the digest the agent published and possesses
const D_OTHER = "sha256:" + "ef".repeat(32); // a digest it does NOT possess
const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * THE ONE FIXTURE CREDENTIAL, and it is a fixture BECAUSE the grant it carries does not exist yet.
 *
 * Nothing in the shipped tree can write a possession row: possession is EARNED by putting the bytes
 * and the put path is S4. So this suite mints, by hand, the narrow writer that S4 will eventually
 * ship — exactly `$KV` write on the two index buckets and nothing else — to seed the state the fence
 * reads. It is never the credential under test; it only stages the world and then reads the result
 * back INDEPENDENTLY of the credential that wrote it.
 */
async function mintIndexSeeder(auth: SpaceAuth, identity: Identity): Promise<string> {
  const POSS = possessionBucket(auth.space), ATT = attachmentBucket(auth.space);
  const jwt = await encodeUser(
    "artifact-index-seeder",
    fromPublic(identity.id),
    fromPublic(auth.account.pub),
    {
      pub: {
        allow: [
          "$JS.API.INFO",
          `$KV.${POSS}.>`, `$KV.${ATT}.>`,
          `$JS.API.STREAM.MSG.GET.KV_${POSS}`, `$JS.API.STREAM.MSG.GET.KV_${ATT}`,
        ],
      },
      sub: { allow: [`_INBOX_${identity.id}.>`] },
    },
    { signer: fromSeed(new TextEncoder().encode(auth.account.signingSeed)) },
  );
  return new TextDecoder().decode(fmtCreds(jwt, fromSeed(new TextEncoder().encode(identity.seed))));
}

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const auth = await createSpaceAuth(SPACE);
const sd = mkdtempSync(join(tmpdir(), "cotal-artauthz-"));
writeFileSync(
  join(sd, "server.conf"),
  serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(sd, "js") }),
);
const broker = spawn("nats-server", ["-c", join(sd, "server.conf")], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50 && !up; i++) { up = await isReachable(SERVERS); if (!up) await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  // ---- the space, provisioned by the shipped provisioner cred --------------------------------
  const mgrId = newIdentity();
  const mgrCreds = await mintCreds(auth, mgrId, "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space: SPACE, creds: mgrCreds });
  const mgr = new CotalEndpoint({
    space: SPACE, servers: SERVERS, creds: mgrCreds,
    card: { id: mgrId.id, name: "mgr", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false,
  });
  mgr.on("error", () => {});
  await mgr.start();

  // ---- the agent: a real provisioned principal with a real ACL row ----------------------------
  const aId = newIdentity();
  const uidA = mintLifecycleUid();
  const aCreds = await provisionAgent(mgr, auth, aId, {
    subscribe: [CHANNEL], allowSubscribe: [CHANNEL], allowPublish: [CHANNEL], lifecycleUid: uidA,
  });
  const CALLER = principalKey(DEV_OWNER, aId.id).key;

  // ---- the daemon: the SHIPPED `delivery` credential, nothing added --------------------------
  const dlvId = newIdentity();
  const dlvCreds = await mintCreds(auth, dlvId, "delivery");
  const dlv = new CotalEndpoint({
    space: SPACE, servers: SERVERS, creds: dlvCreds,
    card: { id: dlvId.id, name: "delivery", role: "delivery", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false,
  });
  dlv.on("error", () => {});
  await dlv.start();
  await dlv.startPlane3(async () => undefined);

  const a = new CotalEndpoint({
    space: SPACE, servers: SERVERS, creds: aCreds,
    card: { id: aId.id, name: "putter", kind: "agent" },
    channels: [CHANNEL], lifecycleUid: uidA, consume: false, heartbeatMs: 500, ttlMs: 2000,
  });
  a.on("error", () => {});
  await a.start();

  // ---- the real publication, addressed by its own ack ----------------------------------------
  const part = { kind: ARTIFACT_PART_KIND, name: "f.bin", mediaType: "application/octet-stream", digest: D, size: 3 };
  const ack = await a.multicastWithAck("here is a file", { channel: CHANNEL, parts: [part] as never });
  check("the agent's publish ack carries a usable stream sequence", Number.isInteger(ack.seq) && ack.seq > 0, ack.seq);

  // ---- seed the state the fence reads, with the fixture cred ---------------------------------
  const seedId = newIdentity();
  const seedNc = await connect({
    servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(await mintIndexSeeder(auth, seedId))),
    inboxPrefix: `_INBOX_${seedId.id}`, maxReconnectAttempts: 0,
  });
  const seedKvm = new Kvm(seedNc);
  const seedPossession = await seedKvm.open(possessionBucket(SPACE));
  const seedAttachments = await seedKvm.open(attachmentBucket(SPACE));
  await seedPossession.put(possessionKey(D, CALLER, uidA), enc({ ok: true }));
  // A pre-existing attachment row on an UNRELATED digest, so A7 can prove the delivery cred READS
  // this bucket without depending on a write it has not performed yet.
  await seedAttachments.put(attachmentKey(D_OTHER, CHANNEL), enc({ attacherLifecycleUid: uidA, createdAt: 1 }));

  // =============================================================================================
  // THE GRANT ITSELF, driven on a raw connection holding EXACTLY the shipped delivery credential.
  // This is deliberately not the daemon's own internals: the credential is the artifact the world
  // holds, so it is the thing measured.
  // =============================================================================================
  const dlvNc = await connect({
    servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(dlvCreds)),
    inboxPrefix: `_INBOX_${dlvId.id}`, maxReconnectAttempts: 0,
  });
  const dlvKvm = new Kvm(dlvNc);
  const dlvMembers = await dlvKvm.open(membersBucket(SPACE));
  const dlvPossession = await dlvKvm.open(possessionBucket(SPACE));
  const dlvAttachments = await dlvKvm.open(attachmentBucket(SPACE));
  const dlvJsm = await jetstreamManager(dlvNc);

  // ---- A1-CONTROL — the arm that must SUCCEED, and every absence below leans on it -------------
  {
    const r = await drive(() => dlvMembers.put("smokeprobe.grantshape", enc({ probe: true })));
    check("A1-CONTROL: the delivery cred's KV WRITE route is real — a known-granted members-KV put SUCCEEDS",
      r.kind === "ok", r);
  }

  // ---- A5 — THE FENCE, as an answer from nats-server rather than a missing string ---------------
  {
    const r = await drive(() => dlvPossession.put(possessionKey(D, CALLER, uidA), enc({ forged: true })));
    check("A5-ABSENCE: the delivery cred is DENIED a possession VALUE-WRITE (same put shape as A1)",
      r.kind === "denied", r);
  }

  // ---- A6/A7/A8 — the three reads the call graph needs, each driven on its own -----------------
  {
    const r = await drive(() => dlvPossession.get(possessionKey(D, CALLER, uidA)));
    check("A6: the delivery cred READS the possession row the fence checks",
      r.kind === "ok" && r.value !== null, r);
  }
  {
    const r = await drive(() => dlvAttachments.get(attachmentKey(D_OTHER, CHANNEL)));
    check("A7: the delivery cred READS the attachment index (the create-lost arm's confirming get)",
      r.kind === "ok" && r.value !== null, r);
  }
  {
    const r = await drive(() => dlvJsm.streams.getMessage(chatStream(SPACE), { seq: ack.seq }));
    const subject = (r.kind === "ok" ? (r.value as { subject?: string } | null)?.subject : undefined);
    check("A8: the delivery cred GETS the CHAT entry by seq — the verb's first call, and where it died",
      r.kind === "ok" && subject === chatSubject(SPACE, DEV_OWNER, aId.id, CHANNEL), { r, subject });
  }

  // =============================================================================================
  // THE END-TO-END. A real agent credential publishing a real request onto its own control subject,
  // answered by a daemon holding only the shipped delivery credential. This has never run before.
  // =============================================================================================
  const agentNc = await connect({
    servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(aCreds)),
    inboxPrefix: `_INBOX_${aId.id}`, maxReconnectAttempts: 0,
  });
  const rail = async (op: string, args: Record<string, unknown>): Promise<{ ok: boolean; error?: string; data?: unknown }> => {
    const subject = controlServiceSubject(SPACE, CONTROL_DELIVERY, DEV_OWNER, aId.id);
    const m = await agentNc.request(
      subject,
      JSON.stringify({ op, args, from: { ...a.ref(), id: CALLER } }),
      { timeout: 5000, noMux: true, reply: `${subject}.reply.${randomUUID()}` },
    );
    return m.json();
  };

  // ---- A2 — the arm the whole grade turns on ---------------------------------------------------
  {
    const r = await rail("confirmAttach", { digest: D, channel: CHANNEL, seq: ack.seq });
    check("A2: a legitimate confirmAttach SUCCEEDS against the real minted delivery credential", r.ok === true, r);
  }

  /**
   * Read the attachment row through the SEEDER credential — never the one under test.
   *
   * A row read back through the credential that wrote it proves the write path agreed with itself.
   * Reading through a different credential is what makes it a statement about the BUCKET.
   */
  const readAttachment = async (): Promise<{ attacherLifecycleUid?: string; createdAt?: number } | undefined> => {
    const r = await drive(() => seedAttachments.get(attachmentKey(D, CHANNEL)));
    return r.kind === "ok" && r.value !== null
      ? JSON.parse(new TextDecoder().decode((r.value as { value: Uint8Array }).value)) as { attacherLifecycleUid?: string; createdAt?: number }
      : undefined;
  };

  // ---- A3 — read back through a DIFFERENT credential than the one that wrote it -----------------
  const rowAfterFirstConfirm = await readAttachment();
  check("A3: the attachment row is really in the bucket, carrying the CONFIRMING lifecycle",
    rowAfterFirstConfirm?.attacherLifecycleUid === uidA, rowAfterFirstConfirm);
  // A12 below compares against this. Asserted here rather than trusted, because a comparison whose
  // BASELINE is undefined passes for the wrong reason: `undefined === undefined` is a green cell
  // over two rows that never existed.
  check("A12-BASELINE: the first confirm wrote a usable numeric createdAt to compare against",
    typeof rowAfterFirstConfirm?.createdAt === "number", rowAfterFirstConfirm);

  // ---- A4 — the repeat confirm, which is the only thing that exercises the attachment READ ------
  // The second call loses `kv.create` and must confirm the row through `kv.get`. Without the
  // attachment MSG.GET grant this is the arm that fails while A2 still passes.
  {
    const r = await rail("confirmAttach", { digest: D, channel: CHANNEL, seq: ack.seq });
    check("A4: a REPEAT confirm still succeeds (create-lost → confirming get on the attachment bucket)",
      r.ok === true, r);
  }

  // ---- A12 — LIFETIME NEUTRALITY, END TO END, WHICH NOTHING ELSE IN THIS SUITE HOLDS -----------
  // A4 above asserts the repeat confirm returns `ok:true`. **AN UPSERTING VERB RETURNS `ok:true`
  // TOO**, so A4 passes either way — it measures the attachment READ grant, which is what it was
  // built for, and lifetime-neutrality is simply not in its reach. A3 reads the row back but looks
  // only at `attacherLifecycleUid`.
  //
  // So before this cell, the end-to-end claim that attach is lifetime-neutral rested on
  // `putAttachmentIfAbsent` choosing `kv.create` plus a reading of the source. That invariant is
  // the whole of §7: `createdAt` is the field a row ages from, and refreshing it on every confirm
  // turns any legitimate publisher into an unbounded-retention primitive without it ever calling
  // `pin`. Its own doc records that it "was stated in a comment and enforced NOWHERE" until a
  // driven attack rewrote it — this is the cell that keeps that from being true again one level up.
  {
    const after = await readAttachment();
    check("A12: a REPEAT confirm did NOT refresh createdAt — attach is lifetime-neutral at the broker",
      typeof after?.createdAt === "number"
        && after.createdAt === rowAfterFirstConfirm?.createdAt,
      { before: rowAfterFirstConfirm?.createdAt, after: after?.createdAt });
  }

  // ---- A13 — WHAT THE ATTACHMENT GRANT LICENSES BEYOND THE TWO CALLS THAT MOTIVATED IT ---------
  // `provision.ts` grants `$KV.<attachmentBucket>.>` and documents it as covering `kv.create`
  // (insert-if-absent) and `kv.delete` (the lost-race rollback). Both are real. But KV create-only
  // semantics ride the `Nats-Expected-Last-Subject-Sequence: 0` HEADER, not the subject, so the
  // same row equally licenses a plain PUT — an OVERWRITE the verb never performs.
  //
  // THIS CELL IS NOT A DEFECT CELL AND MUST NOT BE READ AS ONE. NATS cannot express insert-only at
  // subject arity, and the attachment index genuinely needs write, so no ABSENCE is available here
  // the way it is for possession (A5). The point is to state the true shape of the boundary so the
  // comment above the grant stops implying a confinement the subject cannot express: the
  // lifetime-neutrality invariant is enforced by `putAttachmentIfAbsent` in client code, NOT by the
  // credential. A12 is what guards it; this cell says why A12 has to.
  //
  // A1-CONTROL is this cell's control in the ALLOWED direction — same connection, same client, same
  // `kv.put` shape at a known-granted bucket — so an `ok` here is a statement about this subject
  // rather than about a probe that happens to succeed at everything.
  {
    const r = await drive(() => dlvAttachments.put(attachmentKey(D_OTHER, CHANNEL), enc({ overwritten: true })));
    check("A13: the delivery cred IS ALLOWED a raw attachment PUT — the grant is not insert-only, and only client code makes it so",
      r.kind === "ok", r);
  }

  // ---- A10 — a refusal must still be a REFUSAL, not a broker denial wearing `ok:false` ----------
  // Under a missing grant every reply is `ok:false`, so this cell is what separates "the fence
  // refused you" from "the daemon could not run the fence". It names the exact refusal, and A2
  // above is its control that the same rail can succeed.
  {
    const r = await rail("confirmAttach", { digest: D_OTHER, channel: CHANNEL, seq: ack.seq });
    refuses("A10: an unpossessed digest gets the exact notYours refusal — not a permissions error", r, ATTACH_REFUSAL.notYours);
  }

  // ---- A11 — and the fence is still a fence after the widening --------------------------------
  // The grant fold added attachment WRITE. If it had also added possession write, A5 would catch it
  // as a subject; this catches it as a CONSEQUENCE: a caller with no possession row must not be able
  // to make one exist by asking.
  {
    const r = await drive(() => dlvPossession.get(possessionKey(D_OTHER, CALLER, uidA)));
    check("A11: no possession row was manufactured for the refused digest", r.kind === "ok" && r.value === null, r);
  }

  await agentNc.close();
  await dlvNc.close();
  await seedNc.close();
  await a.stop();
  await dlv.stop();
  await mgr.stop();
} finally {
  const survivors = await stopBrokerAndClean(broker, sd);
  if (survivors.length > 0) {
    fail++;
    console.log("  ✗ FAIL: broker survivors (scratch PRESERVED for attribution):", survivors);
  }
}

console.log(`\nartifact-rail-authz: ${ok} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
