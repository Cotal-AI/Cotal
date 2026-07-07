/**
 * Delivery cred-renewal smoke (D5 slice 5, class 2): the REAL daemon (`cotal deliver`, built dist)
 * renews its bounded delivery cred from a launcher-re-signed file — the reload seam — with no
 * restart and no signal. Three phases against a throwaway auth broker:
 *
 *   1. LOUD STALE: the daemon boots on a short-TTL cred; at 75% of its lifetime the reload re-read
 *      finds the file unchanged (no launcher remint) and the daemon logs the exact repair loudly.
 *   2. FAIL-LOUD, NOT FAIL-DEAD: past the JWT's exp the daemon keeps running (rebuild loop, loud),
 *      because the broker is still up — dying silently would hide the repair.
 *   3. RECOVERY: the "launcher" re-signs the file for the SAME nkey (identityFromCreds — the pin);
 *      the daemon's rebuild picks it up and re-holds a READY delivery lease past the old lease's
 *      TTL horizon — provable only if the renewed connection CAS-renewed it after the re-sign.
 *
 * NOTE: `pnpm cotal` runs the BUILT dist — `pnpm build` first or you exercise stale code.
 * Run: pnpm smoke:delivery-renewal   (needs `nats-server` on PATH; auth/JetStream, local-only; ~45s)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LEASE_TTL_MS,
  identityFromCreds,
  isReachable,
  createSpaceAuth,
  mintCreds,
  newIdentity,
  serverConfig,
  setupSpaceStreams,
  waitForDeliveryLease,
} from "@cotal-ai/core";

const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const repoRoot = join(import.meta.dirname, "..", "..", "..");
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };

const TTL_SEC = 10; // stale re-read fires at 7.5s, exp-close at 10s
const space = `dlv-renew-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const dir = mkdtempSync(join(tmpdir(), "cotal-dlv-renew-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const credsPath = join(dir, "delivery.creds");

let daemon: ReturnType<typeof spawn> | undefined;
let daemonExited = false;
let output = "";
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  const bounded = await mintCreds(auth, newIdentity(), "delivery", { expiresInSeconds: TTL_SEC });
  writeFileSync(credsPath, bounded, { mode: 0o600 });
  const bornAt = Date.now();

  daemon = spawn("pnpm", ["cotal", "deliver", "--space", space, "--server", SERVERS, "--creds", credsPath], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stdout!.on("data", (d: Buffer) => { output += d.toString(); });
  daemon.stderr!.on("data", (d: Buffer) => { output += d.toString(); });
  daemon.on("exit", () => { daemonExited = true; });

  // Boot: the daemon binds + flips the lease ready on its bounded cred.
  let booted = false;
  for (let i = 0; i < 40; i++) { if (output.includes("delivery daemon up")) { booted = true; break; } await wait(250); }
  check("daemon boots on the bounded delivery cred", booted, output.slice(-400));

  // Phase 1 — loud stale: no remint before 75% of the lifetime → the reload re-read must fail LOUD
  // with the exact repair, while the current JWT still lives.
  let staleLoud = false;
  const staleDeadline = bornAt + TTL_SEC * 1000; // must appear before exp (fires at ~75%)
  while (Date.now() < staleDeadline) {
    if (output.includes("still holds the previous cred")) { staleLoud = true; break; }
    await wait(250);
  }
  check("unchanged creds file at renewal time is LOUD before expiry (names the launcher + repair)", staleLoud, output.slice(-400));

  // Phase 2 — past exp the broker closes the connection; the daemon must keep running (rebuild loop,
  // loud) — the broker is up, so exiting would hide the repair behind a dead process.
  await wait(Math.max(0, bornAt + TTL_SEC * 1000 + 2000 - Date.now()));
  check("daemon survives its cred's expiry as a loud rebuild loop (fail-loud, not fail-dead)", !daemonExited);

  // Phase 3 — the "launcher" re-signs the file for the SAME nkey (the identity pin: a renewal may
  // never swap who the daemon is). The rebuild loop re-reads it within a few seconds.
  const identity = identityFromCreds(bounded);
  writeFileSync(credsPath, await mintCreds(auth, identity, "delivery"), { mode: 0o600 }); // matrix default TTL
  const resignedAt = Date.now();

  // The old lease dies LEASE_TTL_MS after the daemon lost its connection (exp). A READY lease past
  // that horizon can only exist if the RENEWED connection re-CASed it after the re-sign — the
  // deterministic recovery proof, not a log grep.
  await wait(Math.max(0, bornAt + TTL_SEC * 1000 + LEASE_TTL_MS + 3000 - Date.now()));
  const probe = newIdentity();
  const ready = await waitForDeliveryLease({ servers: SERVERS, space, creds: await mintCreds(auth, probe, "delivery"), id: probe.id });
  check(`lease is READY ${LEASE_TTL_MS / 1000}s past the exp-drop — only a renewed connection can have re-CASed it`, ready);
  check("daemon still running after recovery", !daemonExited);
  check("re-sign happened after the stale warning (test-order sanity)", resignedAt > bornAt + 7000);

  console.log(`\nDELIVERY-CRED-RENEWAL SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  process.exitCode = 1;
} finally {
  try { if (daemon && !daemonExited) daemon.kill("SIGKILL"); } catch { /* gone */ }
  srv.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    if (srv.exitCode !== null || srv.signalCode !== null) return resolve();
    srv.once("exit", () => resolve());
    setTimeout(resolve, 3000);
  });
  rmSync(dir, { recursive: true, force: true });
}
