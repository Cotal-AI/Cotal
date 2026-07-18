/**
 * #29 piece 3 — the AUTH CONTROL RAIL smoke (SPEC 13.2 `CONTROL_AUTH_ADMIN`): the despawn→
 * retirement trigger's serve side, proven over a REAL JWT broker + the REAL authority plane.
 *
 * A. the requester credential's broker-enforced confinement: it can publish ONLY its own
 *    control subject (a foreign principal's subject is broker-denied), and only its own reply
 *    subtree is readable.
 * B. the GREEN path: the lease holder's request retires a live lifecycle end-to-end through the
 *    plane's own barrier + sealed scanner; a REPEAT request answers already-retired (idempotent,
 *    same stable opId).
 * C. the RAIL-TIME lease re-check (the four refusal faces in operator vocabulary): a NON-holder
 *    requester is refused with the lease-loss copy (FULL no-op stated, `cotal supervise` NEXT,
 *    and the target provably unchanged); an ABSENT lease refuses fail-closed; a STALE uid
 *    refuses naming the current incarnation; an UNBOUND reply target is dropped (no reply at
 *    all — the boundReply discipline). (A foreign-op-holds-the-gate refusal is exercised where
 *    gates are staged — the retirement-barrier suite; the rail branch is exact-code over the
 *    same observeGate read.)
 *
 * Run: pnpm smoke:auth-admin:auth   (needs nats-server on PATH)
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Kvm } from "@nats-io/kv";
import { jetstreamManager } from "@nats-io/jetstream";
import { connect, credsAuthenticator } from "@nats-io/transport-node";
import {
  CONTROL_AUTH_ADMIN, MANAGER_LEASE_KEY, MANAGER_LEASE_TTL_MS, controlServiceSubject,
  createEndpointStreams, createSpaceAuth, ensureAuthorityStores, isReachable, managerBucket,
  mintCreds, mintLifecycleUid, newIdentity, serverConfig, type EvictionResult,
} from "@cotal-ai/core";
import { deriveOwnerToken, openAuthAuthorityPlane } from "../src/index.js";
import { openAuthorityClient } from "../src/authority-client.js";
import { ensureRootCredential } from "../src/root-credential.js";
import { openLifecycleRegistry, readLifecycleHeadForOperation } from "../src/lifecycle-registry.js";
import type { EvictPrincipal } from "../src/credential-ledger.js";

const PORT = 20000 + Math.floor(Math.random() * 40000);
const SERVERS = `nats://127.0.0.1:${PORT}`;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, cond: boolean, extra?: unknown) => { if (cond) { pass++; console.log(`  ✓ ${name}`); } else { fail++; console.log(`  ✗ FAIL: ${name}`, extra ?? ""); } };

const space = `aadm-${randomUUID().slice(0, 8)}`;
const auth = await createSpaceAuth(space);
const tmp = mkdtempSync(join(tmpdir(), "cotal-aadm-"));
const dir = join(tmp, "state");
mkdirSync(dir, { recursive: true });
writeFileSync(join(tmp, "server.conf"), serverConfig(auth, { port: PORT, storeDir: join(tmp, "js") }));
const srv = spawn("nats-server", ["-c", join(tmp, "server.conf")], { stdio: "ignore" });
const awaitExit = (proc: ReturnType<typeof spawn>, timeoutMs = 3000): Promise<void> =>
  new Promise((resolve) => {
    if (proc.exitCode !== null || proc.signalCode !== null) return resolve();
    proc.once("exit", () => resolve());
    setTimeout(resolve, timeoutMs);
  });

const OWNER = deriveOwnerToken("s".repeat(32), "better-auth|human-1");
const dataAccount = { pub: auth.account.pub, signingSeed: auth.account.signingSeed };
const quiet = () => {};
const okEvictor: EvictPrincipal = async (principal) => ({ principal, kicked: 0, remaining: 0, verifiedGone: true, scanComplete: true } satisfies EvictionResult);
const MGR = { owner: "local", actor: "mgr0" };
const MGR_KEY = `${MGR.owner}.${MGR.actor}`;

/** One rail request over a FRESH requester credential (the real mint + real broker ACLs). */
async function request(requester: { owner: string; actor: string }, args: Record<string, unknown>, opts: { foreignReply?: boolean } = {}): Promise<{ ok: boolean; data?: Record<string, unknown>; error?: string } | "no-reply"> {
  const creds = await mintCreds(auth, newIdentity(), "retirement-requester", { retirementRequester: requester });
  const nc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), maxReconnectAttempts: 0 });
  try {
    const subject = controlServiceSubject(space, CONTROL_AUTH_ADMIN, requester.owner, requester.actor);
    const reply = opts.foreignReply ? `${controlServiceSubject(space, CONTROL_AUTH_ADMIN, "local", "other")}.reply.${randomUUID()}` : `${subject}.reply.${randomUUID()}`;
    const m = await nc.request(subject, JSON.stringify({ op: "retireLifecycle", args }), { timeout: 8000, noMux: true, reply });
    return m.json<{ ok: boolean; data?: Record<string, unknown>; error?: string }>();
  } catch (e) {
    if (/timeout|no responders/i.test((e as Error).message)) return "no-reply";
    throw e;
  } finally {
    await nc.close().catch(() => {});
  }
}

let plane: Awaited<ReturnType<typeof openAuthAuthorityPlane>> | undefined;
let wide: Awaited<ReturnType<typeof openAuthorityClient>> | undefined;
try {
  let up = false;
  for (let i = 0; i < 50; i++) { if (await isReachable(SERVERS)) { up = true; break; } await wait(200); }
  if (!up) throw new Error(`nats-server did not come up on ${PORT}`);

  wide = await openAuthorityClient({ server: SERVERS, space, dataAccount, label: `harness:${space}`, grants: (id) => (void id, { publish: [">"], subscribe: [`_INBOX_${id}.>`] }), log: quiet });
  const jsm = await jetstreamManager(wide.nc);
  const kvm = new Kvm(wide.nc);
  await ensureAuthorityStores(jsm, kvm, space);
  await createEndpointStreams(jsm, kvm, space);
  const mgrKv = await kvm.create(managerBucket(space), { ttl: MANAGER_LEASE_TTL_MS });
  const putLease = async (holder: string) => {
    await mgrKv.put(MANAGER_LEASE_KEY, new TextEncoder().encode(JSON.stringify({ holder, runtime: "pty", root: "/x", pid: 1, since: Date.now() })));
  };
  await putLease(MGR_KEY);

  // The REAL plane serves the rail.
  plane = await openAuthAuthorityPlane({ server: SERVERS, space, dir, dataAccount, log: quiet, probeEvictor: okEvictor });
  const wreg = await openLifecycleRegistry(wide.nc, space);

  console.log("A. requester-credential confinement (broker ACLs)");
  {
    const creds = await mintCreds(auth, newIdentity(), "retirement-requester", { retirementRequester: MGR });
    const nc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), maxReconnectAttempts: 0 });
    try {
      const foreign = controlServiceSubject(space, CONTROL_AUTH_ADMIN, "local", "other");
      let deniedForeign = false;
      try {
        await nc.request(foreign, JSON.stringify({ op: "retireLifecycle", args: {} }), { timeout: 1500, noMux: true, reply: `${foreign}.reply.${randomUUID()}` });
      } catch { deniedForeign = true; }
      check("the requester credential CANNOT reach a FOREIGN principal's control subject (attribution is the broker ACL)", deniedForeign);
    } finally {
      await nc.close().catch(() => {});
    }
  }

  console.log("B. the green path (lease holder retires a live lifecycle; repeat = idempotent)");
  const uid1 = mintLifecycleUid();
  await ensureRootCredential(wreg, { owner: OWNER, actor: "w1", lifecycleUid: uid1, managerInstance: "smoke" });
  const op1 = "a".repeat(26);
  const r1 = await request(MGR, { owner: OWNER, actor: "w1", lifecycleUid: uid1, opId: op1 });
  check("the lease holder's request RETIRES the lifecycle end-to-end (the plane's own barrier + sealed scanner)",
    r1 !== "no-reply" && r1.ok === true && (r1.data as { retired?: boolean })?.retired === true, r1);
  check("the head reads retired after the rail request",
    (await readLifecycleHeadForOperation(wreg, OWNER, "w1"))?.mapping.state === "retired");
  const r1b = await request(MGR, { owner: OWNER, actor: "w1", lifecycleUid: uid1, opId: op1 });
  check("a REPEAT request answers already-retired (idempotent under the stable opId)",
    r1b !== "no-reply" && r1b.ok === true && (r1b.data as { alreadyRetired?: boolean })?.alreadyRetired === true, r1b);

  console.log("C. the refusal faces (rail-time lease re-check + closed shapes)");
  const uid2 = mintLifecycleUid();
  await ensureRootCredential(wreg, { owner: OWNER, actor: "w2", lifecycleUid: uid2, managerInstance: "smoke" });
  const op2 = "b".repeat(26);
  // Non-holder: the lease moved to another manager AFTER the requester was minted.
  await putLease("local.other");
  const r2 = await request(MGR, { owner: OWNER, actor: "w2", lifecycleUid: uid2, opId: op2 });
  check("a requester that LOST the lease is refused with the lease-loss operator copy (names the holder + FULL no-op + cotal supervise)",
    r2 !== "no-reply" && r2.ok === false && (r2.error ?? "").includes("lost the space lease") && (r2.error ?? "").includes("FULL no-op") && (r2.error ?? "").includes("cotal supervise"), r2);
  check("the refused target is provably UNCHANGED (the full-no-op statement is true)",
    (await readLifecycleHeadForOperation(wreg, OWNER, "w2"))?.mapping.state === "active");
  // Absent lease (TTL-expired / no manager): fail-closed.
  await mgrKv.delete(MANAGER_LEASE_KEY);
  const r3 = await request(MGR, { owner: OWNER, actor: "w2", lifecycleUid: uid2, opId: op2 });
  check("an ABSENT lease refuses fail-closed (no manager holds the space; supervise NEXT)",
    r3 !== "no-reply" && r3.ok === false && (r3.error ?? "").includes("no manager currently holds") && (r3.error ?? "").includes("cotal supervise"), r3);
  await putLease(MGR_KEY);
  // Stale uid: the trigger names a previous incarnation.
  const r4 = await request(MGR, { owner: OWNER, actor: "w2", lifecycleUid: mintLifecycleUid(), opId: op2 });
  check("a STALE incarnation refuses naming the current one (never retires the wrong lifecycle)",
    r4 !== "no-reply" && r4.ok === false && (r4.error ?? "").includes("stale incarnation") && (r4.error ?? "").includes(uid2), r4);
  // Unbound reply: the listener DROPS the request BEFORE any processing (the boundReply
  // discipline). Proven by consequence: a VALID retire request published with a foreign reply
  // target must leave the target lifecycle UNTOUCHED (had it been processed, w2 would retire).
  {
    const creds = await mintCreds(auth, newIdentity(), "retirement-requester", { retirementRequester: MGR });
    const nc = await connect({ servers: SERVERS, authenticator: credsAuthenticator(new TextEncoder().encode(creds)), maxReconnectAttempts: 0 });
    try {
      const subject = controlServiceSubject(space, CONTROL_AUTH_ADMIN, MGR.owner, MGR.actor);
      nc.publish(subject, new TextEncoder().encode(JSON.stringify({ op: "retireLifecycle", args: { owner: OWNER, actor: "w2", lifecycleUid: uid2, opId: op2 } })), { reply: `${controlServiceSubject(space, CONTROL_AUTH_ADMIN, "local", "other")}.reply.x` });
      await nc.flush();
      await wait(1200);
    } finally {
      await nc.close().catch(() => {});
    }
    check("an UNBOUND reply target is DROPPED before processing (a valid retire request left the target untouched)",
      (await readLifecycleHeadForOperation(wreg, OWNER, "w2"))?.mapping.state === "active");
  }
  // And the target is still intact after every refusal above.
  check("after every refusal face the target lifecycle is STILL active (refusals are complete no-ops)",
    (await readLifecycleHeadForOperation(wreg, OWNER, "w2"))?.mapping.state === "active");

  console.log(`\nAUTH-ADMIN SMOKE ${fail === 0 ? "OK ✅" : "FAILED ❌"}  (${pass} passed, ${fail} failed)`);
  if (fail) process.exitCode = 1;
} catch (e) {
  fail++;
  console.error("  ✗ smoke crashed:", e instanceof Error ? (e.stack ?? e.message) : e);
  process.exitCode = 1;
} finally {
  await plane?.close().catch(() => {});
  await wide?.close().catch(() => {});
  srv.kill("SIGTERM"); // exact PID — never pkill nats-server
  await awaitExit(srv);
  rmSync(tmp, { recursive: true, force: true });
}
process.exit(process.exitCode ?? 0);
