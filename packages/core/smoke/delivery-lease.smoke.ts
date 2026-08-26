/**
 * delivery single-flight lease smoke. Two clients binding the same `fanout`/`reader` durable name SPLIT
 * delivery, so the daemon CAS-acquires a per-shard lease BEFORE binding and refuses (loud exit) if a live
 * lease exists. Asserts: a second acquire on the same shard THROWS; the lease flips ready only after a
 * mark; a ready lease held by ANOTHER daemon does not satisfy a wait for the daemon we launched
 * (#837); release frees it so a fresh acquire succeeds.
 *
 * Run: pnpm smoke:delivery-lease:auth   (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CotalEndpoint, isReachable, createSpaceAuth, mintCreds, serverConfig, newIdentity, setupSpaceStreams, waitForDeliveryLease } from "../src/index.js";
import { pickFreePort } from "./_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, t = 3000): Promise<void> =>
  new Promise((resolve) => { if (proc.exitCode !== null || proc.signalCode !== null) return resolve(); proc.once("exit", () => resolve()); setTimeout(resolve, t); });
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const space = `delivery-lease-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);

const mkDaemon = async () =>
  new CotalEndpoint({
    space, servers: SERVERS, creds: await mintCreds(auth, newIdentity(), "delivery"), channels: [],
    consume: false, watchPresence: false, registerPresence: false,
    card: { name: "delivery", role: "delivery", kind: "endpoint" },
  });

let d1: CotalEndpoint | undefined, d2: CotalEndpoint | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  d1 = await mkDaemon(); d1.on("error", () => {}); await d1.start();
  d2 = await mkDaemon(); d2.on("error", () => {}); await d2.start();

  const rev1 = await d1.acquireDeliveryLease(0);
  check("first daemon acquires the shard-0 lease", typeof rev1 === "number");

  let secondThrew = false;
  try { await d2.acquireDeliveryLease(0); } catch { secondThrew = true; }
  check("a second daemon on the same shard is REFUSED (CAS create fails)", secondThrew);

  const before = await d1.readDeliveryLease(0);
  check("lease is NOT ready until the daemon marks it (responder bound)", before?.ready === false);
  await d1.markDeliveryLeaseReady(0, rev1);
  const after = await d1.readDeliveryLease(0);
  check("lease reads ready + held by the first daemon after markReady", after?.ready === true && after?.holder === d1.card.id);

  // #837: WHOSE readiness. `waitForDeliveryLease` used to accept ANY ready lease, so a launcher
  // waiting on the daemon it had just started was answered by a DIFFERENT daemon's record — and a
  // SIGKILLed holder leaves exactly such a record behind for the rest of the bucket TTL. The
  // replacement that lost the CAS and exited was then reported ready, and `up` printed green with no
  // daemon running at all. The lease here is ready and held by d1; d2 is the daemon nobody started.
  const probeId = newIdentity();
  const probeCreds = await mintCreds(auth, probeId, "delivery");
  const waitFor = (holder: string | undefined) =>
    waitForDeliveryLease({ servers: SERVERS, space, creds: probeCreds, id: probeId.id, holder, timeoutMs: 1500 });
  check("CONTROL: waiting for the lease's ACTUAL holder sees it ready", await waitFor(d1.card.id));
  check("a ready lease held by another daemon does NOT answer for the one we launched", (await waitFor(d2.card.id)) === false);
  check("CONTROL: an unnamed holder (adopting a running daemon) still accepts any ready lease", await waitFor(undefined));

  await d1.releaseDeliveryLease(0);
  let reacquired = false;
  try { await d2.acquireDeliveryLease(0); reacquired = true; } catch { /* still held */ }
  check("after release, a fresh daemon CAN acquire the freed lease", reacquired);

  console.log(`\nDELIVERY-LEASE SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  try { await d1?.stop(); } catch { /* ignore */ }
  try { await d2?.stop(); } catch { /* ignore */ }
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
