/**
 * THE CARD'S DELIVERY ROW, DRIVEN AGAINST A REAL DAEMON — reachability, not just decision.
 *
 * `bin/smoke/delivery-row.smoke.ts` covers the row's decision with hand-built seams. This suite
 * exists because that is not enough: a killed mutation proves a test DEPENDS on the code, not that a
 * real entry point REACHES it. Cells that construct their own `check` stay green even if the caller
 * mint produces a credential that cannot read the lease at all — which is the precise failure the
 * credential-class arms were run to prevent, and the one that would ship a row reporting
 * `no-responder` ("the daemon did not answer") when the truth is "I was never permitted to ask".
 *
 * SO NOTHING HERE IS BUILT BY HAND. A real space auth mints a real agent-class caller, which
 * connects to a real broker and reads a real daemon's lease over a real round-trip.
 *
 * Predictions are registered in `.lane/card-row-predictions.md` and were committed before this ran.
 * NOT A GATE — this is one scoped suite.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createSpaceAuth, isReachable, LEASE_TTL_MS, mintCreds, newIdentity, serverConfig, setupSpaceStreams,
} from "@cotal-ai/core";
import { workspaceSecretStore, putSpaceAuth } from "@cotal-ai/workspace";
import { mintDeliveryCaller } from "../src/lib/delivery-caller.js";
import { deliveryRow, renderDeliveryRow } from "../src/lib/delivery-row.js";
import { pickFreePort } from "../../delivery/smoke/_free-port.js";

// ---------------------------------------------------------------- guard, FIRST
const LIVE_HOST = "broker.cotal.ai";
const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
if (SERVERS.includes(LIVE_HOST)) { console.error(`✗ REFUSING: ${SERVERS} names the live host`); process.exit(1); }
if (!/^nats:\/\/127\.0\.0\.1:\d+$/.test(SERVERS)) { console.error(`✗ REFUSING: ${SERVERS} is not loopback`); process.exit(1); }

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, saw?: unknown): void => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}${saw === undefined ? "" : ` — saw ${JSON.stringify(saw)}`}`); }
};
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const space = `card-row-${randomUUID().slice(0, 8)}`;
const dir = mkdtempSync(join(tmpdir(), "cotal-card-"));
const root = join(dir, "root");
const credsPath = join(dir, "delivery.creds");
const repoRoot = join(import.meta.dirname, "..", "..", "..");
const created: { srv?: number; daemon?: number } = {};
let srv: ChildProcess | undefined, daemon: ChildProcess | undefined;

/** Every inherited COTAL_ variable deleted BY PREFIX, never a name list — a managed seat carries
 *  ambient keys including COTAL_SERVERS pointed at the production broker. */
const childEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("COTAL_")) delete env[k];
  return env;
};
const groupAlive = (pid?: number): boolean => {
  if (!pid) return false;
  try { process.kill(-pid, 0); return true; } catch { return false; }
};
const awaitExit = (c?: ChildProcess): Promise<"exited" | "TIMED-OUT"> =>
  !c || c.exitCode !== null || c.signalCode !== null
    ? Promise.resolve("exited")
    : new Promise((r) => { c.once("exit", () => r("exited")); setTimeout(() => r("TIMED-OUT"), 8000); });

console.log(`\ndelivery card row — ephemeral broker ${SERVERS} (asserted not ${LIVE_HOST})\n`);

const auth = await createSpaceAuth(space);
const FIXTURE = join(repoRoot, "implementations/delivery/smoke/_fixture-daemon.mts");

try {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], {
    transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js"),
  }));
  srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
  created.srv = srv.pid;
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`ephemeral nats-server did not come up on ${PORT}`);

  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });
  writeFileSync(credsPath, await mintCreds(auth, newIdentity(), "delivery"), { mode: 0o600 });

  // The caller mints from the SPACE AUTH ON DISK, exactly as the card does on an operator's box.
  // Writing it to a scratch root (never the real ~/.cotal) is what makes this the real path.
  await putSpaceAuth(workspaceSecretStore(root), auth);

  daemon = spawn("pnpm", ["exec", "tsx", FIXTURE, space, SERVERS, credsPath], {
    cwd: repoRoot, stdio: "ignore", detached: true, env: childEnv(),
  });
  created.daemon = daemon.pid;

  const mint = () => mintDeliveryCaller({ root, space, servers: SERVERS, ttlMs: LEASE_TTL_MS, now: () => Date.now() });

  // Wait for the daemon to bind before asserting anything about a live one.
  let live: Awaited<ReturnType<typeof mint>>;
  let serving = false;
  for (let i = 0; i < 60; i++) {
    live = await mint();
    if (live) {
      const h = await live.check();
      if (h.serving) { serving = true; break; }
      await live.close();
    }
    await wait(250);
  }

  check("L1 control: with a live daemon, mintDeliveryCaller returns a caller", live !== undefined);
  if (!live) throw new Error("no caller could be built — every refusal below would be about our creds");

  const liveRow = await deliveryRow({
    mintCaller: async () => ({ check: live!.check }),
    now: () => Date.now(),
  });
  const liveText = renderDeliveryRow(liveRow);
  console.log(`  live row -> ${liveText}`);
  check("L2 control: the row marker is ✓ and health is serving",
    liveRow.marker === "✓" && liveRow.kind === "assessed" && liveRow.health.serving === true, liveText);
  // SOURCE and AGE are two of this surface's three answers. Asserted on the RENDERED text, because
  // that is what an operator reads — a fact carried in a field but dropped by the renderer is the
  // same defect as never having it.
  check("L3: the rendered text names its SOURCE", /source|responder-roundtrip|lease-kv|broker-dial/i.test(liveText), liveText);
  check("L4: the rendered text names an AGE", /\bage|\bms\b|\bs ago|ago\b/i.test(liveText), liveText);
  await live.close();

  // ---- the corpse. SIGKILL, so no graceful lease release runs.
  console.log("\n--- KILL: SIGKILL, so no graceful lease release runs\n");
  if (created.daemon) { try { process.kill(-created.daemon, "SIGKILL"); } catch { /* gone */ } }
  const exitOutcome = await awaitExit(daemon);
  for (let i = 0; i < 400 && groupAlive(created.daemon); i++) await wait(5);
  check("kill: the daemon's exit was OBSERVED, not inferred from a timeout", exitOutcome === "exited");
  check("kill: the whole process GROUP is confirmed absent", !groupAlive(created.daemon));

  const dead = await mint();
  if (!dead) throw new Error("caller mint failed after the kill — cannot attribute the refusal");
  const deadHealth = await dead.check();
  const deadRow = await deliveryRow({ mintCaller: async () => ({ check: dead.check }), now: () => Date.now() });
  const deadText = renderDeliveryRow(deadRow);
  console.log(`  dead row -> ${deadText}`);

  check("L5: with the daemon gone the marker is NOT ✓", deadRow.marker !== "✓", deadRow.marker);
  check("L6: and it refuses as `no-responder` specifically",
    deadHealth.serving === false && deadHealth.refusal.condition === "no-responder",
    deadHealth.serving ? "SERVING" : deadHealth.refusal.condition);
  // THE CELL THAT TIES THIS ROW TO THE INCIDENT: the lease still looks healthy, so an age check alone
  // would have passed it. The refusal has to come from the affirmative round-trip.
  const leaseAfter = await (async () => { try { return await dead.leaseNow(); } catch { return undefined; } })();
  check("L7: the lease STILL reads ready — so the refusal came from the ROUND-TRIP, not the lease",
    leaseAfter?.ready === true, leaseAfter);
  await dead.close();

  // ---- no caller at all: a fact about OUR credentials, never about the daemon.
  const noAuth = await deliveryRow({ mintCaller: async () => undefined, now: () => Date.now() });
  const noAuthText = renderDeliveryRow(noAuth);
  console.log(`  no-auth row -> ${noAuthText}`);
  check("L8: an unbuildable caller renders no-auth and claims nothing about the daemon",
    noAuth.kind === "no-auth" && /never able to ask|no caller credential/i.test(noAuthText)
      && !/daemon is (down|dead|absent)/i.test(noAuthText), noAuthText);
} catch (e) {
  fail++;
  console.error(`\n  ✗ HARNESS ERROR: ${(e as Error).message}`);
} finally {
  if (created.daemon && groupAlive(created.daemon)) { try { process.kill(-created.daemon, "SIGKILL"); } catch { /* gone */ } }
  const dOut = await awaitExit(daemon);
  if (created.srv) { try { process.kill(created.srv, "SIGKILL"); } catch { /* gone */ } }
  const sOut = await awaitExit(srv);

  console.log(`\nDELIVERY CARD ROW: ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exitCode = 1;
  if (pass === 0) { console.error("NOTHING WAS MEASURED — 0 cells. A decline, not a pass."); process.exitCode = 3; }

  // Never delete a scratch out from under a live process.
  const why: string[] = [];
  if (dOut === "TIMED-OUT") why.push(`daemon exit not observed (outcome=${dOut})`);
  if (groupAlive(created.daemon)) why.push(`daemon group ${created.daemon} still alive`);
  if (sOut === "TIMED-OUT") why.push(`nats-server exit not observed (outcome=${sOut})`);
  if (why.length === 0) rmSync(dir, { recursive: true, force: true });
  else {
    process.exitCode = 1;
    console.error(`  ✗ TEARDOWN REFUSES to delete ${dir}:`);
    for (const w of why) console.error(`      · ${w}`);
  }
}
