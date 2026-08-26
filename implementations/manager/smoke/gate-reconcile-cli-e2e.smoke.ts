/**
 * Cotal #391 — `cotal reconcile-gate` END-TO-END, through the PUBLIC PATH.
 *
 * WHY THIS EXISTS, SEPARATELY FROM `gate-reconcile-auth.smoke.ts`. That suite enters through
 * `reconcileEndpointGate()` directly, so its mutation kills prove the suite DEPENDS on the guard —
 * they prove nothing about whether the shipped COMMAND reaches it. That gap is not hypothetical:
 * a release blocker on this repo was caused by exactly this shape, every suite entering through the
 * function while the public path silently skipped the fix. Here the entry point is the real binary,
 * driven as an operator drives it, against a seeded ephemeral mesh:
 *
 *   - a real workspace root (`.cotal/` with the space auth, the $SYS creds, and the PERSISTED
 *     MANAGER INSTANCE IDENTITY), so the command resolves its space and instanceId the way it does
 *     on a wedged machine — no `--instance`, no injected seams;
 *   - a real delivery daemon, so the liveness probe crosses the actual `ctl.delivery-admin` rail
 *     rather than a stub;
 *   - the residue built by the SHIPPED barrier's own freeze, as in the sibling suite;
 *   - and every verdict read from the CLI's own exit code and output, or from the KV afterwards.
 *
 * The three cells are the three outcomes an operator can actually reach, and the middle one is the
 * reason the wiring is worth testing: with the daemon down, the command must refuse
 * `liveness-unestablishable` — which it can only do if the probe seam is genuinely connected to the
 * rail. A stubbed or unwired probe would sail past that cell.
 *
 * COTAL_HOME-free; kills only the processes it starts, by exact PID (never pkill).
 * Run: npx tsx implementations/manager/smoke/gate-reconcile-cli-e2e.smoke.ts   (needs nats-server on PATH)
 */
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect, type NatsConnection } from "@nats-io/transport-node";
import { Kvm, type KV } from "@nats-io/kv";
import {
  createSpaceAuth, isReachable, mintCreds, newIdentity, serverConfig, setupSpaceStreams,
  mintMembershipObserverCreds, mintConnectionEvictorCreds,
  principalKey, standaloneConnectOpts, epAuthBucket, DEV_OWNER,
  provisionEndpointGateOpen, serveIssuanceGateKv, endpointRegistrationBarrier,
  epgateKey, parseEndpointGate, mintLifecycleUid,
} from "@cotal-ai/core";
import { putSpaceAuth, saveManagerInstanceIdentity, workspaceSecretStore } from "@cotal-ai/workspace";
import { executePrincipalLiveness } from "../../delivery/src/evict-exec.js";
import { pickFreePort } from "../../../packages/core/smoke/_free-port.js";
import { SMOKE_BROKER_TOKEN, teardownOnSignal } from "@cotal-ai/smoke-kit";

// ---------------------------------------------------------------------------
// FIRST ACTION: this drives a command that revokes credentials and evicts connections. Refuse the
// live host unconditionally, before any setup runs.
// ---------------------------------------------------------------------------
const PORT = await pickFreePort();
const SERVERS = `nats://127.0.0.1:${PORT}`;
const LIVE_HOSTS = ["broker.cotal.ai"];
for (const host of LIVE_HOSTS) {
  if (SERVERS.includes(host)) {
    console.error(`✗ REFUSING TO RUN: the broker URL "${SERVERS}" names the live host "${host}".`);
    process.exit(1);
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(COTAL_SERVER|COTAL_SERVERS|NATS_URL|COTAL_BROKER)$/.test(k) && typeof v === "string" && v.includes(host)) {
      console.error(`✗ REFUSING TO RUN: ${k}="${v}" names the live host "${host}". Ephemeral brokers from scratch dirs only.`);
      process.exit(1);
    }
  }
}
if (!/^nats:\/\/(127\.0\.0\.1|localhost):/.test(SERVERS)) {
  console.error(`✗ REFUSING TO RUN: "${SERVERS}" is not a loopback ephemeral broker.`);
  process.exit(1);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ENDPOINT = "manager";
const REPO = resolve(new URL("../../..", import.meta.url).pathname);

let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); }
};

const space = `gate391cli-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const observerCreds = await mintMembershipObserverCreds(auth, newIdentity());
const evictorCreds = await mintConnectionEvictorCreds(auth, newIdentity());

const dir = mkdtempSync(join(tmpdir(), SMOKE_BROKER_TOKEN));
// THE SEEDED WORKSPACE ROOT the command will resolve from: its own scratch dir, never the
// operator's. `findCotalRoot()` walks up for a `.cotal/`, so an unanchored cwd would reach the real
// mesh root — the command runs with cwd set HERE, and this directory is what it must find.
const ROOT = join(dir, "mesh-root");
mkdirSync(join(ROOT, ".cotal"), { recursive: true });

writeFileSync(
  join(dir, "server.conf"),
  serverConfig(auth, [auth], { transport: { kind: "plaintext" }, port: PORT, storeDir: join(dir, "js") }),
);
const srv = spawn("nats-server", ["-c", join(dir, "server.conf")], { stdio: "ignore" });
const releaseBroker = teardownOnSignal(srv, dir);
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 5000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });

let daemon: ReturnType<typeof spawn> | undefined;
const holderConns: NatsConnection[] = [];
const execConns: NatsConnection[] = [];

/** Drive the REAL command, from the seeded root, and hand back what an operator would see. */
const runCli = (args: string[]): { code: number | null; out: string; err: string } => {
  const r = spawnSync("npx", ["tsx", join(REPO, "bin", "cotal.ts"), ...args], {
    cwd: ROOT, encoding: "utf8", timeout: 120_000,
    // Scrubbed: a live ambient broker/creds must never reach a command this smoke drives.
    env: { ...process.env, COTAL_SERVER: "", COTAL_SERVERS: "", COTAL_CREDS: "", NATS_URL: "" },
  });
  return { code: r.status, out: r.stdout ?? "", err: r.stderr ?? "" };
};

try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`the ephemeral broker did not come up on ${PORT}`);
  await setupSpaceStreams({ servers: SERVERS, space, creds: await mintCreds(auth, newIdentity(), "provisioner") });

  // ---- Seed the workspace root exactly as a real machine carries it ----
  await putSpaceAuth(workspaceSecretStore(ROOT), auth);
  // The $SYS material the delivery daemon's own executor reads through findCotalRoot(). Placing it
  // here (not in the smoke's own dir) is what makes the daemon resolve THIS mesh.
  writeFileSync(join(ROOT, ".cotal", "membership-observer.creds"), observerCreds);
  writeFileSync(join(ROOT, ".cotal", "connection-evictor.creds"), evictorCreds);
  writeFileSync(join(ROOT, ".cotal", "membership.json"), JSON.stringify({ accountId: auth.account.pub }));

  const execFor = async (instanceId: string): Promise<KV> => {
    const creds = await mintCreds(auth, newIdentity(), "endpoint-serve-executor", {
      endpointServeExecutor: { endpoint: ENDPOINT, instanceId },
    });
    const nc = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds, tls: false }), maxReconnectAttempts: 0 });
    execConns.push(nc);
    return await new Kvm(nc).open(epAuthBucket(space));
  };

  /** The crashed-restart residue, built by the shipped barrier's own freeze — and PERSISTED as this
   *  root's manager instance identity, so the command finds it with no `--instance`. */
  const buildResidue = async (opts: { holderLive: boolean }): Promise<{ instanceId: string; principal: string; kv: KV; conn?: NatsConnection }> => {
    const instanceId = mintLifecycleUid();
    const actor = `h${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const principal = principalKey(DEV_OWNER, actor).key;
    const kv = await execFor(instanceId);

    await provisionEndpointGateOpen(kv, { endpoint: ENDPOINT, instanceId, principal });
    const gate = serveIssuanceGateKv(kv, space, { endpoint: ENDPOINT, instanceId });
    await gate.stage({
      credentialId: mintLifecycleUid(), credentialKey: "", holderPrincipal: principal,
      endpoint: ENDPOINT, lifecycleUid: instanceId, sourceChain: ["root"], state: "active",
      exp: Math.floor(Date.now() / 1000) + 3600,
      generation: 0, processEpoch: 0, registrationRevision: 0, nameAuthorityRevision: 0,
    });

    let conn: NatsConnection | undefined;
    if (opts.holderLive) {
      const hcreds = await mintCreds(auth, newIdentity(), "agent", { principal: { owner: DEV_OWNER, actor }, lifecycleUid: mintLifecycleUid() });
      conn = await connect({ servers: SERVERS, ...standaloneConnectOpts({ creds: hcreds, tls: false }), maxReconnectAttempts: 0 });
      holderConns.push(conn);
    }

    const observed = await gate.observe();
    if (observed === null) throw new Error("the gate vanished right after provisioning");
    const frozen = await endpointRegistrationBarrier(kv, space, {
      endpoint: ENDPOINT, instanceId, opId: mintLifecycleUid(),
    }).freeze(observed.revision);
    if (frozen === null) throw new Error("the shipped barrier did not freeze the gate — residue not built");

    // The command's DEFAULT instance resolution reads this file. Writing it is what makes the
    // no-`--instance` invocation below the real operator path.
    saveManagerInstanceIdentity(ROOT, space, { instanceId, serveIdentity: { id: newIdentity().id, seed: newIdentity().seed } });
    return { instanceId, principal, kv, ...(conn ? { conn } : {}) };
  };

  // ---- CELL 1: the holder is ALIVE, and the daemon is DOWN on purpose --------------------------
  // Ordering matters: the guard must refuse on LIVENESS, and it can only learn that from the rail.
  // With the daemon down this is `liveness-unestablishable` — proving the probe is really wired to
  // the rail rather than answering from nothing.
  {
    const { instanceId } = await buildResidue({ holderLive: true });
    const r = runCli(["reconcile-gate", "--space", space, "--server", SERVERS]);
    check("CLI (no daemon): refuses `liveness-unestablishable` — the probe genuinely crosses the delivery-admin rail",
      r.code === 2 && /refused \(liveness-unestablishable\)/.test(r.err), { code: r.code, err: r.err.slice(-600) });
    check("CLI (no daemon): the refusal tells the operator to start the daemon, and disclaims inferring death from silence",
      /cotal up/.test(r.err) && /never infers death from silence/i.test(r.err), r.err.slice(-400));
    const still = parseEndpointGate((await (await execFor(instanceId)).get(epgateKey(ENDPOINT, instanceId)))!.value, epgateKey(ENDPOINT, instanceId));
    check("CLI (no daemon): the gate is untouched — still frozen", still.state === "frozen", still);
  }

  // ---- Bring the delivery daemon up: the liveness oracle the rail needs -----------------------
  daemon = spawn("npx", ["tsx", join(REPO, "bin", "cotal.ts"), "deliver", "--space", space, "--server", SERVERS, "--dev-mint"], {
    cwd: ROOT, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, COTAL_SERVER: "", COTAL_SERVERS: "", COTAL_CREDS: "", NATS_URL: "" },
  });
  let daemonLog = "";
  daemon.stdout?.on("data", (b) => { daemonLog += String(b); });
  daemon.stderr?.on("data", (b) => { daemonLog += String(b); });
  {
    let ready = false;
    for (let i = 0; i < 120; i++) { if (/delivery daemon up/.test(daemonLog)) { ready = true; break; } await wait(500); }
    check("the delivery daemon came up on the ephemeral mesh (the liveness oracle is reachable)", ready, daemonLog.slice(-800));
    if (!ready) throw new Error("the delivery daemon never reported ready; the remaining cells would be meaningless");
  }

  // ---- CELL 2: the holder is ALIVE and the oracle CAN be reached -------------------------------
  // The one that matters: with a working oracle, a live holder must be refused BY NAME, and nothing
  // may be mutated. This is the outcome that protects a running manager.
  {
    const { instanceId, principal } = await buildResidue({ holderLive: true });
    const r = runCli(["reconcile-gate", "--space", space, "--server", SERVERS]);
    check("CLI (live holder): refuses `holder-alive` through the real rail", r.code === 2 && /refused \(holder-alive\)/.test(r.err),
      { code: r.code, err: r.err.slice(-600) });
    check("CLI (live holder): the refusal names the live principal and says what to do",
      r.err.includes(principal) && /Stop that process first/i.test(r.err), r.err.slice(-400));
    const kv2 = await execFor(instanceId);
    const still = parseEndpointGate((await kv2.get(epgateKey(ENDPOINT, instanceId)))!.value, epgateKey(ENDPOINT, instanceId));
    check("CLI (live holder): the gate is untouched — a running manager was not evicted", still.state === "frozen", still);
    const rows = await endpointRegistrationBarrier(kv2, space, { endpoint: ENDPOINT, instanceId, opId: mintLifecycleUid() }).enumerate();
    check("CLI (live holder): the credential family is untouched — the row is still active", rows.length === 1 && rows[0]?.state === "active", rows);
  }

  // ---- CELL 3: the holder is DEAD — the repair completes through the public path ---------------
  {
    const { instanceId, principal, conn } = await buildResidue({ holderLive: true });
    await conn!.close();
    await wait(500);
    const kv3 = await execFor(instanceId);
    const before = parseEndpointGate((await kv3.get(epgateKey(ENDPOINT, instanceId)))!.value, epgateKey(ENDPOINT, instanceId));
    const r = runCli(["reconcile-gate", "--space", space, "--server", SERVERS]);
    check("CLI (dead holder): SUCCEEDS — exit 0 and the reopen reported on stdout",
      r.code === 0 && /gate reopened at generation/.test(r.out), { code: r.code, out: r.out.slice(-500), err: r.err.slice(-800) });
    check("CLI (dead holder): the operator is told what happened — the holder it verified and the family it acted on",
      r.err.includes(principal) && /verified evicted/.test(r.err), r.err.slice(-800));
    const after = parseEndpointGate((await kv3.get(epgateKey(ENDPOINT, instanceId)))!.value, epgateKey(ENDPOINT, instanceId));
    check("CLI (dead holder): the KV proves it — gate OPEN at generation+1, coordinate otherwise UNCHANGED",
      after.state === "open" && after.op === undefined && after.generation === before.generation + 1 &&
      after.processEpoch === before.processEpoch && after.registrationRevision === before.registrationRevision &&
      after.nameAuthorityRevision === before.nameAuthorityRevision, { before, after });
    const rows = await endpointRegistrationBarrier(kv3, space, { endpoint: ENDPOINT, instanceId, opId: mintLifecycleUid() }).enumerate();
    check("CLI (dead holder): the credential family was revoked (deny-new committed, not just evicted)",
      rows.length === 1 && rows[0]?.state === "revoked", rows);
  }

  // ---- CELL 4: the command is idempotent-safe — a reopened gate refuses `not-frozen` -----------
  // An operator who re-runs it (a natural thing to do) must not be able to re-drive the repair.
  {
    const r = runCli(["reconcile-gate", "--space", space, "--server", SERVERS]);
    check("CLI (re-run): refuses `not-frozen` on the gate it just reopened — no second repair", r.code === 2 && /refused \(not-frozen\)/.test(r.err),
      { code: r.code, err: r.err.slice(-500) });
  }

  // ---- CELL 5: THE ORACLE MUST BE LOOKING AT THE RIGHT ACCOUNT --------------------------------
  // The cells above all run with the CLI and the daemon co-located on one correctly-seeded root —
  // the happy path, and therefore blind to the failure that matters here. The daemon's $SYS sweeps
  // resolve an ACCOUNT, and a COMPLETE, well-formed sweep of the WRONG account is indistinguishable
  // from "the principal is gone": a confident, healthy-looking answer that authorizes revoking and
  // evicting a live family. Found by adversarial review; these pin the two guards that close it.
  {
    const cwdBefore = process.cwd();
    try {
      process.chdir(ROOT); // so the root-drift guard is satisfied and the TENANCY guard is what speaks
      const foreignAccount = `A${"B".repeat(55)}`;
      let tenancyErr = "";
      try {
        await executePrincipalLiveness(SERVERS, { root: ROOT, expectedAccount: foreignAccount }, principalKey(DEV_OWNER, "whoever").key);
      } catch (e) { tenancyErr = (e as Error).message; }
      check("TENANCY: disk material naming a different account than the daemon authenticates as REFUSES (never a confident sweep of a foreign tenant)",
        /names account/.test(tenancyErr) && tenancyErr.includes(foreignAccount), tenancyErr);

      // The control: the correctly-seeded root does NOT refuse — the guard must reject the wrong
      // tenant, not every tenant.
      let okErr = "";
      try {
        await executePrincipalLiveness(SERVERS, { root: ROOT, expectedAccount: auth.account.pub }, principalKey(DEV_OWNER, "whoever").key);
      } catch (e) { okErr = (e as Error).message; }
      check("TENANCY control: the correctly-seeded root is accepted and answers (the guard rejects the wrong tenant, not all of them)", okErr === "", okErr);

      // And the root itself cannot drift between requests: resolving from a different cwd refuses
      // rather than silently reading another workspace's membership.json.
      process.chdir(cwdBefore);
      let driftErr = "";
      try {
        await executePrincipalLiveness(SERVERS, { root: ROOT, expectedAccount: auth.account.pub }, principalKey(DEV_OWNER, "whoever").key);
      } catch (e) { driftErr = (e as Error).message; }
      check("ROOT DRIFT: a request-time root different from the daemon's start root REFUSES (the scan account cannot follow process.cwd())",
        /is not the one this daemon started in/.test(driftErr), driftErr);
    } finally { process.chdir(cwdBefore); }
  }

  console.log(`\nGATE-RECONCILE CLI E2E ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ scenario threw:", (e as Error).stack ?? (e as Error).message);
  process.exitCode = 1;
} finally {
  for (const nc of [...holderConns, ...execConns]) { try { await nc?.close(); } catch { /* */ } }
  if (daemon) { daemon.kill("SIGKILL"); await awaitExit(daemon); } // exact PID — never pkill
  srv.kill("SIGKILL");
  await awaitExit(srv);
  rmSync(dir, { recursive: true, force: true });
  releaseBroker(); // last: ownership is held until this teardown has actually finished
}
process.exit(process.exitCode ?? 0);
