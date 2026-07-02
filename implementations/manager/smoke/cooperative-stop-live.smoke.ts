/**
 * Cooperative-stop live-broker smoke (no test runner) — run with: pnpm smoke:cooperative-stop:live
 *
 * WS4 end-to-end: proves the manager's cooperative shutdown actually publishes OFFLINE presence — the
 * clean mesh-leave a signal-less runtime (ConPTY/Windows) would otherwise miss, leaving peers to wait
 * out the presence TTL. The Windows seam smoke (windows-launch.smoke.ts §F6) only round-trips the
 * shutdown FRAME against a stub; this drives the REAL path against a REAL JWT-auth broker:
 *
 *   manager controlShutdown(endpoint)  →  startControlServer first-frame auth  →  onShutdown
 *     →  agent.stop()  →  endpoint publishes status:"offline" to the presence KV  →  a watcher sees it.
 *
 * The stopped agent carries a LONG presence TTL (30s) and we assert the watcher sees it offline within
 * ~1.5s — far under that TTL — so the flip can only be the cooperative leave, never TTL expiry (the
 * whole point of WS4). `node:net` abstracts the AF_UNIX socket ↔ Windows named pipe, so the control
 * wire exercises identically here; this runs everywhere a broker is on PATH (CI's soak lane is the
 * Windows oracle). The `agent` arg to startControlServer is a stub: the shutdown op never touches it
 * (it routes straight to onShutdown), exactly as §F6 does.
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
} from "@cotal-ai/core";
import { controlEndpoint, startControlServer, type MeshAgent } from "@cotal-ai/connector-core";
import { controlShutdown } from "../src/control-shutdown.js";

// A fresh random port BELOW the Windows dynamic/ephemeral range (49152–65535): a port the OS may have
// already reserved makes nats-server fail to bind and the wait below time out as a phantom flake.
const PORT = 20000 + Math.floor(Math.random() * 20000); // 20000–39999
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });
let pass = 0;
let fail = 0;
const check = (name: string, cond: boolean, extra?: unknown): void => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ FAIL: ${name}`, extra ?? "");
  }
};

const space = `coopstop-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-coopstop-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

// Built outside try so finally can tear them down even if a mid-scenario assertion throws.
let alice: CotalEndpoint | undefined;
let bob: CotalEndpoint | undefined;
let mgr: CotalEndpoint | undefined;
let server: ReturnType<typeof startControlServer> | undefined;

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

  // Privileged setup (manager profile: allow-all) — provisions the peers, exactly as a launcher would.
  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  mgr = new CotalEndpoint({
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
  await mgr.start();

  const aliceId = newIdentity();
  const bobId = newIdentity();
  const acl = { subscribe: ["general"], allowSubscribe: ["general"], allowPublish: ["general"] };
  const aliceCreds = await provisionAgent(mgr, auth, aliceId, { ...acl, role: "worker" });
  const bobCreds = await provisionAgent(mgr, auth, bobId, { ...acl, role: "watcher" });

  // alice is the agent we cooperatively stop. A LONG ttl (30s) so an offline flip within the assert
  // window can ONLY be the cooperative leave, never TTL expiry.
  alice = new CotalEndpoint({
    space,
    servers: SERVERS,
    creds: aliceCreds,
    card: { id: aliceId.id, name: "alice", role: "worker", kind: "agent" },
    channels: ["general"],
    heartbeatMs: 500,
    ttlMs: 30_000,
  });
  // bob watches alice's presence.
  bob = new CotalEndpoint({
    space,
    servers: SERVERS,
    creds: bobCreds,
    card: { id: bobId.id, name: "bob", role: "watcher", kind: "agent" },
    channels: ["general"],
    heartbeatMs: 500,
    ttlMs: 30_000,
  });
  alice.on("error", (e: Error) => console.error("  ! alice:", e.message));
  bob.on("error", (e: Error) => console.error("  ! bob:", e.message));
  await alice.start();
  await bob.start();
  await wait(800);

  // bob sees alice as a live peer (not offline) before the stop — the baseline.
  const aliceLive = bob.getRoster().find((p) => p.card.name === "alice");
  check("baseline: bob sees alice live", aliceLive !== undefined && aliceLive.status !== "offline", aliceLive?.status);

  // Stand up alice's REAL control server. onShutdown does what the Claude Code connector's shutdown
  // closure does — close the server, then agent.stop() (the offline-presence publish) — minus the
  // process.exit (this test process lives on to observe the result).
  const ep = controlEndpoint(space, "alice");
  let onShutdownFired = false;
  const stubAgent = {} as unknown as MeshAgent;
  const handle = async (): Promise<Record<string, unknown>> => ({ ok: true });
  server = startControlServer(stubAgent, ep, handle, {
    onShutdown: () => {
      onShutdownFired = true;
      void alice!.stop(); // the real clean-leave: status:"offline" → presence KV
    },
  });
  await new Promise<void>((resolve) => {
    server!.on("listening", () => resolve());
    setTimeout(resolve, 500); // backstop — listen fires next tick; we attach before it
  });

  // Fire the manager's REAL cooperative-shutdown client (the win32 graceful-stop path).
  controlShutdown(ep);

  // Wait for bob to observe alice offline — polled, well under alice's 30s TTL.
  let aliceOffline = false;
  for (let i = 0; i < 30 && !aliceOffline; i++) {
    await wait(50);
    aliceOffline = bob.getRoster().find((p) => p.card.name === "alice")?.status === "offline";
  }

  check("controlShutdown reached the control server's onShutdown", onShutdownFired);
  check("cooperative stop publishes OFFLINE presence (bob sees alice offline, ≪ TTL)", aliceOffline, bob.getRoster().find((p) => p.card.name === "alice")?.status);
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
} finally {
  try {
    server?.close();
  } catch {
    /* ignore */
  }
  for (const ep of [alice, bob, mgr]) {
    try {
      await ep?.stop();
    } catch {
      /* already down */
    }
  }
  srv.kill("SIGKILL");
  await awaitExit(srv); // await actual exit so a failed run never leaks the broker onto its port
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? "COOPERATIVE-STOP SMOKE OK ✅" : "COOPERATIVE-STOP SMOKE FAILED ❌"}  (${pass} passed, ${fail} failed)`);
process.exit(fail === 0 ? 0 : 1);
