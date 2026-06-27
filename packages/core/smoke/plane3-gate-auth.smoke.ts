/**
 * Plane-3 hardening gates (Stage-4) against a REAL auth broker — the scenarios the adversarial reviews
 * of the committed machinery required:
 *
 *  (1) MANAGER-RECONNECT (impl-review BLOCKER-1): the durable backstop SURVIVES a broker restart. The
 *      manager re-arms its fan-out writer + trusted reader on reconnect (armPlane3 in connectAndBind),
 *      so a post after the blip still reaches a durable member. Mutation: drop the connectAndBind
 *      armPlane3 call and this goes red (loops die, nothing fans out).
 *  (2) BUSY-CHANNEL CATCH-UP (impl-review HIGH-2): a durable join on a busy multi-channel space is NOT
 *      falsely degraded to durable:false. Eviction is judged per-subject (channelDropped), not against
 *      the stream-global joinCursor+1 which other channels' traffic inflates. Mutation: revert the
 *      eviction check to `firstDeliveredSeq > joinCursor+1` and this goes red.
 *
 * Run: pnpm smoke:plane3-gate:auth   (needs `nats-server` on PATH; auth/JetStream, local-only)
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
} from "../src/index.js";

const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (cond: () => boolean, timeoutMs = 10000, stepMs = 50): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await wait(stepMs);
  return cond();
};
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const space = `plane3gate-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-plane3gate-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
let server = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);

  const mgrId = newIdentity();
  const mgrCreds = await mintCreds(auth, mgrId, "manager");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  const mgr = new CotalEndpoint({
    space, servers: SERVERS, creds: mgrCreds,
    card: { id: mgrId.id, name: "mgr", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: false,
  });
  mgr.on("error", (e: Error) => console.error("  ! mgr", e.message));
  await mgr.start();
  // Plane-3 host = the server-side delivery daemon (scoped `delivery` cred), NOT the
  // manager — the manager cred no longer carries the Plane-3 inject grants (closure (i)).
  // The manager stays provisioner + publisher; only the HOST endpoint moves here. The
  // backstop must survive the broker restart below — the delivery endpoint auto-reconnects
  // and re-arms Plane-3 (armPlane3 in connectAndBind), exactly as the manager-host did.
  const dlvId = newIdentity();
  const dlv = new CotalEndpoint({
    space, servers: SERVERS, creds: await mintCreds(auth, dlvId, "delivery"),
    card: { id: dlvId.id, name: "delivery", role: "delivery", kind: "endpoint" },
    channels: [], consume: false, registerPresence: false, watchPresence: true,
  });
  dlv.on("error", (e: Error) => console.error("  ! dlv", e.message));
  await dlv.start();

  const aId = newIdentity();
  const aCreds = await provisionAgent(mgr, auth, aId, { subscribe: ["general"], allowSubscribe: ["general", "review"] });
  await dlv.startPlane3((id) => (id === aId.id ? ["general", "review"] : undefined));

  const a = new CotalEndpoint({
    space, servers: SERVERS, creds: aCreds,
    card: { id: aId.id, name: "alice", kind: "agent" },
    channels: ["general"], heartbeatMs: 500, ttlMs: 2000,
  });
  const got: string[] = [];
  a.on("error", () => {});
  a.on("message", (m, d: Delivery) => { got.push(m.parts.map((p) => (p.kind === "text" ? p.text : "")).join("")); d.ack(); });
  await a.start();
  await wait(300);

  // ───────────── (2) BUSY-CHANNEL CATCH-UP: no false eviction on a busy multi-channel space ─────────────
  // Pile traffic onto a DIFFERENT channel so the stream-global seq is far ahead of review's frontier,
  // then durable-join review (which has no traffic in the activation window). A per-subject eviction
  // check returns durable:true; the buggy global-seq check would false-positive eviction → durable:false.
  for (let i = 0; i < 40; i++) await mgr.multicast(`noise-${i}`, { channel: "general" });
  await wait(200);
  const rj = await dlv.durableJoinFor(aId.id, "review");
  check("busy multi-channel space: durable join is NOT falsely degraded (durable:true)", rj.durable === true, rj);
  await mgr.multicast("after-busy-join", { channel: "review" });
  check("busy-join member receives the post via the backstop", await until(() => got.includes("after-busy-join")), got);

  // ───────────── (1) MANAGER-RECONNECT: the backstop survives a broker restart ─────────────
  got.length = 0;
  server.kill("SIGKILL");
  await awaitExit(server); // the restart reuses PORT — the old broker must free the socket first
  server = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
  let back = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { back = true; break; } await wait(200); }
  if (!back) throw new Error("broker did not restart");
  await wait(3500); // dlv + agent reconnect; the delivery host re-arms fan-out + reader (armPlane3 in connectAndBind)
  await mgr.multicast("after-broker-restart", { channel: "review" });
  check(
    "durable backstop SURVIVES a broker restart — post still reaches the member (Plane-3 re-armed)",
    await until(() => got.includes("after-broker-restart"), 12000),
    got,
  );

  await a.stop();
  await dlv.stop();
  await mgr.stop();
  console.log(`\nPLANE-3 GATE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
} finally {
  server.kill("SIGKILL");
  await awaitExit(server);
  rmSync(dir, { recursive: true, force: true });
}
process.exit(fail === 0 ? 0 : 1);
