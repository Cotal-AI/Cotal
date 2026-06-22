/**
 * delivery broker-coupling smoke. The delivery daemon is part of the server: it should survive a brief
 * broker blip (the endpoint reconnects), but if the broker is truly GONE it must EXIT rather than loop
 * reconnect-attempts forever — so it never outlives the broker it serves. This spawns the real daemon
 * (`cotal deliver`) against a throwaway broker with a short broker-gone window, confirms it comes up,
 * kills the broker, and asserts the daemon process exits on its own.
 *
 * Run: pnpm smoke:delivery-broker-coupling   (needs `nats-server` on PATH; auth/JetStream, local-only)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isReachable, createSpaceAuth, mintCreds, serverConfig, newIdentity, setupSpaceStreams } from "@cotal-ai/core";

const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const repoRoot = join(import.meta.dirname, "..", "..", "..");
let pass = 0, fail = 0;
const check = (name: string, cond: boolean) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`); } };

const space = `delivery-couple-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-couple-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
let srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const credsPath = join(dir, "delivery.creds");

let daemon: ReturnType<typeof spawn> | undefined;
let daemonExited = false;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  const mgrCreds = await mintCreds(auth, newIdentity(), "manager");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  writeFileSync(credsPath, await mintCreds(auth, newIdentity(), "delivery"), { mode: 0o600 });

  // Spawn the real daemon with a SHORT broker-gone window so the test is fast.
  daemon = spawn("pnpm", ["cotal", "deliver", "--space", space, "--server", SERVERS, "--creds", credsPath], {
    cwd: repoRoot,
    stdio: "ignore",
    env: { ...process.env, COTAL_DELIVERY_BROKER_GONE_MS: "2000" },
  });
  daemon.on("exit", () => { daemonExited = true; });

  // Give the daemon time to connect + bind. If it couldn't reach the broker it would have exited
  // (runDelivery process.exit), so "still alive after the startup window" means it came up and is serving.
  await wait(5000);
  check("the daemon comes up + stays running against a live broker", !daemonExited);

  // Kill the broker. The daemon should give up reconnecting after the short window and EXIT.
  srv.kill("SIGKILL");
  let exitedInTime = false;
  for (let i = 0; i < 40; i++) { // up to ~10s (window 2s + reconnect attempts + margin)
    if (daemonExited) { exitedInTime = true; break; }
    await wait(250);
  }
  check("the daemon EXITS on its own when the broker is gone (coupled to the broker)", exitedInTime);

  console.log(`\nDELIVERY-BROKER-COUPLING SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  try { if (daemon && !daemonExited) daemon.kill("SIGKILL"); } catch { /* gone */ }
  try { srv.kill("SIGKILL"); } catch { /* gone */ }
  rmSync(dir, { recursive: true, force: true });
}
