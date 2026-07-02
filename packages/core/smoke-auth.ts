/**
 * Auth-mode end-to-end smoke (no test runner) — the open `smoke.ts` flow under JWT auth.
 * Spins up its OWN JWT-auth nats-server, mints scoped per-peer creds, and proves the full
 * delivery surface works authenticated: multicast (+ normalized mentions), unicast, anycast,
 * offline-DM durability, presence-status propagation, and channel membership (live/stale).
 * channelMembers() reads the manager-only members KV registry, so a manager endpoint reads it
 * (alice/bob/carol are scoped agents, exactly as a real spawn provisions them).
 * Run: pnpm smoke:auth
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
  type Delivery,
} from "./src/index.js";

// Fresh random port per run + await-exit on the broker kill (finally): a FIXED port plus a SIGKILL that
// doesn't await the child's exit leaks the broker, and the next run collides with the squatter (the
// "Authorization Violation" reviewers hit). Same leak-class fix the channels/self-serve smokes carry.
const PORT = 20000 + Math.floor(Math.random() * 40000);
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
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
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

  // Privileged setup + the membership reader (manager profile: allow-all).
  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  const mgr = new CotalEndpoint({
    space,
    servers: SERVERS,
    creds: mgrCreds,
    card: { name: "mgr", kind: "endpoint" },
    consume: false,
    registerPresence: false,
    watchPresence: true,
    heartbeatMs: 300,
    ttlMs: 1500,
  });
  mgr.on("error", (e: Error) => console.error("  ! mgr", e.message));
  await mgr.start();

  // Provision the three peers exactly as a launcher would: bind-only DM (+ role TASK) durables
  // and scoped creds. carol is provisioned now but connects late (offline-DM durability).
  const aliceId = newIdentity();
  const bobId = newIdentity();
  const carolId = newIdentity();
  const acl = { subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"] };
  const aliceCreds = await provisionAgent(mgr, auth, aliceId, { ...acl, role: "planner" });
  const bobCreds = await provisionAgent(mgr, auth, bobId, { ...acl, role: "builder" });
  const carolCreds = await provisionAgent(mgr, auth, carolId, { ...acl, role: "tester" });

  const a = new CotalEndpoint({
    space,
    servers: SERVERS,
    creds: aliceCreds,
    card: { id: aliceId.id, name: "alice", role: "planner", kind: "agent" },
    channels: ["general"],
    heartbeatMs: 500,
    ttlMs: 2000,
  });
  const b = new CotalEndpoint({
    space,
    servers: SERVERS,
    creds: bobCreds,
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
  if (bob) await a.unicast(bob.card.id, "psst bob");
  await wait(300);

  // anycast to the "builder" service — bob (role: builder, svc durable pre-provisioned) gets it.
  await a.anycast("builder", "build the thing");
  await wait(300);

  // Durability: a DM sent to carol BEFORE she connects must still arrive (her durable holds it).
  await a.unicast(carolId.id, "stored while you were away");
  await wait(200);
  const carol = new CotalEndpoint({
    space,
    servers: SERVERS,
    creds: carolCreds,
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

  // Membership = the privileged members KV registry ∩ presence liveness — read by the manager.
  const preLeave = await mgr.channelMembers("general");
  const allChannels = await mgr.channelMembers();

  await b.stop();
  await wait(500);
  const bobInA = a.getRoster().find((p) => p.card.name === "bob");

  // Bob's membership record persists past his stop (stop ≠ leave — no tombstone), but presence flipped
  // offline: he stays visible as a STALE member (live:false), distinct from still-live alice.
  const afterLeave = await mgr.channelMembers("general");
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
  check("manager sees live membership", membershipLive, preLeave);
  check("no-arg channelMembers maps every channel", membershipMap, [...allChannels.keys()]);
  check("left member goes stale, live member stays live", membershipStale, afterLeave);

  await carol.stop();
  await a.stop();
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
