/**
 * Delivery cred-renewal smoke (D5 slice 5, class 2) — the EXPLICIT reload contract on the REAL
 * daemon (`bin/dist/cotal.js deliver`, built dist, isolated staged `.cotal` root). The renewal
 * owner's flow is played by a supervisor-cred endpoint (what the manager holds):
 *
 *   1. EXPLICIT ADOPTION: re-sign delivery.creds + membership-rw.creds for their EXISTING nkeys,
 *      request `reloadCreds` on the privileged delivery-admin rail → structured reply proves the
 *      daemon adopted BOTH (endpoint swap + membership rw reconnect), fresh exp windows returned.
 *   2. IDEMPOTENT ADOPTION: a reload on an unchanged-but-fresh file replies ok (the explicit path
 *      may race the 75% backstop that adopted the same re-sign — both succeeding is correct).
 *   3. BACKSTOP STAYS LOUD + HONEST FAILURE: with no re-sign, the 75% re-read fails loud on its own,
 *      and an explicit reload in that stale state replies ok:false naming the exact condition —
 *      "file written" can never masquerade as "daemon adopted".
 *   4. CLEAN SWAP: a final explicit reload before the old JWT's exp — the run never logs
 *      "User Authentication Expired" and ends with a READY delivery lease.
 *
 * NOTE: runs the BUILT dist — `pnpm build` first (the smoke:ci wiring builds).
 * Run: pnpm smoke:delivery-renewal   (needs `nats-server` on PATH; auth/JetStream, local-only; ~30s)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  CotalEndpoint,
  DEV_OWNER,
  identityFromCreds,
  isReachable,
  createSpaceAuth,
  mintConnectionEvictorCreds,
  mintCreds,
  mintMembershipObserverCreds,
  newIdentity,
  principalKey,
  serverConfig,
  setupSpaceStreams,
  waitForDeliveryLease,
} from "@cotal-ai/core";
import { pickFreePort } from "./_free-port.js";

const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
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
/** Admin request that rides out the daemon's post-swap re-arm window: an adoption reconnect drops
 *  the responder for under a second before armDeliveryControl re-binds it — a caller right behind a
 *  reload retries on no-responders (pinning that the responder DOES come back). */
async function adminReq2(ep: CotalEndpoint, op: string, args: Record<string, unknown>): Promise<{ ok: boolean; error?: string; data?: unknown }> {
  let last: Error | undefined;
  for (let i = 0; i < 12; i++) {
    try { return await ep.requestDeliveryAdmin(op, args, 15_000); }
    catch (e) { last = e as Error; await wait(500); }
  }
  throw last ?? new Error("adminReq: no attempts ran");
}
const adminReq = (ep: CotalEndpoint, op: string) => adminReq2(ep, op, {});

const space = `dlv-renew-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const obsCreds = await mintMembershipObserverCreds(auth, newIdentity()); // while the $SYS seed is in memory
const evictorCreds = await mintConnectionEvictorCreds(auth, newIdentity()); // same in-memory-$SYS-only window
const dir = mkdtempSync(join(tmpdir(), "cotal-dlv-renew-"));
writeFileSync(join(dir, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(dir, "js") }));
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });

// The daemon's ISOLATED workspace root — findCotalRoot(cwd) lands here, so the membership feed's
// creds/config come from THIS staging, never the developer's real .cotal.
const root = mkdtempSync(join(tmpdir(), "cotal-dlv-renew-root-"));
mkdirSync(join(root, ".cotal"), { recursive: true });
const credsPath = join(root, ".cotal", "delivery.creds");
const rwPath = join(root, ".cotal", "membership-rw.creds");

let daemon: ReturnType<typeof spawn> | undefined;
let daemonExited = false;
let output = "";
let sup: CotalEndpoint | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`auth nats-server did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  const TTL = 20; // delivery cred window: 75% re-read at 15s — wide enough for explicit phases first
  const dlvId = newIdentity();
  const rwId = newIdentity();
  const credA = await mintCreds(auth, dlvId, "delivery", { expiresInSeconds: TTL });
  writeFileSync(credsPath, credA, { mode: 0o600 });
  writeFileSync(rwPath, await mintCreds(auth, rwId, "membership-rw", { expiresInSeconds: 120 }), { mode: 0o600 });
  writeFileSync(join(root, ".cotal", "membership-observer.creds"), obsCreds, { mode: 0o600 });
  writeFileSync(join(root, ".cotal", "connection-evictor.creds"), evictorCreds, { mode: 0o600 });
  writeFileSync(join(root, ".cotal", "membership.json"), JSON.stringify({ accountId: auth.account.pub }), { mode: 0o600 });
  const bornAt = Date.now();

  daemon = spawn(process.execPath, [cotalJs, "deliver", "--space", space, "--server", SERVERS, "--creds", credsPath], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
    // This harness runs the delivery daemon DIRECTLY (not via `up`), so its first-real-command seed
    // would run four npm installs and delay lease-ready; the daemon needs no connectors, so opt out.
    env: { ...process.env, COTAL_SKIP_CONNECTOR_SEED: "1" },
  });
  daemon.stdout!.on("data", (d: Buffer) => { output += d.toString(); });
  daemon.stderr!.on("data", (d: Buffer) => { output += d.toString(); });
  daemon.on("exit", () => { daemonExited = true; });

  check("daemon boots on the bounded delivery cred", await until(() => output.includes("delivery daemon up"), 12_000), output.slice(-500));
  check("membership feed starts from the staged root", await until(() => output.includes("membership feed up"), 8_000), output.slice(-500));

  // The renewal owner (what the manager holds): a supervisor-cred endpoint on the admin rail.
  const supId = newIdentity();
  sup = new CotalEndpoint({
    space, servers: SERVERS,
    creds: await mintCreds(auth, supId, "supervisor"),
    card: { id: supId.id, name: "renewal-owner", kind: "endpoint" },
    consume: false, watchChannels: false, watchPresence: false, registerPresence: false,
  });
  sup.on("error", () => {});
  await sup.start();

  // Phase 1 — explicit adoption: re-sign BOTH files for their existing nkeys, then reloadCreds.
  const credB = await mintCreds(auth, identityFromCreds(credA), "delivery", { expiresInSeconds: TTL });
  writeFileSync(credsPath, credB, { mode: 0o600 });
  writeFileSync(rwPath, await mintCreds(auth, rwId, "membership-rw"), { mode: 0o600 }); // matrix default TTL
  const adopted = await adminReq(sup, "reloadCreds");
  check("explicit reloadCreds replies ok (auditable adoption)", adopted.ok === true, JSON.stringify(adopted));
  const data = (adopted.ok ? adopted.data : {}) as {
    delivery?: { brokerAccepted?: { identity?: string; exp?: number } };
    membership?: { brokerAccepted?: { identity?: string; exp?: number } };
  };
  // The reply claims BROKER ACCEPTANCE of the generation (the preflight), pinned to our nkey + a fresh
  // window; the resident swap itself is best-effort/self-healing and deliberately not witnessed.
  check("reply proves the delivery generation was broker-accepted (pinned identity + fresh exp)", data.delivery?.brokerAccepted?.identity === dlvId.id && typeof data.delivery?.brokerAccepted?.exp === "number", JSON.stringify(data));
  check("reply proves the membership rw generation was broker-accepted (pinned identity + fresh exp)", data.membership?.brokerAccepted?.identity === rwId.id && typeof data.membership?.brokerAccepted?.exp === "number", JSON.stringify(data));

  // Phase 2 — idempotent adoption: an unchanged file whose cred is still ahead of its renewal
  // point re-adopts cleanly (the explicit path may race the backstop; both succeeding is correct).
  const again = await adminReq(sup, "reloadCreds");
  check("reload on an unchanged-but-fresh file is idempotent-ok", again.ok === true, JSON.stringify(again));
  const unknownOp = await adminReq(sup, "noSuchOp");
  check("unknown admin op is refused", unknownOp.ok === false, JSON.stringify(unknownOp));

  // Phase 3 — the passive backstop stays loud: cred B's 75% re-read (at ~15s after phase 1's
  // re-sign) finds the file unchanged AND stale and the daemon logs the exact repair on its own.
  const staleLoud = await until(() => output.includes("still holds the previous cred") && output.includes("delivery endpoint"), TTL * 1000);
  check("75% backstop re-read is LOUD on an unchanged stale file (no explicit reload sent)", staleLoud, output.slice(-500));
  // …and an EXPLICIT reload in that stale state is an honest structured refusal, never a fake ok.
  const refused = await adminReq(sup, "reloadCreds");
  check("explicit reload on an unchanged STALE file replies ok:false naming the condition", refused.ok === false && (refused.error ?? "").includes("still holds the previous cred"), JSON.stringify(refused));

  // Phase 4 — clean recovery BEFORE cred B's exp: re-sign (matrix default TTL) + explicit reload.
  writeFileSync(credsPath, await mintCreds(auth, identityFromCreds(credA), "delivery"), { mode: 0o600 });
  const recovered = await adminReq(sup, "reloadCreds");
  check("explicit reload after re-sign recovers from the stale state", recovered.ok === true, JSON.stringify(recovered));

  // Phase 5 — the LIVE-EVICTION EXECUTOR on the same rail (D5 slice 6): a victim connection is
  // force-dropped by principal via the daemon's per-call $SYS observer+evictor, structured result.
  const victim = newIdentity();
  const victimNc = await connect({
    servers: SERVERS,
    authenticator: credsAuthenticator(new TextEncoder().encode(await mintCreds(auth, victim, "operator"))),
    inboxPrefix: `_INBOX_${victim.id}`,
    maxReconnectAttempts: 0,
    reconnect: false,
  });
  let victimClosed = false;
  void victimNc.closed().then(() => { victimClosed = true; });
  const victimPrincipal = principalKey(DEV_OWNER, victim.id).key;
  const evicted = await adminReq2(sup, "evictPrincipal", { principal: victimPrincipal });
  const ev = (evicted.ok ? evicted.data : {}) as { kicked?: number; verifiedGone?: boolean; scanComplete?: boolean };
  check("evictPrincipal force-drops the victim (kicked + verifiedGone + complete scan)", evicted.ok === true && (ev.kicked ?? 0) >= 1 && ev.verifiedGone === true && ev.scanComplete === true, JSON.stringify(evicted));
  check("victim's connection actually closed", await until(() => victimClosed, 5000));
  const ghost = await adminReq2(sup, "evictPrincipal", { principal: principalKey(DEV_OWNER, newIdentity().id).key });
  const gv = (ghost.ok ? ghost.data : {}) as { kicked?: number; verifiedGone?: boolean };
  check("evicting a not-live principal is an idempotent verified no-op", ghost.ok === true && gv.kicked === 0 && gv.verifiedGone === true, JSON.stringify(ghost));
  const badPrincipal = await adminReq2(sup, "evictPrincipal", { principal: "not a principal" });
  check("malformed principal is refused fail-closed", badPrincipal.ok === false, JSON.stringify(badPrincipal));
  // Syntactically valid but NOT a real principal owner (CONNZ attribution can never surface it) —
  // must be a refusal, never a false verified no-op (critic's slice-6 catch).
  const fakeOwner = await adminReq2(sup, "evictPrincipal", { principal: "foo.bar" });
  check("non-principal owner (foo.bar) is refused, not a healthy no-op", fakeOwner.ok === false && (fakeOwner.error ?? "").includes("not a real owner.actor principal"), JSON.stringify(fakeOwner));

  await wait(2000);
  check("the run never hit an authentication expiry (every swap was explicit + ahead of exp)", !output.includes("User Authentication Expired"), output.slice(-500));
  const probe = newIdentity();
  const ready = await waitForDeliveryLease({ servers: SERVERS, space, creds: await mintCreds(auth, probe, "delivery"), id: probe.id });
  check("delivery lease is READY at the end (daemon healthy on the renewed cred)", ready);
  check("daemon never exited", !daemonExited);
  void bornAt;

  console.log(`\nDELIVERY-CRED-RENEWAL SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).message);
  console.error("  -- daemon output tail (diagnosis; a thrown scenario otherwise hides the daemon's last words):\n", output.slice(-2000));
  process.exitCode = 1;
} finally {
  try { await sup?.stop(); } catch { /* draining */ }
  try { if (daemon && !daemonExited) daemon.kill("SIGKILL"); } catch { /* gone */ }
  srv.kill("SIGKILL");
  await new Promise<void>((resolve) => {
    if (srv.exitCode !== null || srv.signalCode !== null) return resolve();
    srv.once("exit", () => resolve());
    setTimeout(resolve, 3000);
  });
  rmSync(dir, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
}
