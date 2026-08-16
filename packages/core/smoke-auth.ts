/**
 * Auth-mode end-to-end smoke (no test runner) — the open `smoke.ts` flow under JWT auth.
 * Spins up its OWN JWT-auth nats-server, mints scoped per-peer creds, and proves the full
 * delivery surface works authenticated: multicast (+ normalized mentions), unicast, anycast,
 * offline-DM durability, presence-status propagation, and channel membership (live/stale).
 * alice/bob/carol are scoped agents, exactly as a real spawn provisions them.
 * Run: pnpm smoke:auth
 *
 * WHO READS MEMBERSHIP, AND WHY IT IS NOT THE PROVISIONER. `channelMembers()` answers from two
 * places at once: the authoritative members KV registry, and the endpoint's own presence-watch
 * cache, which is what turns a member id into a name and a `live` flag. So the credential that
 * calls it needs BOTH members-read and presence-read, and after #161 deleted the allow-all
 * `manager` cred exactly one profile has both: `delivery` — the Plane-3 daemon, whose grant
 * comments say "presence (@mention resolve) + channel registry + members + ACL". That is also
 * the component that does this in production, so reading membership here on a delivery
 * credential is the honest fixture rather than a convenience.
 *
 * The provisioner provisions and does nothing else. It deliberately holds NO presence grant, so
 * it must not watch presence; #161 is the gate that made that true and widening it to make this
 * file pass would remove the property that commit exists to establish.
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint,
  isReachable,
  createSpaceAuth,
  mintCreds,
  provisionAgent,
  serverConfig,
  newIdentity,
  setupSpaceStreams,
  mintLifecycleUid,
  principalKey,
  DEV_OWNER,
  type Delivery,
} from "./src/index.js";
import { pickFreePort } from "./smoke/_free-port.js";

// Fresh OS-assigned port per run + await-exit on the broker kill (finally): a FIXED port plus a SIGKILL that
// doesn't await the child's exit leaks the broker, and the next run collides with the squatter (the
// "Authorization Violation" reviewers hit). Same leak-class fix the channels/self-serve smokes carry.
const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
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

const space = `smoke-auth-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-smokeauth-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50; i++) {
    if (await isReachable(SERVERS)) {
      up = true;
      break;
    }
    await wait(200);
  }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  // Privileged setup. Provisioning only: no presence watch, because this profile holds no
  // presence grant (see the header). A KV watch creates a consumer, so asking for one here is a
  // publish to `$JS.API.CONSUMER.CREATE.KV_<presence>...` that the broker refuses — and it
  // refuses it during start(), before a single check has run.
  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  const mgr = new CotalEndpoint({
    space,
    servers: SERVERS,
    creds: mgrCreds,
    card: { name: "mgr", kind: "endpoint" },
    consume: false,
    registerPresence: false,
    watchPresence: false,
    heartbeatMs: 300,
    ttlMs: 1500,
  });
  mgr.on("error", (e: Error) => console.error("  ! mgr", e.message));
  await mgr.start();

  // The membership reader, on the one profile that may hold both halves of the answer. Started
  // here rather than just before the reads: its presence cache has to be watching while alice and
  // bob come up and while bob goes away, or the live/stale distinction below is measuring a cache
  // that was empty the whole time and would report every member stale.
  const readerCreds = await mintCreds(auth, newIdentity(), "delivery");
  const reader = new CotalEndpoint({
    space,
    servers: SERVERS,
    creds: readerCreds,
    card: { name: "membership-reader", kind: "endpoint" },
    consume: false,
    registerPresence: false,
    watchPresence: true,
    heartbeatMs: 300,
    ttlMs: 1500,
  });
  reader.on("error", (e: Error) => console.error("  ! reader", e.message));
  await reader.start();

  // Provision the three peers exactly as a launcher would: bind-only DM (+ role TASK) durables
  // and scoped creds. carol is provisioned now but connects late (offline-DM durability).
  const aliceId = newIdentity();
  const bobId = newIdentity();
  const carolId = newIdentity();
  // One lifecycle uid per agent, minted here and carried onto BOTH the provision call and the
  // endpoint. A footprint is lifecycle-keyed (SPEC 13.1): the durables the provisioner pre-creates
  // are named for this uid, so an endpoint that connects under a different one binds nothing.
  const aliceUid = mintLifecycleUid();
  const bobUid = mintLifecycleUid();
  const carolUid = mintLifecycleUid();
  const acl = { subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"] };
  const aliceCreds = await provisionAgent(mgr, auth, aliceId, { ...acl, role: "planner", lifecycleUid: aliceUid });
  const bobCreds = await provisionAgent(mgr, auth, bobId, { ...acl, role: "builder", lifecycleUid: bobUid });
  const carolCreds = await provisionAgent(mgr, auth, carolId, { ...acl, role: "tester", lifecycleUid: carolUid });

  // Plane-3, hosted on the same delivery endpoint that reads membership - which is what the
  // delivery daemon is in production. It has to run, and has to run BEFORE the agents connect:
  // the members registry is written when a join is activated by the trusted reader, so with no
  // Plane-3 host nothing ever writes it and `channelMembers()` answers an empty list for a space
  // whose peers are plainly there. The three membership checks then fail rather than measure, and
  // they fail for a reason that has nothing to do with membership.
  const aclFor = new Map([
    [principalKey(DEV_OWNER, aliceId.id).key, acl.allowSubscribe],
    [principalKey(DEV_OWNER, bobId.id).key, acl.allowSubscribe],
    [principalKey(DEV_OWNER, carolId.id).key, acl.allowSubscribe],
  ]);
  await reader.startPlane3((owner) => aclFor.get(owner));

  const a = new CotalEndpoint({
    space,
    servers: SERVERS,
    creds: aliceCreds,
    lifecycleUid: aliceUid,
    card: { id: aliceId.id, name: "alice", role: "planner", kind: "agent" },
    channels: ["general"],
    heartbeatMs: 500,
    ttlMs: 2000,
  });
  const b = new CotalEndpoint({
    space,
    servers: SERVERS,
    creds: bobCreds,
    lifecycleUid: bobUid,
    card: { id: bobId.id, name: "bob", role: "builder", kind: "agent" },
    channels: ["general"],
    heartbeatMs: 500,
    ttlMs: 2000,
  });
  a.on("error", (e: Error) => console.error("  ! alice:", e.message));
  b.on("error", (e: Error) => console.error("  ! bob:", e.message));

  const got: string[] = [];
  let bobSawMentions: string[] | undefined;
  b.on("message", (m, d: Delivery) => {
    const text = m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
    const kind = m.to ? "DM" : m.toService ? "ANY:" + m.toService : "#" + (m.channel ?? "");
    got.push(`${kind}:${m.from.name}:${text}`);
    if (text === "hello team") bobSawMentions = m.mentions;
    d.ack();
  });

  await a.start();
  await b.start();
  await wait(800);

  await a.setStatus("working");
  // Mentions ride the multicast payload: normalized (trim + lowercase + dedupe), omitted when empty.
  const sent = await a.multicast("hello team", { channel: "general", mentions: ["BOB", " bob ", "carol", ""] });
  const omitted = await a.multicast("noping", { channel: "general", mentions: [""] });
  await wait(300);

  const bob = a.getRoster().find((p) => p.card.name === "bob");
  // Addressed by PRINCIPAL (<owner>.<actor>), not by the card's bare nkey: the owner+actor cutover
  // made a nkey an invalid recipient, and the roster still carries the nkey as the card id.
  if (bob) await a.unicast(principalKey(DEV_OWNER, bobId.id).key, "psst bob");
  await wait(300);

  // anycast to the "builder" service — bob (role: builder, svc durable pre-provisioned) gets it.
  await a.anycast("builder", "build the thing");
  await wait(300);

  // Durability: a DM sent to carol BEFORE she connects must still arrive (her durable holds it).
  await a.unicast(principalKey(DEV_OWNER, carolId.id).key, "stored while you were away");
  await wait(200);
  const carol = new CotalEndpoint({
    space,
    servers: SERVERS,
    creds: carolCreds,
    lifecycleUid: carolUid,
    card: { id: carolId.id, name: "carol", role: "tester", kind: "agent" },
    channels: ["general"],
    heartbeatMs: 500,
    ttlMs: 2000,
  });
  carol.on("error", (e: Error) => console.error("  ! carol:", e.message));
  const carolGot: string[] = [];
  carol.on("message", (m, d: Delivery) => {
    carolGot.push(m.parts.map((p) => (p.kind === "text" ? p.text : "")).join(""));
    d.ack();
  });
  await carol.start();
  await wait(600);

  const aliceInB = b.getRoster().find((p) => p.card.name === "alice");

  // Membership = the privileged members KV registry ∩ presence liveness — read on the delivery
  // credential, the only profile holding both halves (see the header).
  const preLeave = await reader.channelMembers("general");
  const allChannels = await reader.channelMembers();

  await b.stop();
  await wait(500);
  const bobInA = a.getRoster().find((p) => p.card.name === "bob");

  // Bob's membership record persists past his stop (stop ≠ leave — no tombstone), but presence flipped
  // offline: he stays visible as a STALE member (live:false), distinct from still-live alice.
  const afterLeave = await reader.channelMembers("general");
  const bobMember = afterLeave.find((m) => m.name === "bob");
  const aliceMember = afterLeave.find((m) => m.name === "alice");

  const mentionsNormalized = JSON.stringify(sent.mentions) === JSON.stringify(["bob", "carol"]);
  const emptyOmitted = omitted.mentions === undefined;
  const membershipLive =
    preLeave.some((m) => m.name === "alice" && m.live) && preLeave.some((m) => m.name === "bob" && m.live);
  const membershipMap = (allChannels.get("general") ?? []).some((m) => m.name === "alice");
  const membershipStale = bobMember?.live === false && aliceMember?.live === true;

  check("multicast delivered to a peer (#general)", got.some((g) => g.startsWith("#general")), got);
  check("unicast delivered (DM)", got.some((g) => g.startsWith("DM")), got);
  check("anycast delivered to the builder role", got.some((g) => g.startsWith("ANY:builder")), got);
  check("offline DM held + delivered on connect", carolGot.some((g) => g.includes("stored while you were away")), carolGot);
  check("mentions normalized on the wire", mentionsNormalized, sent.mentions);
  check("empty mentions omitted", emptyOmitted, omitted.mentions);
  check("recipient saw the mention", bobSawMentions?.includes("bob") === true, bobSawMentions);
  check("presence status propagates (alice=working)", aliceInB?.status === "working", aliceInB?.status);
  check("presence flips offline on stop (bob)", bobInA?.status === "offline", bobInA?.status);
  check("the membership reader sees live membership", membershipLive, preLeave);
  check("no-arg channelMembers maps every channel", membershipMap, [...allChannels.keys()]);
  check("left member goes stale, live member stays live", membershipStale, afterLeave);

  await carol.stop();
  await a.stop();
  await reader.stop();
  await mgr.stop();
} catch (e) {
  fail++;
  console.error("  ✗ auth scenario threw:", (e as Error).message);
} finally {
  srv.kill("SIGKILL");
  await awaitExit(srv); // await actual exit so a failed run never leaks the broker onto its port
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "AUTH SMOKE OK ✅" : "AUTH SMOKE FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
