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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isReachable, createSpaceAuth, mintCreds, mintMembershipObserverCreds, serverConfig, newIdentity, setupSpaceStreams } from "@cotal-ai/core";
import { spaceMaterialDir } from "@cotal-ai/workspace";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";
import { pickFreePort } from "./_free-port.js";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const repoRoot = join(import.meta.dirname, "..", "..", "..");
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); return; }
  fail++;
  console.log(`  ✗ FAIL: ${name}`);
  // A red that does not say what the daemon said sends the next reader to re-instrument this file by
  // hand, which is how a startup refusal stayed invisible here for as long as it did.
  if (detail.trim()) console.log(detail.trim().split("\n").map((l) => `      | ${l}`).join("\n"));
};
let daemonLog = "";

const space = `delivery-couple-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }));
let srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
// Owned, so a SIGNALLED run takes the broker and its store dir with it. The `finally` below is the
// only teardown this suite has and no signal handler is registered, so before this line a SIGINT
// left both behind. Killing the broker mid-test is this suite's SUBJECT, not its teardown: it proves
// the daemon exits on its own once the broker is gone, and the ~10s wait for that is also why the
// removal at the end of the `finally` is nowhere near the exit it follows.
const releaseBroker = teardownOnSignal(srv, dir);
const credsPath = join(dir, "delivery.creds");

let daemon: ReturnType<typeof spawn> | undefined;
let daemonExited = false;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  const mgrCreds = await mintCreds(auth, newIdentity(), "provisioner");
  await setupSpaceStreams({ servers: SERVERS, space, creds: mgrCreds });
  writeFileSync(credsPath, await mintCreds(auth, newIdentity(), "delivery"), { mode: 0o600 });

  // PROVISION THE $SYS OBSERVER CRED AND PIN THE WORKSPACE THE DAEMON WILL ADOPT. Without both of
  // these the daemon refuses during startup — before endpoint construction, before lease admission,
  // and so before any of the broker-coupling behaviour this suite exists to grade. That refusal was
  // ALSO an exit, so cell 2 kept reporting green while the daemon it was meant to observe had been
  // dead since startup and had never once been coupled to the broker it was asked to outlive. A
  // suite whose subject never runs cannot notice its subject breaking, which is the only thing this
  // suite is for. `cwd: repoRoot` is what made it reachable at all: findCotalRoot's cwd walk climbs
  // out of the repo into whatever real workspace sits above it, so the daemon inherited an operator
  // account and refused the foreign tenancy. A scratch root with its own `.cotal` stops the walk.
  const wsRoot = join(dir, "ws");
  mkdirSync(join(wsRoot, ".cotal"), { recursive: true });
  mkdirSync(spaceMaterialDir(wsRoot, space), { recursive: true });
  writeFileSync(
    join(spaceMaterialDir(wsRoot, space), "membership-observer.creds"),
    await mintMembershipObserverCreds(auth, newIdentity()),
    { mode: 0o600 },
  );

  // Spawn the real daemon with a SHORT broker-gone window so the test is fast. stderr is CAPTURED so
  // an exit can be attributed to the reason the daemon gave rather than merely counted: "it exited"
  // and "it exited because the broker was gone" are different claims, and only the second is the
  // guarantee. `tsx` directly rather than `pnpm cotal` keeps the exit code the daemon's own.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith("COTAL_")) delete env[k];
  env.XDG_CONFIG_HOME = join(dir, "xdg");
  env.COTAL_HOME = join(dir, "cotal-home");
  env.COTAL_SKIP_CONNECTOR_SEED = "1";
  env.COTAL_DELIVERY_BROKER_GONE_MS = "2000";
  daemon = spawn(
    join(repoRoot, "node_modules", ".bin", "tsx"),
    [join(repoRoot, "bin", "cotal.ts"), "deliver", "--space", space, "--server", SERVERS, "--creds", credsPath],
    { cwd: wsRoot, stdio: ["ignore", "pipe", "pipe"], env },
  );
  const sink = (b: Buffer) => { daemonLog += b.toString(); };
  daemon.stdout?.on("data", sink);
  daemon.stderr?.on("data", sink);
  daemon.on("exit", () => { daemonExited = true; });

  // Give the daemon time to connect + bind. If it couldn't reach the broker it would have exited
  // (runDelivery process.exit), so "still alive after the startup window" means it came up and is serving.
  await wait(5000);
  check("the daemon comes up + stays running against a live broker", !daemonExited, daemonLog);

  // Kill the broker. The daemon should give up reconnecting after the short window and EXIT.
  srv.kill("SIGKILL");
  let exitedInTime = false;
  for (let i = 0; i < 40; i++) { // up to ~10s (window 2s + reconnect attempts + margin)
    if (daemonExited) { exitedInTime = true; break; }
    await wait(250);
  }
  check("the daemon EXITS on its own when the broker is gone (coupled to the broker)", exitedInTime, daemonLog);
  // AND IT EXITED FOR THAT REASON. Any exit satisfies the cell above, including the startup refusal
  // that made this suite green for the wrong reason; only the stated reason distinguishes the
  // guarantee from a daemon that happened to die. This is also the control on #1318's repair: the
  // starvation fix must not buy availability by making a genuinely dead broker survivable.
  check(
    "and the exit names the broker-gone reason rather than being any exit at all",
    /can't reach NATS|broker unreachable/i.test(daemonLog),
    daemonLog,
  );

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
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
