/**
 * delivery leave-after-ACL-narrow smoke (security blocker 3 — the §7 leave-boundary guard). durableLeave
 * must NOT be gated on the caller's CURRENT read ACL: leave fires precisely when the ACL was narrowed/
 * revoked (a refused live sub → closeRefusedMembership), and gating the tombstone on the current ACL
 * would loop forever, leaving the SPEC §7 boundary open (the membership could resume if the ACL is later
 * restored). Asserts the split: JOIN stays ACL-gated, LEAVE tombstones regardless of the current ACL.
 *
 * Run: pnpm smoke:delivery-leave-tombstone:auth   (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, isReachable, createSpaceAuth, mintCreds, provisionAgent, serverConfig, newIdentity, setupSpaceStreams } from "../src/index.js";

const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, t = 3000): Promise<void> =>
  new Promise((resolve) => { if (proc.exitCode !== null || proc.signalCode !== null) return resolve(); proc.once("exit", () => resolve()); setTimeout(resolve, t); });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const space = `delivery-leave-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-leave-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

let mgr: CotalEndpoint | undefined, daemon: CotalEndpoint | undefined, agent: CotalEndpoint | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });

  // Privileged provisioner endpoint (allow-all) — writes + narrows the ACL registry (a manager-cred job).
  mgr = new CotalEndpoint({ space, servers: SERVERS, creds: mgrCreds, channels: [], consume: false, watchPresence: false, registerPresence: false, card: { name: "prov", role: "manager", kind: "endpoint" } });
  mgr.on("error", () => {}); await mgr.start();

  // Delivery daemon — hosts Plane-3 + serves ctl.delivery (validates join against the ACL registry).
  daemon = new CotalEndpoint({ space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "delivery"), channels: [], consume: false, watchPresence: true, registerPresence: false, card: { name: "delivery", role: "delivery", kind: "endpoint" } });
  daemon.on("error", () => {}); await daemon.start();
  await daemon.startPlane3((owner) => daemon!.aclForOwner(owner));

  // Provision an agent with read ACL [review] (commitAcl writes it via the privileged provisioner).
  const aId = newIdentity();
  const aCreds = await provisionAgent(mgr, auth, aId, { allowSubscribe: ["review"], subscribe: ["review"] });
  agent = new CotalEndpoint({ space, servers: SERVERS, creds: aCreds, channels: [], consume: false, watchPresence: false, registerPresence: false, card: { id: aId.id, name: "alice", role: "agent", kind: "agent" } });
  agent.on("error", () => {}); await agent.start();

  // Sanity: join succeeds while "review" is in the ACL.
  const r = await agent.durableJoinChannel("review");
  check("durableJoin succeeds while the channel is in the read ACL", r.durable === true);
  const gen = r.generation ?? 0;

  // Narrow the agent's ACL to NOTHING (revocation) — as the broker would for a refused live sub.
  await mgr.commitAcl(aId.id, []);
  await wait(150);

  // JOIN is now rejected (join stays current-ACL-gated).
  let joinRejected = false;
  try { await agent.durableJoinChannel("review"); } catch { joinRejected = true; }
  check("durableJOIN is REJECTED after the ACL is narrowed (join is ACL-gated)", joinRejected);

  // LEAVE still tombstones (leave is NOT ACL-gated — closes the §7 boundary so it can't resume).
  let leftOk = false;
  try { await agent.durableLeaveChannel("review", gen); leftOk = true; }
  catch (e) { console.log(`    (leave threw: ${(e as Error).message})`); }
  check("durableLEAVE still tombstones after ACL narrowing (leave NOT ACL-gated — §7 boundary closes)", leftOk);

  console.log(`\nDELIVERY-LEAVE-TOMBSTONE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  try { await agent?.stop(); } catch { /* ignore */ }
  try { await daemon?.stop(); } catch { /* ignore */ }
  try { await mgr?.stop(); } catch { /* ignore */ }
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
}
