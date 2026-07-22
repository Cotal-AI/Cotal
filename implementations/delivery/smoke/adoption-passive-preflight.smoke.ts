/**
 * REGRESSION (freelance blocker 2, endpoint half): the PASSIVE 75% renewal timer must PREFLIGHT a
 * candidate before it installs it and reconnects the live connection — so a rejected cred sitting in
 * the store (a hosted two-store split, a tampered store) can never strand the resident connection.
 *
 * Before the fix, the timer wrote the source cred into `currentCreds` and reconnected with NO broker
 * proof; a rejected cred there would reconnect the live connection onto a cred the broker refuses,
 * stranding it (the explicit reload's preflight did nothing for this path). Now the timer runs the
 * same prove-then-adopt transaction as the explicit reload, under one single-flight: it preflights on
 * a disposable connection, and a refused candidate throws → nothing is installed, nothing swaps, the
 * resident connection stays on its still-valid old cred.
 *
 * Event-driven (not timing-fragile): a SHORT-TTL daemon cred makes the 75% timer fire quickly; we
 * write a ROGUE (broker-refused, same nkey, untrusted operator) cred to the store, WAIT for the
 * daemon to log the rejected-preflight ("creds refresh failed … the broker did not accept"), then
 * assert the daemon is STILL RESPONSIVE on its admin rail and never exited. All checked before the
 * old cred's own expiry, so a failure here is the passive-path strand, not an unrelated expiry.
 *
 * NOTE: runs the BUILT dist — `pnpm build` first.
 * Run: pnpm exec tsx implementations/delivery/smoke/adoption-passive-preflight.smoke.ts
 *      (needs `nats-server` on PATH; local-only; ~40s)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CotalEndpoint, createSpaceAuth, isReachable, mintConnectionEvictorCreds, mintCreds,
  mintMembershipObserverCreds, newIdentity, serverConfig, setupSpaceStreams,
} from "@cotal-ai/core";
import { pickFreePort } from "./_free-port.js";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const repoRoot = join(import.meta.dirname, "..", "..", "..");
const cotalJs = join(repoRoot, "bin", "dist", "cotal.js");
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };
const until = async (cond: () => boolean, timeoutMs: number, stepMs = 200): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await wait(stepMs);
  return cond();
};

const cleanups: Array<() => void> = [];
try {
  const port = await pickFreePort();
  const servers = `nats://127.0.0.1:${port}`;
  const space = `adopt-pp-${randomUUID().slice(0, 8)}`;
  const auth = await createSpaceAuth(space);
  const rogue = await createSpaceAuth(space); // untrusted operator: anything it signs is refused here
  const obsCreds = await mintMembershipObserverCreds(auth, newIdentity());
  const evictorCreds = await mintConnectionEvictorCreds(auth, newIdentity());

  const dir = mkdtempSync(join(tmpdir(), "cotal-adopt-pp-"));
  writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port, storeDir: join(dir, "js") }));
  const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
  cleanups.push(() => { srv.kill("SIGKILL"); rmSync(dir, { recursive: true, force: true }); });
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(servers)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${port}`);
  await setupSpaceStreams({ servers, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  const root = mkdtempSync(join(tmpdir(), "cotal-adopt-pp-root-"));
  mkdirSync(join(root, ".cotal"), { recursive: true });
  const credsPath = join(root, ".cotal", "delivery.creds");
  const dlvId = newIdentity();
  // SHORT TTL so the 75% timer fires in a few seconds; old cred stays valid to its exp, giving a
  // clean window to check the passive timer did not strand us on the rogue.
  const TTL = 30;
  writeFileSync(credsPath, await mintCreds(auth, dlvId, "delivery", { expiresInSeconds: TTL }), { mode: 0o600 });
  writeFileSync(join(root, ".cotal", "membership-rw.creds"), await mintCreds(auth, newIdentity(), "membership-rw", { expiresInSeconds: 600 }), { mode: 0o600 });
  writeFileSync(join(root, ".cotal", "membership-observer.creds"), obsCreds, { mode: 0o600 });
  writeFileSync(join(root, ".cotal", "connection-evictor.creds"), evictorCreds, { mode: 0o600 });
  writeFileSync(join(root, ".cotal", "membership.json"), JSON.stringify({ accountId: auth.account.pub }), { mode: 0o600 });

  let out = "";
  const daemon = spawn(process.execPath, [cotalJs, "deliver", "--space", space, "--server", servers, "--creds", credsPath], {
    cwd: root, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, COTAL_SKIP_CONNECTOR_SEED: "1" },
  });
  daemon.stdout!.on("data", (d: Buffer) => { out += d.toString(); });
  daemon.stderr!.on("data", (d: Buffer) => { out += d.toString(); });
  let exited = false; daemon.on("exit", () => { exited = true; });
  cleanups.push(() => { daemon.kill("SIGKILL"); rmSync(root, { recursive: true, force: true }); });

  check("daemon boots on the trusted delivery cred", await until(() => out.includes("delivery daemon up"), 15_000), out.slice(-400));

  // Drop a ROGUE cred into the store: same nkey, signed by the untrusted operator, so the file
  // genuinely CHANGED (the "still holds the previous cred" guard cannot see it) but the broker refuses
  // it. The passive 75% timer will fetch it next tick.
  writeFileSync(credsPath, await mintCreds(rogue, dlvId, "delivery", { expiresInSeconds: TTL }), { mode: 0o600 });

  // WAIT for the passive timer to fire and REJECT the rogue at preflight (before the old cred's exp).
  const rejected = await until(() => /creds refresh failed[\s\S]*did not accept/i.test(out), (TTL - 6) * 1000);
  check("the passive 75% timer rejected the rogue cred at preflight (did not install it)", rejected, out.slice(-500));
  check("the daemon did NOT exit when the passive timer hit the rogue cred", !exited, out.slice(-400));

  // Prove the resident connection was NOT stranded: a fresh admin request still gets a reply.
  const supId = newIdentity();
  const sup = new CotalEndpoint({
    space, servers, creds: await mintCreds(auth, supId, "supervisor"),
    card: { id: supId.id, name: "probe", kind: "endpoint" },
    consume: false, watchChannels: false, watchPresence: false, registerPresence: false,
  });
  sup.on("error", () => {});
  await sup.start();
  cleanups.push(() => { void sup.stop?.(); });
  let railAlive = false;
  try { const r = await sup.requestDeliveryAdmin("reloadCreds", {}, 10_000); railAlive = typeof r?.ok === "boolean"; } catch { railAlive = false; }
  check("the admin rail is still responsive after the passive timer hit the rogue (no strand)", railAlive, out.slice(-400));

  console.log(`\n${fail ? "✗" : "✓"} ADOPTION PASSIVE-PREFLIGHT REGRESSION ${pass}/${pass + fail}`);
} finally {
  for (const c of cleanups.reverse()) { try { c(); } catch { /* best-effort */ } }
  await wait(300);
}
process.exit(fail ? 1 : 0);
